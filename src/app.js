const express = require("express");
const path = require("path");
const cors = require("cors");
const morgan = require("morgan"); //FOR PRINT IN TERMINAL VIEW 

const authRoutes = require("./routes/authRoutes");

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));
app.use(express.urlencoded({extended : true}));
app.set("view engine", "ejs");

app.set(
    "views",
    path.join(__dirname, "views")
); //TELLS EXPRESS WHERE EJS FILES ARE ;OCATED

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

app.use("/api/auth", authRoutes);

app.get("/", (req, res) => {
    res.redirect("/login");
});

app.get("/login", (req, res) => {
    res.render("login");
});

app.get("/register", (req, res) => {
    res.render("register");
});

app.get("/tracker", (req, res) => {
    res.render("index");
});

module.exports = app;