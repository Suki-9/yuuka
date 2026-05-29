import { runMigrations } from "../src/db/migrations.js";
import * as secretService from "../src/services/secretService.js";

async function main() {
  console.log("--- 🕵️ 資格情報マネージャー自動テスト開始 ---");

  try {
    // 1. マイグレーションの実行
    console.log("1. データベースマイグレーションの実行...");
    runMigrations();
    console.log("   マイグレーション完了");

    // 2. 資格情報の登録
    const testService = "millennium-portal-test";
    const testUser = "sensei_test";
    const testPass = "super-secret-password-123!#";

    console.log(`2. 資格情報の登録テスト (サービス: ${testService})...`);
    secretService.registerCredential(testService, testUser, testPass);
    console.log("   登録完了");

    // 3. 資格情報一覧の取得（インデックス確認）
    console.log("3. インデックス一覧の取得確認...");
    const list = secretService.listCredentials();
    console.log("   取得件数:", list.length);
    console.log("   一覧データ:", JSON.stringify(list, null, 2));

    const found = list.find((item) => item.serviceName === testService);
    if (!found) {
      throw new Error(`エラー: 一覧にサービス ${testService} が見つかりません！`);
    }
    if ((found as any).password || (found as any).encrypted_password) {
      throw new Error("❌ セキュリティ警告: パスワード情報が一覧に含まれてしまっています！");
    }
    console.log("   インデックス一覧の安全性検証パス（パスワードが露出していません）");

    // 4. パスワード復号の確認
    console.log("4. パスワードのオンデマンド復号テスト...");
    const decrypted = secretService.getDecryptedCredential(testService);
    if (!decrypted) {
      throw new Error("エラー: 資格情報の取得に失敗しました。");
    }

    console.log("   復号されたユーザー名:", decrypted.username);
    console.log("   復号されたパスワード:", decrypted.password);

    if (decrypted.username !== testUser) {
      throw new Error(`エラー: ユーザー名が一致しません。期待: ${testUser}, 実際: ${decrypted.username}`);
    }
    if (decrypted.password !== testPass) {
      throw new Error(`エラー: パスワードが一致しません。期待: ${testPass}, 実際: ${decrypted.password}`);
    }
    console.log("   パスワードの正確な復号検証パス");

    // 5. 資格情報の削除
    console.log("5. 資格情報の削除テスト...");
    const deleted = secretService.deleteCredential(testService);
    if (!deleted) {
      throw new Error("エラー: 資格情報の削除処理が正常終了しませんでした。");
    }

    const checkAfterDelete = secretService.getDecryptedCredential(testService);
    if (checkAfterDelete !== null) {
      throw new Error("エラー: 削除したはずの資格情報がまだ取得できてしまいます。");
    }
    console.log("   資格情報の完全削除検証パス");

    console.log("\n🎉 すべての資格情報テストが正常にクリアされました！");
  } catch (error: any) {
    console.error("\n❌ テスト中にエラーが発生しました:", error.message || error);
    process.exit(1);
  }
}

main();
