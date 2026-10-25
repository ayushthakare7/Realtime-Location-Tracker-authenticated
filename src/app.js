const express = require("express");
const path = require("path");
const cors = require("cors");
const morgan = require("morgan");
const authRoutes = require("./routes/authRoutes");
const trackerRoutes = require("./routes/trackerRoutes");
const mobilityProxyRoutes = require("./routes/mobilityProxyRoutes");
const mobilityEventsRoutes = require("./routes/mobilityEventsRoutes");
const mobilityNotificationRoutes = require("./routes/mobilityNotificationRoutes");
const pushRoutes = require("./routes/pushRoutes");

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || `http://localhost:${process.env.PORT || 3000}` }));
app.use(express.json({ limit: "20kb" }));
app.use(morgan("dev"));
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/auth", authRoutes);
app.use("/api/tracker", trackerRoutes);
app.use("/api/mobility", mobilityProxyRoutes);
app.use("/api/internal", mobilityEventsRoutes);
app.use("/api/mobility-notifications", mobilityNotificationRoutes);
app.use("/api/push", pushRoutes);

// Lightweight liveness endpoint for uptime checks; does not invoke user APIs.
app.get("/health", (req, res) => {
  res.status(200).json({ success: true, service: "reva-node" });
});

app.get("/", (req, res) => res.redirect("/login"));