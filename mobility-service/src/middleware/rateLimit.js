// Per-user in-memory throttling. Must run after JWT authentication.
const requestWindows = new Map();

function mobilityRateLimit(req, res, next) {
  const now = Date.now();
  const userKey = String(req.user.userId || "unknown");
  const kind = req.path.startsWith("/geocode") ? "geocode" : "api";
  const key = userKey + ":" + kind;
  const limit = kind === "geocode" ? 12 : 90;
  let bucket = requestWindows.get(key);
  if (!bucket || now - bucket.startedAt >= 60000) bucket = { startedAt: now, count: 0 };
  bucket.count += 1;
  requestWindows.set(key, bucket);
  if (requestWindows.size > 5000) {
    for (const [entryKey, entry] of requestWindows) {
      if (now - entry.startedAt >= 60000) requestWindows.delete(entryKey);
    }
  }
  if (bucket.count > limit) {
    return res.status(429).json({
      success: false,
      message: kind === "geocode"
        ? "Destination search is rate-limited to protect the free routing quota. Please wait a minute."
        : "Too many mobility requests. Please wait a moment."
    });
  }
  next();
}
module.exports = mobilityRateLimit;
