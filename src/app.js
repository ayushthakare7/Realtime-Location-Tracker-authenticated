const express = require("express");
const path = require("path");
const cors = require("cors");
const morgan = require("morgan");
const authRoutes = require("./routes/authRoutes");
const trackerRoutes = require("./routes/trackerRoutes");
const safetyJourneyRoutes = require("./routes/safetyJourneyRoutes");
const { journeyServiceProxy } = require("../reva-journey-service/proxy");

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
app.use("/api/journeys", journeyServiceProxy, safetyJourneyRoutes);

app.get("/", (req, res) => res.redirect("/login"));
app.get("/login", (req, res) => res.render("login"));
app.get("/register", (req, res) => res.render("register"));
app.get("/safety-travel", (req, res) => res.render("safety-travel"));
app.get("/tracker", (req, res) => res.render("index"));

module.exports = app;
