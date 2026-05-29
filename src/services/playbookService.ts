import fs from "node:fs";
import path from "node:path";

const PLAYBOOK_DIR = path.resolve(process.cwd(), "data/playbooks");

// プレイブック保存用ディレクトリの確保
if (!fs.existsSync(PLAYBOOK_DIR)) {
  fs.mkdirSync(PLAYBOOK_DIR, { recursive: true });
}

export interface Playbook {
  name: string;
  title: string;
  keywords: string[];
  description: string;
  steps: string;
}

/**
 * 手順書（Playbook）をMarkdownとして保存する
 */
export async function savePlaybook(
  name: string,
  title: string,
  keywords: string[],
  description: string,
  steps: string
): Promise<{ success: boolean; message: string; path: string }> {
  // 安全なファイル名にするためのクレンジング (英数字、ハイフン、アンダースコアのみ)
  const safeName = name.replace(/[^a-zA-Z0-9\-_]/g, "_").toLowerCase() + ".md";
  const filePath = path.join(PLAYBOOK_DIR, safeName);

  // Markdownのフロントマターを組み立てる
  const frontmatter = [
    "---",
    `title: ${title}`,
    `keywords: [${keywords.join(", ")}]`,
    `description: ${description}`,
    "---",
    "",
    steps
  ].join("\n");

  fs.writeFileSync(filePath, frontmatter, "utf-8");

  return {
    success: true,
    message: `手順書「${title}」を ${safeName} として正常に保存しました。`,
    path: path.relative(process.cwd(), filePath),
  };
}

/**
 * キーワードや部分一致で手順書（Playbook）を検索し、その中身を返す
 */
export async function findPlaybooks(query?: string): Promise<Playbook[]> {
  if (!fs.existsSync(PLAYBOOK_DIR)) {
    return [];
  }

  const files = fs.readdirSync(PLAYBOOK_DIR).filter(file => file.endsWith(".md"));
  const playbooks: Playbook[] = [];

  for (const file of files) {
    const filePath = path.join(PLAYBOOK_DIR, file);
    const content = fs.readFileSync(filePath, "utf-8");

    // フロントマターの簡易パース
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) continue;

    const yamlStr = frontmatterMatch[1];
    const steps = content.substring(frontmatterMatch[0].length).trim();

    let title = "無題の手順書";
    let keywords: string[] = [];
    let description = "";

    const lines = yamlStr.split("\n");
    for (const line of lines) {
      const parts = line.split(":");
      if (parts.length < 2) continue;
      const key = parts[0].trim().toLowerCase();
      const val = parts.slice(1).join(":").trim();

      if (key === "title") {
        title = val;
      } else if (key === "keywords") {
        // [keyword1, keyword2] のパース
        const cleanVal = val.replace(/[\[\]]/g, "");
        keywords = cleanVal.split(",").map(k => k.trim()).filter(Boolean);
      } else if (key === "description") {
        description = val;
      }
    }

    const name = path.basename(file, ".md");

    // 検索クエリがある場合、フィルタリングを行う
    if (query) {
      const lowerQuery = query.toLowerCase();
      const matchTitle = title.toLowerCase().includes(lowerQuery);
      const matchKeywords = keywords.some(k => k.toLowerCase().includes(lowerQuery));
      const matchDesc = description.toLowerCase().includes(lowerQuery);
      const matchSteps = steps.toLowerCase().includes(lowerQuery);

      if (!matchTitle && !matchKeywords && !matchDesc && !matchSteps) {
        continue;
      }
    }

    playbooks.push({
      name,
      title,
      keywords,
      description,
      steps
    });
  }

  return playbooks;
}
