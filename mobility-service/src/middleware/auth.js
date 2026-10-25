const jwt = require("jsonwebtoken");

module.exports = function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ success: false, message: "Authentication required." });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.userId) return res.status(401).json({ success: false, message: "Invalid authentication token." });
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid authentication token." });
  }
};
