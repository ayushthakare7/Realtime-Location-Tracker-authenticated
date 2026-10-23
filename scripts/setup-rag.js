require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const LocationEvent = require("../src/models/LocationEvent");
const { indexEvent } = require("../src/services/locationEvents.service");
const { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } = require("../src/services/embedding.service");
const { VECTOR_INDEX } = require("../src/services/locationRag.service");

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  const collectionName = LocationEvent.collection.collectionName;

  let indexes = [];
  try {
    const result = await db.command({ listSearchIndexes: collectionName });
    indexes = result.cursor?.firstBatch || [];
  } catch (error) {
    console.log("Could not list existing vector indexes. Attempting creation.");
  }

  const existing = indexes.find(index => index.name === VECTOR_INDEX);
  if (!existing) {
    await db.command({
      createSearchIndexes: collectionName,
      indexes: [{
        name: VECTOR_INDEX,
        type: "vectorSearch",
        definition: {
          fields: [
            { type: "vector", path: "embedding", numDimensions: EMBEDDING_DIMENSIONS, similarity: "cosine" },
            { type: "filter", path: "userId" },
            { type: "filter", path: "recordedAt" }
          ]
        }
      }]
    });
    console.log(`Created vector index '${VECTOR_INDEX}' with ${EMBEDDING_DIMENSIONS} dimensions.`);
  } else {
    console.log(`Vector index '${VECTOR_INDEX}' already exists.`);
  }

  const events = await LocationEvent.find({ eventType: { $in: ["arrival", "stay", "departure"] } }).select("+embedding").lean();
  let count = 0;
  for (const event of events) {
    await indexEvent(event);
    count += 1;
    if (count % 25 === 0 || count === events.length) {
      console.log(`Re-embedded ${count}/${events.length} events using ${EMBEDDING_MODEL}.`);
    }
  }

  console.log(`RAG setup complete. Processed ${count} location events with ${EMBEDDING_MODEL}.`);
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error("RAG setup failed:", error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
