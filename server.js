require("dotenv").config();
const http = require("http");
const socketIo = require("socket.io");
const app = require("./src/app");
const connectDB = require("./src/config/db.js");

async function start() {
  await connectDB();
  const server = http.createServer(app);
  const allowedOrigin = process.env.CLIENT_ORIGIN || `http://localhost:${process.env.PORT || 3000}`;
  const io = socketIo(server, { cors: { origin: allowedOrigin, methods: ["GET", "POST"] } });
  app.set("io", io);
  require("./src/sockets/locationSocket")(io);
  const { startSafetyJourneyWorker } = require("./src/services/safetyJourneyWorker.service");
  startSafetyJourneyWorker(io);
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
start().catch((error) => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});
