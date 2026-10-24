const mongoose = require("mongoose");

const coordinateSchema = new mongoose.Schema({
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  label: { type: String, trim: true, maxlength: 200, default: null }
}, { _id: false });

const routeSchema = new mongoose.Schema({
  optionId: { type: String, trim: true, maxlength: 100, default: null },
  routeLabels: { type: [String], default: [] },
  provider: { type: String, trim: true, maxlength: 80, default: null },
  providerRouteId: { type: String, trim: true, maxlength: 200, default: null },
  distanceMeters: { type: Number, min: 0, default: null },
  durationSeconds: { type: Number, min: 0, default: null },
  encodedPolyline: { type: String, maxlength: 200000, default: null },
  approvedAt: { type: Date, default: null }
}, { _id: false });

const journeyEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, trim: true, maxlength: 128 },
  type: {
    type: String,
    required: true,
    enum: ["location", "check_in", "arrival", "offline", "online", "overdue", "alert_sent", "emergency", "cancelled"]
  },
  recordedAt: { type: Date, required: true },
  receivedAt: { type: Date, required: true, default: Date.now },
  latitude: { type: Number, min: -90, max: 90, default: null },
  longitude: { type: Number, min: -180, max: 180, default: null },
  accuracyMeters: { type: Number, min: 0, default: null },
  note: { type: String, trim: true, maxlength: 500, default: null },
  source: { type: String, enum: ["device", "server"], default: "device" }
}, { _id: false });

const safetyJourneySchema = new mongoose.Schema({
  travellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  travellerUsername: { type: String, required: true, trim: true, maxlength: 80 },
  status: {
    type: String,
    enum: ["DRAFT", "AWAITING_ROUTE_APPROVAL", "ACTIVE", "OVERDUE_UNCONFIRMED", "ALERT_SENT", "EMERGENCY_ALERTED", "ARRIVED", "CANCELLED", "COMPLETED"],
    default: "DRAFT",
    index: true
  },
  transportModeId: { type: String, required: true, trim: true, maxlength: 64 },
  avatarKey: { type: String, required: true, trim: true, maxlength: 64 },
  modeSource: { type: String, enum: ["user_selection", "explicit_language"], required: true },
  origin: { type: coordinateSchema, required: false, default: null },
  originText: { type: String, required: true, trim: true, maxlength: 200 },
  destination: { type: coordinateSchema, default: null },
  destinationText: { type: String, required: true, trim: true, maxlength: 200 },
  routeOptions: { type: [routeSchema], default: [] },
  route: { type: routeSchema, default: () => ({}) },
  sharedWith: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  sharingEnabled: { type: Boolean, default: true },
  connectionStatus: { type: String, enum: ["unknown", "online", "offline"], default: "unknown" },
  connectionStatusUpdatedAt: { type: Date, default: null },
  expectedArrivalAt: { type: Date, default: null, index: true },
  gracePeriodMinutes: { type: Number, min: 0, max: 180, default: 10 },
  checkInRequestedAt: { type: Date, default: null },
  alertSentAt: { type: Date, default: null },
  arrivedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  lastConfirmedLocation: {
    latitude: { type: Number, min: -90, max: 90, default: null },
    longitude: { type: Number, min: -180, max: 180, default: null },
    recordedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    accuracyMeters: { type: Number, min: 0, default: null },
    placeLabel: { type: String, trim: true, maxlength: 200, default: null }
  },
  eventIds: { type: [String], default: [] },
  events: { type: [journeyEventSchema], default: [] }
}, { timestamps: true, minimize: false });

safetyJourneySchema.index({ travellerId: 1, createdAt: -1 });
safetyJourneySchema.index({ sharedWith: 1, status: 1 });
safetyJourneySchema.index({ status: 1, expectedArrivalAt: 1 });

module.exports = mongoose.model("SafetyJourney", safetyJourneySchema);
