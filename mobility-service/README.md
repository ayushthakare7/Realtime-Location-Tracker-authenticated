# Reva Mobility Context Service

Node.js microservice for road-based journey planning, ETA refresh, sharing permissions and arrival monitoring.

## Code map

- `server.js`: process startup, MongoDB connection, health endpoint and graceful shutdown.
- `src/routes/trips.js`: thin Express route declarations.
- `src/controllers/destinationController.js`: health and destination geocoding handlers.
- `src/controllers/tripsController.js`: create, fetch, update-recipient, arrive and end journey handlers.
- `src/controllers/sharedTripsController.js`: friend-visible journeys, authorized detail and dismiss/acknowledge.
- `src/middleware/auth.js`: JWT authentication.
- `src/middleware/rateLimit.js`: per-user API and geocoding throttling.
- `src/models/index.js`: trip and shared Reva collection schemas.
- `src/models/RoutingUsage.js`: daily routing-provider usage counter.
- `src/services/routing.js`: OpenRouteService routing/geocoding, quota tracking and caching.
- `src/services/worker.js`: active-trip monitoring, route refresh, delay and automatic-arrival detection.
- `src/services/notifications.js`: callback delivery to the main app.
- `src/services/geo.js`: distance calculation utility.
- `src/utils/trips.js`: coordinate validation, response serialization and accepted-friend lookup.
- `test/`: Node's built-in test runner tests.

## Free-tier setup

1. Create an OpenRouteService API key and review its current quotas and terms.
2. Copy `.env.example` to `.env`.
3. Set `MONGODB_URI` to the same MongoDB database used by the Reva main API.
4. Set `JWT_SECRET` to the exact same secret used by the main API. Never commit secrets.
5. Set `ORS_API_KEY` to your routing key.
6. Set `MOBILITY_CALLBACK_SECRET` in both apps and configure `MAIN_APP_INTERNAL_URL`.
7. Run `npm install`, then `npm start`. Health endpoint: `/health`.

The service uses a separate `mobilitytrips` collection and reads the existing `users`, `friendships`, and `locations` collections. It does not create a second GPS pipeline.

## Main API integration

The main app's authenticated proxy forwards the caller's bearer token; the mobility service validates it again. Delay and arrival callbacks use the shared callback secret, and the main app emits Socket.IO events to the traveller and selected recipients.

## Routing behavior

Routes and durations come from OpenRouteService road-routing responses. Reva does not calculate ETA from straight-line distance. If the routing key is missing or quota is exhausted, the API returns an explicit error. Shared MongoDB counters cap the defaults at 1,500 direction requests and 500 geocoding requests per UTC day; results are cached.

Supported modes: car, bicycle, motorbike, walking, bus and train. Motorbike uses the car road-routing profile. Bus and train currently use a clearly labelled road-network ETA approximation, not true transit directions.

## Operational notes

- The worker checks active trips against existing live-location records.
- Automatic arrival requires multiple fresh, accurate location samples within a configurable destination radius; manual confirmation remains available.
- A missed ETA is a delay notification, not an emergency determination.
- Recipient selections are restricted to accepted Reva friends.
- The mobility service remains in the existing single-container Render deployment; ports and deployment topology are unchanged.
- Never expose MongoDB URI, JWT secret or routing key to the browser.
