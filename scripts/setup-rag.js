require("dotenv").config();
const { reindexLocationEvents } = require("../src/services/ragClient.service");

async function main() {
  console.log("Requesting vector-index setup and event embedding from the Python RAG service...");
  const result = await reindexLocationEvents();
  console.log(`RAG setup complete. Vector index: ${result.vectorIndex || "requested"}. Indexed events: ${result.indexedEvents ?? "unknown"}.`);
}

main().catch(error => {
  console.error("RAG setup failed:", error.message);
  process.exit(1);
});
