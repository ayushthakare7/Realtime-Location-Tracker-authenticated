const express = require("express");
const auth = require("../middleware/authMiddleware");
const User = require("../models/User");
const router = express.Router();
const AVATARS = new Set(User.AVATAR_IDS || ["child-boy", "child-girl", "college-boy", "college-girl", "adult-man", "adult-woman"]);
const MAX_IMAGE_LENGTH = 120000;

router.get("/", async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("username email avatarId profileImage").lean();
    if (!user) return res.status(404).json({ success: false, message: "Profile not found." });
    res.json({ success: true, profile: { username: user.username, email: user.email, avatarId: user.avatarId || "college-boy", profileImage: user.profileImage || "" } });
  } catch { res.status(500).json({ success: false, message: "Could not load your profile." }); }
});
router.patch("/", async (req, res) => {
  try {
    const updates = {};
    if (req.body.avatarId !== undefined) {
      if (!AVATARS.has(req.body.avatarId)) return res.status(400).json({ success: false, message: "Choose one of the available Reva avatars." });
      updates.avatarId = req.body.avatarId;
    }
    if (req.body.profileImage !== undefined) {
      const image = req.body.profileImage;
      if (image !== "" && (typeof image !== "string" || image.length > MAX_IMAGE_LENGTH || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image))) {
        return res.status(400).json({ success: false, message: "Photo must be a compressed JPEG under 85 KB." });
      }
      updates.profileImage = image;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, message: "No profile changes provided." });
    const user = await User.findByIdAndUpdate(req.user.userId, { $set: updates }, { new: true, runValidators: true }).select("username avatarId profileImage").lean();
    if (!user) return res.status(404).json({ success: false, message: "Profile not found." });
    res.json({ success: true, profile: { username: user.username, avatarId: user.avatarId || "college-boy", profileImage: user.profileImage || "" } });
  } catch { res.status(500).json({ success: false, message: "Could not save your profile." }); }
});
module.exports = router;
