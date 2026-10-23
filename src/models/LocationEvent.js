const mongoose = require("mongoose");

const locationEventSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  username: { type: String, required: true },
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  recordedAt: { type: Date, default: Date.now, index: true }
}, { timestamps: false });

locationEventSchema.index({ userId: 1, recordedAt: -1 });
module.exports = mongoose.model("LocationEvent", locationEventSchema);
