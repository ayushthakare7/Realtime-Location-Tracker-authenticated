require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const routes = require("./routes");
const { startWorker } = require("./worker");

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: process.env.JOURNEY_CLIENT_ORIGIN || process.env.CLIENT_ORIGIN || true }));
app.use(express.json({ limit: "100kb" }));
app.get("/health", (req, res) => res.json({ success: true, service: "reva-journey-service", status: "ok" }));
app.use("/api/journeys", (req, res, next) => {
  if (!process.env.JWT_SECRET) return res.status(503).json({ success: false, message: "JWT_SECRET is not configured." });
  next();
}, routes);
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err?.status || (err?.type === "entity.too.large" ? 413 : 500);
  if (status >= 500) console.error("[reva-journey-service]", err.message);
  return res.status(status).json({ success: false, message: status === 413 ? "Request body is too large." : (status < 500 ? err.message : "Journey service request failed.") });
});

async function start() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required.");
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required to verify Reva access tokens.");
  await mongoose.connect(process.env.MONGO_URI);
  const stopWorker = startWorker();
  const port = Number(process.env.JOURNEY_SERVICE_PORT || process.env.PORT || 3001);
  const server = app.listen(port, () => console.log("reva-journey-service listening on port " + port));
  const shutdown = async () => {
    stopWorker();
    await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
if (require.main === module) start().catch(error => { console.error("Journey service startup failed:", error.message); process.exit(1); });
module.exports = { app, start };
