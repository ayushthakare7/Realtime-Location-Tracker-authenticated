const SAFE_METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);
async function journeyServiceProxy(req, res, next) {
  const base = String(process.env.JOURNEY_SERVICE_URL || "").trim().replace(/\/$/, "");
  if (!base) return next();
  const path = req.originalUrl;
  const headers = { authorization: req.get("authorization") || "" };
  if (!SAFE_METHODS_WITHOUT_BODY.has(req.method)) headers["content-type"] = "application/json";
  try {
    const response = await fetch(base + path, {
      method: req.method,
      headers,
      body: SAFE_METHODS_WITHOUT_BODY.has(req.method) ? undefined : JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(Number(process.env.JOURNEY_SERVICE_PROXY_TIMEOUT_MS || 15000))
    });
    const text = await response.text();
    res.status(response.status);
    const contentType = response.headers.get("content-type");
    if (contentType) res.set("content-type", contentType);
    return res.send(text);
  } catch (error) {
    console.error("[journey-service-proxy]", error.message);
    return res.status(503).json({ success: false, message: "Safety Travel service is temporarily unavailable. Please retry." });
  }
}
module.exports = { journeyServiceProxy };
