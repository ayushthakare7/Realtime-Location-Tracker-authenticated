const mongoose = require("mongoose");

const locationEventSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  username: { type: String, required: true },
  eventType: { type: String, enum: ["arrival", "stay", "departure"], required: true, index: true },
  placeName: { type: String, required: true },
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  recordedAt: { type: Date, default: Date.now, index: true },
  durationMinutes: { type: Number, min: 0 },
  summary: { type: String, required: true },
  eventKey: { type: String, required: true },
  embedding: { type: [Number], select: false },
  embeddingModel: { type: String, select: false },
  embeddingUpdatedAt: { type: Date, select: false }
}, { timestamps: true });

locationEventSchema.index({ userId: 1, recordedAt: -1 });
locationEventSchema.index({ eventKey: 1 }, { unique: true, partialFilterExpression: { eventKey: { $type: "string" } } });
module.exports = mongoose.model("LocationEvent", locationEventSchema);
