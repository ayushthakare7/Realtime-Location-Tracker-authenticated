const mongoose = require("mongoose");

// Maps to the existing Reva "friendships" collection. Shared DB is intentional
// for validating friend recipients without trusting client-supplied IDs.
const friendshipSchema = new mongoose.Schema({
  requester: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["pending", "accepted", "declined"], default: "pending" }
}, { timestamps: true, collection: "friendships" });

module.exports = mongoose.model("JourneyServiceFriendship", friendshipSchema);
