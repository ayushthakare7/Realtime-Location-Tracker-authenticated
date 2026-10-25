const express = require("express");
const auth = require("../middleware/authMiddleware");

const router = express.Router();
router.use(auth);

router.all("/*path", async (req, res) => {
  const base = String(process.env.MOBILITY_SERVICE_URL || "http://127.0.0.1:3101").replace(/\/$/, "");
  const target = base + req.originalUrl;
  try {
    const response = await fetch(target, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: req.headers.authorization
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(15000)
    });
    const payload = await response.text();
    res.status(response.status);
    res.type(response.headers.get("content-type") || "application/json");
    res.send(payload);
  } catch (error) {
    console.error("[MobilityProxy]", error.message);
    res.status(503).json({
      success: false,
      message: "The Mobility service is not reachable. Start/deploy mobility-service and set MOBILITY_SERVICE_URL."
    });
  }
});

module.exports = router;
