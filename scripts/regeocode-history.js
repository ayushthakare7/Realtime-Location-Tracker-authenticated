require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const LocationVisit = require("../src/models/LocationVisit");
const LocationEvent = require("../src/models/LocationEvent");
const { placeLabel, indexEvent } = require("../src/services/locationEvents.service");

function isFallbackPlace(place) { return !place || /^Location near -?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/i.test(String(place).trim()); }

async function main() {
  await connectDB();
  const visits = await LocationVisit.find({ $or: [{ placeName: { $regex: /^Location near /i } }, { placeName: { $exists: false } }] }).lean();
  let updated = 0;
  for (const visit of visits) {
    const place = await placeLabel(visit.latitude, visit.longitude);
    if (!isFallbackPlace(place)) {
      await LocationVisit.updateOne({ _id: visit._id }, { $set: { placeName: place } });
      const events = await LocationEvent.find({ userId: visit.userId, latitude: visit.latitude, longitude: visit.longitude, startAt: { $gte: visit.startedAt } }).select("+embedding");
      for (const event of events) {
        event.placeName = place;
        await event.save();
        await indexEvent(event.toObject());
      }
      updated += 1;
      console.log(`Updated ${visit.username}: ${place}`);
    }
  }
  console.log(`Re-geocoding complete. Updated ${updated} visits.`);
  await mongoose.disconnect();
}

main().catch(async error => { console.error("Re-geocoding failed:", error.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
