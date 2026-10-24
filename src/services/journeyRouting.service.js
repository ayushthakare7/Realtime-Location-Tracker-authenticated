const { geocodePlace } = require("./geocoding.service");
const { getTravelModeById } = require("./travelMode.service");

const GOOGLE_MODE = Object.freeze({
  walking: "WALK", running: "WALK", bicycle: "BICYCLE",
  car: "DRIVE", motorcycle: "TWO_WHEELER", scooter: "TWO_WHEELER",
  auto_rickshaw: "DRIVE", bus: "TRANSIT", train: "TRANSIT",
  metro: "TRANSIT", tram: "TRANSIT", cable_car: "TRANSIT"
});

function parseDurationSeconds(value) {
  const match = String(value || "").match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Math.max(0, Math.round(Number(match[1]))) : null;
}

function supportedTravelMode(modeId) {
  return Boolean(GOOGLE_MODE[modeId]);
}

async function fetchGoogleRoutes({ origin, destination, modeId }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    const error = new Error("Road/transit routing is not configured. Set GOOGLE_MAPS_API_KEY before requesting routes.");
    error.code = "ROUTING_NOT_CONFIGURED";
    throw error;
  }
  const mode = GOOGLE_MODE[modeId];
  if (!mode) {
    const error = new Error("This transport mode does not yet have a supported route provider.");
    error.code = "ROUTING_MODE_UNSUPPORTED";
    throw error;
  }

  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.routeLabels"
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.latitude, longitude: origin.longitude } } },
      destination: { location: { latLng: { latitude: destination.latitude, longitude: destination.longitude } } },
      travelMode: mode,
      computeAlternativeRoutes: true,
      languageCode: "en",
      units: "METRIC"
    }),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) {
    const error = new Error("Routing provider returned HTTP " + response.status);
    error.code = "ROUTING_PROVIDER_ERROR";
    throw error;
  }
  const data = await response.json();
  const routes = Array.isArray(data.routes) ? data.routes : [];
  if (!routes.length) {
    const error = new Error("No route was found for these places and travel mode.");
    error.code = "NO_ROUTE_FOUND";
    throw error;
  }
  return routes.slice(0, 3).map((route, index) => {
    const durationSeconds = parseDurationSeconds(route.duration);
    const distanceMeters = Number(route.distanceMeters);
    const encodedPolyline = route.polyline?.encodedPolyline;
    if (!Number.isFinite(distanceMeters) || distanceMeters < 0 || durationSeconds === null || !encodedPolyline) {
      throw new Error("Routing provider returned an incomplete route.");
    }
    return {
      optionId: "google-route-" + index,
      provider: "google-routes",
      providerRouteId: "google-route-" + index,
      distanceMeters,
      durationSeconds,
      encodedPolyline,
      routeLabels: Array.isArray(route.routeLabels) ? route.routeLabels : []
    };
  });
}

async function resolveAndRoute({ originText, destinationText, modeId, currentOrigin = null }) {
  const mode = getTravelModeById(modeId);
  if (!mode) {
    const error = new Error("Select a supported travel mode.");
    error.code = "INVALID_TRAVEL_MODE";
    throw error;
  }
  if (!supportedTravelMode(modeId)) {
    const error = new Error("Routing is not currently available for " + mode.label + ". Choose a supported mode or wait for another routing provider.");
    error.code = "ROUTING_MODE_UNSUPPORTED";
    throw error;
  }

  const originIsCurrentLocation = /^(my )?(current location|current position|here|my location)$/i.test(String(originText || "").trim());
  const [resolvedOrigin, destination] = await Promise.all([
    originIsCurrentLocation && currentOrigin
      ? Promise.resolve({
          latitude: Number(currentOrigin.latitude),
          longitude: Number(currentOrigin.longitude),
          name: "Current location",
          state: null,
          country: null
        })
      : geocodePlace(originText),
    geocodePlace(destinationText)
  ]);
  const origin = resolvedOrigin;
  if (!origin) {
    const error = new Error("Could not resolve the origin. Add a more specific place name.");
    error.code = "ORIGIN_UNRESOLVED";
    throw error;
  }
  if (!destination) {
    const error = new Error("Could not resolve the destination. Add a more specific place name.");
    error.code = "DESTINATION_UNRESOLVED";
    throw error;
  }
  if (origin.latitude === destination.latitude && origin.longitude === destination.longitude) {
    const error = new Error("Origin and destination resolve to the same coordinates. Please clarify the destination.");
    error.code = "SAME_ENDPOINT";
    throw error;
  }
  const routes = await fetchGoogleRoutes({ origin, destination, modeId });
  return {
    origin: { latitude: origin.latitude, longitude: origin.longitude, label: [origin.name, origin.state, origin.country].filter(Boolean).join(", ") },
    destination: { latitude: destination.latitude, longitude: destination.longitude, label: [destination.name, destination.state, destination.country].filter(Boolean).join(", ") },
    routes
  };
}

module.exports = { fetchGoogleRoutes, parseDurationSeconds, resolveAndRoute, supportedTravelMode };
