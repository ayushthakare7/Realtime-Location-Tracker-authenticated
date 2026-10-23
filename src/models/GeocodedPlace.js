const mongoose = require("mongoose");

const geocodedPlaceSchema = new mongoose.Schema({
  normalizedQuery: { type: String, required: true, unique: true, index: true },
  query: { type: String, required: true },
  name: { type: String, required: true },
  state: { type: String, default: null },
  country: { type: String, default: "India" },
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  provider: { type: String, default: "nominatim" },
  providerPlaceId: { type: String, default: null },
  fetchedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model("GeocodedPlace", geocodedPlaceSchema);
