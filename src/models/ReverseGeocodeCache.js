const mongoose = require("mongoose");

const reverseGeocodeCacheSchema = new mongoose.Schema({
  cacheKey: { type: String, required: true, unique: true, index: true },
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  placeName: { type: String, required: true },
  road: { type: String, default: null },
  locality: { type: String, default: null },
  city: { type: String, default: null },
  state: { type: String, default: null },
  country: { type: String, default: null },
  countryCode: { type: String, default: null },
  fetchedAt: { type: Date, default: Date.now, index: { expires: 2592000 } }
}, { timestamps: true });

module.exports = mongoose.model("ReverseGeocodeCache", reverseGeocodeCacheSchema);
