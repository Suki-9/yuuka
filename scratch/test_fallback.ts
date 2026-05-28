import * as browserService from "../src/services/browserService.js";

async function main() {
  console.log("--- Testing Fallback on Fake Domain ---");
  try {
    console.log("Triggering fetch on non-existent domain...");
    const result = await browserService.fetchCleanPageContent("https://this-is-a-fake-domain-that-does-not-exist-12345.com");
    console.log("Result (unexpected success):", result);
  } catch (e: any) {
    console.log("\n[SUCCESS] Expected fallback behavior observed!");
    console.log("Final captured error:", e.message);
  }
}

main();
