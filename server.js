require("dotenv").config();

const http = require("http");
const socketIo = require("socket.io");

const app = require("./src/app");
const connectDB = require("./src/config/db.js");

connectDB();

const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

require("./src/sockets/locationSocket")(io);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});