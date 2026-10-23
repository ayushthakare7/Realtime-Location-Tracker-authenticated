const mongoose = require("mongoose");

const friendshipSchema = new mongoose.Schema({
  requester: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  status: { type: String, enum: ["pending", "accepted", "declined"], default: "pending", index: true }
}, { timestamps: true });

friendshipSchema.index({ requester: 1, recipient: 1 }, { unique: true });
module.exports = mongoose.model("Friendship", friendshipSchema);
