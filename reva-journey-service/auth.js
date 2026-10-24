const jwt = require("jsonwebtoken");

function authenticate(req, res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ success: false, message: "Bearer token required." });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = payload.userId || payload.id || payload._id;
    if (!userId) return res.status(401).json({ success: false, message: "Token has no user identity." });
    req.authUser = { id: String(userId), username: payload.username || payload.name || null };
    return next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired token." });
  }
}

module.exports = { authenticate };
