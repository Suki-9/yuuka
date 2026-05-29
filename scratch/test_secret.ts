import { google } from "googleapis";
import { config } from "../src/config.js";

async function main() {
  console.log("--- Testing Secret Manager Integration ---");
  try {
    const auth = new google.auth.JWT(
      config.googleServiceAccountEmail,
      undefined,
      config.googlePrivateKey,
      ["https://www.googleapis.com/auth/cloud-platform"]
    );

    const secretmanager = google.secretmanager({
      version: "v1",
      auth,
    });

    const projectId = "yuuka-497605"; // extracted from service account email

    // List secrets
    console.log(`Listing secrets in project: ${projectId}...`);
    const res = await secretmanager.projects.secrets.list({
      parent: `projects/${projectId}`,
    });

    console.log("Secrets list response:", JSON.stringify(res.data, null, 2));
  } catch (error: any) {
    console.error("Error connecting to Secret Manager:", error.message || error);
  }
}

main();
