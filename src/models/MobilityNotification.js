const mongoose = require("mongoose");

const mobilityNotificationSchema = new mongoose.Schema({
  notificationKey: { type: String, required: true, unique: true, index: true },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  tripId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  type: { type: String, required: true, enum: ["journey_started", "journey_delayed", "journey_arrived", "journey_ended"] },
  title: { type: String, required: true, maxlength: 160 },
  body: { type: String, required: true, maxlength: 1000 },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  readAt: { type: Date, default: null, index: true }
}, { timestamps: true });

mobilityNotificationSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });
module.exports = mongoose.models.MobilityNotification || mongoose.model("MobilityNotification", mobilityNotificationSchema);
