import * as playbookService from "../services/playbookService.js";

/**
 * 手順書（Playbook）を新しく登録・保存するツール関数
 */
export async function savePlaybook(
  userId: string,
  args: {
    name: string;
    title: string;
    keywords: string[];
    description: string;
    steps: string;
  }
): Promise<string> {
  try {
    const res = await playbookService.savePlaybook(
      args.name,
      args.title,
      args.keywords,
      args.description,
      args.steps
    );
    return JSON.stringify(res);
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}

/**
 * 関連する手順書（Playbook）を検索・取得するツール関数
 */
export async function findPlaybooks(
  userId: string,
  args: { query?: string }
): Promise<string> {
  try {
    const playbooks = await playbookService.findPlaybooks(args.query);
    return JSON.stringify({
      success: true,
      query: args.query || null,
      results: playbooks,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}
