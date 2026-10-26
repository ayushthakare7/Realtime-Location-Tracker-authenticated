const mongoose = require("mongoose");

const AVATAR_IDS = ["child-boy", "child-girl", "college-boy", "college-girl", "adult-man", "adult-woman"];

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  sharingEnabled: { type: Boolean, default: false },
  // Only this device may publish the account's shared live location.
  activeLocationDeviceId: { type: String, default: "" },
  historyEnabled: { type: Boolean, default: true },
  avatarId: { type: String, enum: AVATAR_IDS, default: "college-boy" },
  // Small, client-compressed JPEG data URL (max 120 KB). No external image-hosting account required.
  profileImage: { type: String, default: "", maxlength: 120000 }
}, { timestamps: true });

userSchema.statics.AVATAR_IDS = AVATAR_IDS;
module.exports = mongoose.model("User", userSchema);
