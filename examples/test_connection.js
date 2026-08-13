import { bitrix24 } from "../dist/bitrix24.js";
import dotenv from "dotenv";
import { resolve } from "path";

// Load .env file from the root directory
dotenv.config({ path: resolve(__dirname, "../.env") });

async function main() {
  // In a real usage, the token is passed by the client or managed by the server session.
  // For this local test, you need to paste an active OAuth token here, or rely on a webhook if adapted.
  const token = "YOUR_ACTIVE_OAUTH_TOKEN"; 
  
  if (token === "YOUR_ACTIVE_OAUTH_TOKEN") {
    console.error("Please provide a valid token in examples/test_connection.js to run this test.");
    return;
  }

  try {
    console.log("Fetching current user info...");
    const user = await bitrix24.getCurrentUser(token);
    console.log("Current User:", user);

    console.log("\nFetching Knowledge Bases...");
    const kbs = await bitrix24.listKnowledgeBases(token);
    console.log("Knowledge Bases:", kbs);
  } catch (error) {
    console.error("Test failed:", error);
  }
}

main();
