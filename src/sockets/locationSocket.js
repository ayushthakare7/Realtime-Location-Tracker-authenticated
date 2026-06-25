const jwt = require("jsonwebtoken");
const Location = require("../models/Location");

const onlineUsers = {};

module.exports = (io) => {

    io.on("connection", (socket) => {

        console.log("Socket Connected:", socket.id);

        socket.on("join", async (token) => {

            try {

                const decoded = jwt.verify(
                    token,
                    process.env.JWT_SECRET
                );

                onlineUsers[socket.id] = {
                    userId: decoded.userId,
                    username: decoded.username
                };

                console.log(
                    `${decoded.username} joined`
                );

            } catch (error) {

                console.log("Invalid Token");
                socket.disconnect();

            }

        });

        socket.on(
            "send-location",
            async (data) => {

                const currentUser =
                    onlineUsers[socket.id];

                if (!currentUser) return;

                try {

                    await Location.findOneAndUpdate(
                        {
                            userId:
                                currentUser.userId
                        },
                        {
                            userId:
                                currentUser.userId,

                            username:
                                currentUser.username,

                            latitude:
                                data.latitude,

                            longitude:
                                data.longitude,

                            lastSeen:
                                new Date()
                        },
                        {
                            upsert: true,
                            new: true
                        }
                    );

                    io.emit(
                        "receive-location",
                        {
                            username:
                                currentUser.username,

                            latitude:
                                data.latitude,

                            longitude:
                                data.longitude
                        }
                    );

                } catch (error) {

                    console.log(error);

                }

            }
        );

        socket.on(
            "disconnect",
            () => {

                const user =
                    onlineUsers[socket.id];

                if (user) {

                    io.emit(
                        "user-disconnected",
                        user.username
                    );

                    delete onlineUsers[socket.id];
                }

                console.log(
                    "Disconnected:",
                    socket.id
                );
            }
        );

    });

};