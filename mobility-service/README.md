# Reva Mobility Context Service

Standalone Node.js microservice for road-based journeys, ETA refresh, arrival detection and trip state.

## Free-tier setup

1. Create a free OpenRouteService API key and review the current free-plan quotas and production terms.
2. Copy `.env.example` to `.env`.
3. Set `MONGODB_URI` to the same MongoDB database used by the Reva main API.
4. Set `JWT_SECRET` to the exact same secret used by the main API. Never commit secrets.
5. Set `ORS_API_KEY` to the key from your free OpenRouteService account.
6. Set `MOBILITY_CALLBACK_SECRET` to the same long random secret in both apps and configure `MAIN_APP_INTERNAL_URL`.
7. Run `npm install`, then `npm start`. Health endpoint: `/health`.

The service uses a separate `mobilitytrips` collection. It reads the existing `users`, `friendships`, and `locations` collections; it does not create a second GPS pipeline.

## Main API integration

Set `MOBILITY_SERVICE_URL` in the main app to the deployed service base URL (for example, `http://localhost:3101` for local development). The main app's authenticated proxy forwards the caller's bearer token; the microservice validates it again. The microservice sends delay and arrival events to the main app using the shared callback secret; the main app emits Socket.IO events to the traveller and chosen recipients.

## Routing behavior

Routes and durations come from OpenRouteService road-routing responses. Reva does not calculate ETA from straight-line distance. If the routing key is missing or quota is exhausted, the API returns an explicit error rather than fabricating an ETA. Shared MongoDB counters cap the defaults at 1,500 direction requests and 500 geocoding requests per UTC day; results are cached to avoid unnecessary calls. Review the current provider free-plan limits and lower these caps if required.

Supported modes: car, bicycle, motorbike, walking, bus and train. Car, bicycle and walking use their corresponding OpenRouteService profiles. Motorbike uses the car road-routing profile with its own mode-specific live marker (the provider does not calculate a distinct motorcycle route). Bus and train are currently represented with a clearly labelled road-network ETA approximation and mode-specific live marker; this is not a true transit itinerary, rail-track route, timetable, transfer plan or live-traffic ETA. A dedicated public-transit/rail routing provider and its data/credentials are required for accurate bus and train directions.

## Safety and operational notes

- The worker uses existing live-location records and checks only active trips.
- Arrival is auto-confirmed after multiple worker readings within a configurable destination radius; manual confirmation is also available.
- A missed ETA is a delayed check, not an emergency determination.
- Recipient selections are restricted to accepted Reva friends. The main app emits `mobility-notification` and `mobility-trip-update` Socket.IO events to the traveller and selected recipients.
- For deployment, run this folder as its own service with its own health check. Do not expose the MongoDB URI, JWT secret, or routing key to the browser.
