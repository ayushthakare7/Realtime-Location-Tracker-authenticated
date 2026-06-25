const token = localStorage.getItem("token");

if (!token) {
    window.location.href = "/login";
}

const socket = io();
const markers = {};

// Socket Connection
socket.on("connect", () => {
    console.log("Connected:", socket.id);

    socket.emit("join", token);
});

// Geolocation Tracking
if (navigator.geolocation) {
    navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude } = position.coords;

            socket.emit("send-location", {
                latitude,
                longitude
            });
        },
        (error) => {
            console.error("Location Error:", error);
        },
        {
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 0
        }
    );
}

// Leaflet Map
const map = L.map("map").setView([0, 0], 15);

L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        attribution: "Real Time Tracker"
    }
).addTo(map);

// Receive User Locations
socket.on("receive-location", (data) => {

    console.log("Received:", data);

    const {
        username,
        latitude,
        longitude
    } = data;

    map.setView([latitude, longitude], 15);

    if (markers[username]) {

        markers[username].setLatLng([
            latitude,
            longitude
        ]);

    } else {

        markers[username] = L.marker([
            latitude,
            longitude
        ])
        .addTo(map)
        .bindTooltip(username, {
            permanent: true,
            direction: "top",
            offset: [0, -10]
        });

    }
});

// User Disconnect
socket.on("user-disconnected", (username) => {

    if (markers[username]) {

        map.removeLayer(markers[username]);

        delete markers[username];
    }
});