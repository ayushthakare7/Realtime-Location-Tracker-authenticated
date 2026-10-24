const mongoose = require("mongoose");

const pointSchema = new mongoose.Schema({
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  label: { type: String, trim: true, maxlength: 200, default: null }
}, { _id: false });

const eventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, trim: true, maxlength: 128 },
  type: { type: String, required: true, enum: ["location", "check_in", "arrival", "offline", "online", "emergency", "cancelled"] },
  recordedAt: { type: Date, required: true },
  receivedAt: { type: Date, required: true, default: Date.now },
  latitude: { type: Number, min: -90, max: 90, default: null },
  longitude: { type: Number, min: -180, max: 180, default: null },
  accuracyMeters: { type: Number, min: 0, default: null },
  note: { type: String, trim: true, maxlength: 500, default: null }
}, { _id: false });

const routeSchema = new mongoose.Schema({\n  provider: { type: String, default: null },\n  distanceMeters: { type: Number, min: 0, default: null },\n  durationSeconds: { type: Number, min: 0, default: null },\n  encodedPolyline: { type: String, maxlength: 200000, default: null },\n  routeLabels: { type: [String], default: [] },\n  approvedAt: { type: Date, default: null }\n}, { _id: false });\n\nconst journeySchema = new mongoose.Schema({
  travellerId: { type: String, required: true, index: true },
  travellerUsername: { type: String, trim: true, maxlength: 80, default: null },
  status: { type: String, enum: ["DRAFT", "ACTIVE", "OVERDUE_UNCONFIRMED", "ALERT_SENT", "EMERGENCY_ALERTED", "ARRIVED", "CANCELLED"], default: "DRAFT", index: true },
  origin: { type: pointSchema, required: true },
  destination: { type: pointSchema, required: true },
  transportModeId: { type: String, required: true, trim: true, maxlength: 64 },
  avatarKey: { type: String, required: true, trim: true, maxlength: 64 },
  expectedArrivalAt: { type: Date, default: null, index: true },\n  route: { type: routeSchema, default: null },
  sharingEnabled: { type: Boolean, default: false },
  sharedWith: { type: [String], default: [] },
  lastConfirmedLocation: {
    latitude: { type: Number, min: -90, max: 90, default: null },
    longitude: { type: Number, min: -180, max: 180, default: null },
    recordedAt: { type: Date, default: null },
    accuracyMeters: { type: Number, min: 0, default: null }
  },
  eventIds: { type: [String], default: [] },
  events: { type: [eventSchema], default: [] },
  arrivedAt: { type: Date, default: null },
  emergencyAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null }
}, { timestamps: true, minimize: false });

journeySchema.index({ travellerId: 1, createdAt: -1 });
journeySchema.index({ sharedWith: 1, status: 1 });
module.exports = mongoose.model("JourneyServiceJourney", journeySchema);
