import * as browserService from "../src/services/browserService.js";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const url = "https://weather.yahoo.co.jp/weather/jp/13/4410/13229.html";
  console.log(`Fetching ${url}...`);
  try {
    const { title, markdown } = await browserService.fetchCleanPageContent(url);
    console.log("Title extracted:", title);
    
    const outputDir = path.resolve(process.cwd(), "data/debug_scrapes");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const outputPath = path.join(outputDir, "debug_last_fetch.md");
    fs.writeFileSync(outputPath, markdown, "utf8");
    console.log(`Saved output to ${outputPath}`);
    console.log("First 500 characters of Markdown:\n");
    console.log(markdown.slice(0, 500));
  } catch (e: any) {
    console.error("Scrape test failed:", e);
  }
}

main();
