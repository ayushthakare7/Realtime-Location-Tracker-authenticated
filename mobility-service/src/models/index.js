const mongoose = require("mongoose");

const coordinateSchema = new mongoose.Schema({
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  label: { type: String, trim: true, maxlength: 200, default: null }
}, { _id: false });

const routeSchema = new mongoose.Schema({
  provider: { type: String, default: "openrouteservice" },
  profile: { type: String, required: true },
  distanceMeters: { type: Number, min: 0, required: true },
  durationSeconds: { type: Number, min: 0, required: true },
  coordinates: { type: [[Number]], default: [] },
  calculatedAt: { type: Date, default: Date.now }
}, { _id: false });

const mobilityTripSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  username: { type: String, required: true, maxlength: 80 },
  status: { type: String, enum: ["ACTIVE", "DELAYED", "ARRIVED", "CANCELLED", "COMPLETED"], default: "ACTIVE", index: true },
  transportMode: { type: String, enum: ["driving-car", "cycling-regular", "motorbike", "foot-walking", "bus", "train"], required: true },
  origin: { type: coordinateSchema, required: true },
  destination: { type: coordinateSchema, required: true },
  route: { type: routeSchema, required: true },
  expectedArrivalAt: { type: Date, required: true, index: true },
  originalExpectedArrivalAt: { type: Date, required: true },
  lastRoutedFrom: { type: coordinateSchema, required: true },
  lastRouteRefreshAt: { type: Date, default: Date.now },
  lastLocation: {
    latitude: { type: Number, min: -90, max: 90, default: null },
    longitude: { type: Number, min: -180, max: 180, default: null },
    lastSeen: { type: Date, default: null }
  },
  nearDestinationCount: { type: Number, default: 0 },
  lastArrivalSampleAt: { type: Date, default: null },
  recipientMode: { type: String, enum: ["ALL_FRIENDS", "SELECTED_FRIENDS", "ONE_FRIEND"], default: "ALL_FRIENDS" },
  recipients: [{ type: mongoose.Schema.Types.ObjectId }],
  dismissedBy: [{ type: mongoose.Schema.Types.ObjectId }],
  gracePeriodMinutes: { type: Number, min: 0, max: 60, default: 8 },
  delayNotifiedAt: { type: Date, default: null },
  arrivedAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },
  lastRouteErrorAt: { type: Date, default: null }
}, { timestamps: true, minimize: false });

mobilityTripSchema.index({ userId: 1, status: 1, createdAt: -1 });
const MobilityTrip = mongoose.models.MobilityTrip || mongoose.model("MobilityTrip", mobilityTripSchema, "mobilitytrips");

const userSchema = new mongoose.Schema({
  username: String, sharingEnabled: Boolean
}, { collection: "users", strict: false });
const friendshipSchema = new mongoose.Schema({
  requester: mongoose.Schema.Types.ObjectId,
  recipient: mongoose.Schema.Types.ObjectId,
  status: String
}, { collection: "friendships", strict: false });
const locationSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  username: String,
  latitude: Number,
  longitude: Number,
  accuracyMeters: Number,
  lastSeen: Date
}, { collection: "locations", strict: false });

module.exports = {
  MobilityTrip,
  User: mongoose.models.MobilityUser || mongoose.model("MobilityUser", userSchema, "users"),
  Friendship: mongoose.models.MobilityFriendship || mongoose.model("MobilityFriendship", friendshipSchema, "friendships"),
  Location: mongoose.models.MobilityLocation || mongoose.model("MobilityLocation", locationSchema, "locations")
};
