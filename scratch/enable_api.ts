import { google } from "googleapis";
import { config } from "../src/config.js";

async function main() {
  console.log("--- Trying to enable Secret Manager API via Service Usage ---");
  try {
    const auth = new google.auth.JWT(
      config.googleServiceAccountEmail,
      undefined,
      config.googlePrivateKey,
      [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/service.management"
      ]
    );

    const serviceusage = google.serviceusage({
      version: "v1",
      auth,
    });

    const projectId = "yuuka-497605";
    console.log("Enabling secretmanager.googleapis.com...");
    const res = await serviceusage.operations.get({
      name: `projects/${projectId}/services/secretmanager.googleapis.com`,
    });
    console.log("Service status:", res.data);

    // Try to enable
    const enableRes = await serviceusage.services.enable({
      name: `projects/${projectId}/services/secretmanager.googleapis.com`,
    });
    console.log("Enable response:", enableRes.data);
  } catch (error: any) {
    console.error("Failed to enable API:", error.message || error);
  }
}

main();
