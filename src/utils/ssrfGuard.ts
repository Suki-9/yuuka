import dns from "node:dns/promises";
import net from "node:net";

// ─── SSRF 防御（サーバー側からの外向きリクエストの宛先検証） ──────────────────
//
// ユーザー（チャット／Web）が指定したURL（MCPエンドポイント・RSSフィード・ブラウザ取得・
// Webhook 等）へサーバーが接続する前に、宛先がプライベート/ループバック/リンクローカル/
// メタデータ等の内部レンジでないことを検証する。スキームは http/https のみ許可し、
// ホスト名は実際にDNS解決して全Aレコードを検査する（DNSリバインディング対策として
// 利用直前に再検証することが望ましい）。

/** プライベート/予約済みと判定された宿主への接続は拒否する */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

/**
 * 1つのIPアドレス（v4/v6文字列）が内部・予約レンジに属するかを判定する。
 * 属する場合 true（＝ブロック対象）。
 */
export function isBlockedIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return isBlockedIpv4(ip);
  if (type === 6) return isBlockedIpv6(ip);
  return true; // 解釈不能なものは安全側でブロック
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local（クラウドメタデータ含む）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && parts[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) は内側のv4で判定する
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (lower.startsWith("fe80") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique-local
  if (lower.startsWith("fec") || lower.startsWith("fed") || lower.startsWith("fee") || lower.startsWith("fef")) return true; // fec0::/10 site-local (deprecated)
  if (lower.startsWith("ff")) return true; // ff00::/8 multicast
  if (lower.startsWith("2001:db8")) return true; // documentation
  if (lower.startsWith("::ffff:")) return true; // 解釈できない mapped はブロック
  return false;
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * DNS解決を伴わない同期的な簡易チェック。
 * スキームが http/https で、認証情報を含まず、ホストが localhost や
 * 内部IPリテラルでないことのみを確認する（同期コンテキスト・即時バリデーション用）。
 * 取得直前には必ず assertSafeOutboundUrl による厳密検証（DNS解決込み）を併用すること。
 */
export function isLikelyPublicHttpUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
  if (net.isIP(host) && isBlockedIp(host)) return false;
  return true;
}

export interface SafeUrlOptions {
  /** http を許可するか（既定: true。https のみに絞りたい場合は false） */
  allowHttp?: boolean;
}

/**
 * 外向きリクエスト先として安全なURLかを検証し、正規化したURLオブジェクトを返す。
 * - スキームは http/https のみ（既定）
 * - URL内の認証情報（user:pass@）は禁止
 * - ホスト名をDNS解決し、いずれかのアドレスが内部レンジならブロック
 * 検証に失敗した場合は BlockedUrlError を throw する。
 *
 * 注意: TOCTOU/DNSリバインディング完全対策には、実際に接続したIPの再検証が必要。
 * 本関数は「登録時」「利用直前」双方で呼ぶことで実用上のリスクを大きく下げる。
 */
export async function assertSafeOutboundUrl(rawUrl: string, opts: SafeUrlOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError("URLの形式が不正です。");
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new BlockedUrlError(`許可されていないスキームです: ${url.protocol}（http/https のみ）`);
  }
  if (opts.allowHttp === false && url.protocol !== "https:") {
    throw new BlockedUrlError("https のURLのみ許可されています。");
  }
  if (url.username || url.password) {
    throw new BlockedUrlError("URLに認証情報（user:pass@）を含めることはできません。");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // IPv6 ブラケット除去
  if (!hostname || hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost")) {
    throw new BlockedUrlError("ローカルホストへの接続は許可されていません。");
  }

  // ホストがIPリテラルならそのまま検査、ホスト名ならDNS解決して全アドレスを検査
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new BlockedUrlError(`内部/予約済みアドレスへの接続は許可されていません: ${hostname}`);
    }
    return url;
  }

  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new BlockedUrlError(`ホスト名を解決できませんでした: ${hostname}`);
  }
  if (addrs.length === 0) {
    throw new BlockedUrlError(`ホスト名を解決できませんでした: ${hostname}`);
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new BlockedUrlError(`内部/予約済みアドレスに解決されるホストへの接続は許可されていません: ${hostname} -> ${a.address}`);
    }
  }
  return url;
}

/** throw せず boolean を返すラッパ（任意用途） */
export async function isSafeOutboundUrl(rawUrl: string, opts: SafeUrlOptions = {}): Promise<boolean> {
  try {
    await assertSafeOutboundUrl(rawUrl, opts);
    return true;
  } catch {
    return false;
  }
}
