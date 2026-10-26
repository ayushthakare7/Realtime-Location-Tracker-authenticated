const mongoose = require("mongoose");

const locationDeviceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  deviceId: { type: String, required: true },
  label: { type: String, required: true, default: "This device", maxlength: 60 },
  lastSeen: { type: Date, default: Date.now }
}, { timestamps: true });

locationDeviceSchema.index({ userId: 1, deviceId: 1 }, { unique: true });
module.exports = mongoose.model("LocationDevice", locationDeviceSchema);
