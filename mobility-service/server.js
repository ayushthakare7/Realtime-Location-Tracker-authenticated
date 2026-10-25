require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const tripsRouter = require("./src/routes/trips");
const { startMobilityWorker } = require("./src/services/worker");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

app.get("/health", (_req, res) => res.json({
  success: true,
  service: "reva-mobility-context",
  database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  routingConfigured: Boolean(process.env.ORS_API_KEY)
}));

app.use("/api/mobility", tripsRouter);

app.use((error, _req, res, _next) => {
  console.error("[MobilityService]", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.status && error.status < 500 ? error.message : "Mobility service could not complete the request."
  });
});

async function start() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required.");
  await mongoose.connect(process.env.MONGODB_URI);
  const port = Number(process.env.PORT) || 3101;
  const server = app.listen(port, () => {
    console.log("[MobilityService] Listening on port " + port);
    startMobilityWorker();
  });
  const shutdown = async () => {
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (require.main === module) {
  start().catch(error => {
    console.error("[MobilityService] Startup failed:", error.message);
    process.exit(1);
  });
}

module.exports = app;
