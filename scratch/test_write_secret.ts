import { google } from "googleapis";
import { config } from "../src/config.js";

async function main() {
  console.log("--- Testing Secret Manager Read/Write ---");
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

    const projectId = "yuuka-497605";
    const testSecretId = "yuuka-test-secret";

    // 1. Create secret if not exists
    try {
      console.log("Creating secret...");
      await secretmanager.projects.secrets.create({
        parent: `projects/${projectId}`,
        secretId: testSecretId,
        requestBody: {
          replication: {
            automatic: {},
          },
        },
      });
      console.log("Secret created successfully.");
    } catch (e: any) {
      if (e.status === 409) {
        console.log("Secret already exists, skipping creation.");
      } else {
        throw e;
      }
    }

    // 2. Add secret version (write payload)
    const payload = JSON.stringify({ username: "testuser", password: "testpassword" });
    const payloadBase64 = Buffer.from(payload).toString("base64");
    console.log("Adding secret version...");
    const versionRes = await secretmanager.projects.secrets.addVersion({
      parent: `projects/${projectId}/secrets/${testSecretId}`,
      requestBody: {
        payload: {
          data: payloadBase64,
        },
      },
    });
    console.log("Added version:", versionRes.data.name);

    // 3. Access secret version (read payload)
    console.log("Accessing latest version...");
    const accessRes = await secretmanager.projects.secrets.versions.access({
      name: `projects/${projectId}/secrets/${testSecretId}/versions/latest`,
    });
    const retrievedBase64 = accessRes.data.payload?.data;
    if (retrievedBase64) {
      const retrieved = Buffer.from(retrievedBase64, "base64").toString("utf-8");
      console.log("Retrieved secret content:", retrieved);
    } else {
      console.log("No payload found!");
    }

    // 4. Delete secret
    console.log("Deleting secret...");
    await secretmanager.projects.secrets.delete({
      name: `projects/${projectId}/secrets/${testSecretId}`,
    });
    console.log("Deleted secret successfully.");

  } catch (error: any) {
    console.error("Error in Secret Manager test:", error.message || error);
  }
}

main();
