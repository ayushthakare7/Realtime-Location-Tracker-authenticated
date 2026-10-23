const mongoose = require("mongoose");

const locationVisitSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  username: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  placeName: { type: String, required: true },
  startedAt: { type: Date, required: true },
  lastSeen: { type: Date, required: true },
  pointCount: { type: Number, default: 1 }
}, { timestamps: true });

module.exports = mongoose.model("LocationVisit", locationVisitSchema);
