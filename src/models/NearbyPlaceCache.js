const mongoose = require("mongoose");

const nearbyPlaceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  normalizedName: { type: String, required: true, index: true },
  category: { type: String, default: "landmark" },
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  source: { type: String, default: "OpenStreetMap" }
}, { _id: false });

const nearbyPlaceCacheSchema = new mongoose.Schema({
  cacheKey: { type: String, required: true, unique: true, index: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  radiusMeters: { type: Number, required: true },
  places: { type: [nearbyPlaceSchema], default: [] },
  fetchedAt: { type: Date, default: Date.now, index: { expires: 21600 } }
}, { timestamps: true });

module.exports = mongoose.model("NearbyPlaceCache", nearbyPlaceCacheSchema);
