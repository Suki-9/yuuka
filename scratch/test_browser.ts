import * as browserService from "../src/services/browserService.js";

async function main() {
  console.log("--- Testing Web Search ---");
  try {
    const results = await browserService.searchWeb("ブルーアーカイブ");
    console.log("Search Results (Top 2):");
    console.log(JSON.stringify(results.slice(0, 2), null, 2));
  } catch (e: any) {
    console.error("Search failed:", e);
  }

  console.log("\n--- Testing Web Fetch ---");
  try {
    const { title, markdown } = await browserService.fetchCleanPageContent("https://example.com");
    console.log("Page Title:", title);
    console.log("Page Content Preview (First 200 chars):");
    console.log(markdown.slice(0, 200));
  } catch (e: any) {
    console.error("Fetch failed:", e);
  }
}

main();
