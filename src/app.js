const express = require("express");
const path = require("path");
const cors = require("cors");
const morgan = require("morgan");
const authRoutes = require("./routes/authRoutes");
const trackerRoutes = require("./routes/trackerRoutes");
const mobilityProxyRoutes = require("./routes/mobilityProxyRoutes");
const mobilityEventsRoutes = require("./routes/mobilityEventsRoutes");

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

app.get("/", (req, res) => res.redirect("/login"));
app.get("/login", (req, res) => res.render("login"));
app.get("/register", (req, res) => res.render("register"));
app.get("/tracker", (req, res) => res.render("index"));
app.get("/mobility", (req, res) => res.render("mobility", { sharedTripId: null }));
app.get("/mobility/shared/:tripId", (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.tripId)) return res.status(400).send("Invalid journey ID.");
  res.render("mobility", { sharedTripId: req.params.tripId });
});

module.exports = app;
