const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { sendRegistrationEmail } = require("../services/email.service");

const DEFAULT_AVATAR = "college-boy";
const ALLOWED_AVATARS = new Set(User.AVATAR_IDS || [DEFAULT_AVATAR, "child-boy", "child-girl", "college-girl", "adult-man", "adult-woman"]);
const MAX_PROFILE_IMAGE_LENGTH = 120000;

function validateProfileImage(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || value.length > MAX_PROFILE_IMAGE_LENGTH ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Please choose a JPEG photo under 85 KB after compression.");
  }
  return value;
}

exports.register = async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const avatarId = ALLOWED_AVATARS.has(req.body.avatarId) ? req.body.avatarId : DEFAULT_AVATAR;
    let profileImage;
    try { profileImage = validateProfileImage(req.body.profileImage); }
    catch (error) { return res.status(400).json({ success: false, message: error.message }); }

    if (!username || !email || !password) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }
    const existingUser = await User.findOne({ $or: [{ email: String(email).toLowerCase() }, { username: String(username).trim() }] });
    if (existingUser) return res.status(400).json({ success: false, message: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hashedPassword, avatarId, profileImage });
    try { await sendRegistrationEmail(user.email, user.username); }
    catch (error) { console.warn("Registration email could not be sent:", error.message); }

    res.status(201).json({ success: true, message: "User registered successfully", userId: user._id });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: String(email || "").toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    const isMatch = await bcrypt.compare(password || "", user.password);
    if (!isMatch) return res.status(401).json({ success: false, message: "Invalid credentials" });
    const token = jwt.sign({ userId: user._id, username: user.username }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.status(200).json({ success: true, token });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
