require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const LocationEvent = require("../src/models/LocationEvent");
const LocationPoint = require("../src/models/LocationPoint");

async function migrate() {
  await connectDB();
  const legacy = await LocationEvent.collection.find({
    eventType: { $exists: false },
    eventKey: { $exists: false },
    userId: { $exists: true },
    latitude: { $type: "number" },
    longitude: { $type: "number" }
  }).toArray();

  let moved = 0;
  for (const old of legacy) {
    const point = {
      _id: old._id,
      userId: old.userId,
      username: old.username || "Unknown",
      latitude: old.latitude,
      longitude: old.longitude,
      recordedAt: old.recordedAt || old.lastSeen || old.createdAt || new Date()
    };
    await LocationPoint.updateOne({ _id: point._id }, { $setOnInsert: point }, { upsert: true });
    await LocationEvent.collection.deleteOne({ _id: old._id, eventType: { $exists: false } });
    moved += 1;
  }
  console.log(`Migrated ${moved} legacy GPS points into LocationPoint. Semantic event records were preserved.`);
}

migrate()
  .catch(error => { console.error("Location history migration failed:", error.message); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect(); });
