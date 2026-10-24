# Reva Journey Service

Standalone Node.js microservice for Reva Safety Travel. It runs as a separate process (port 3001 by default) and stores journeys and notifications in dedicated `JourneyServiceJourney` and `JourneyServiceNotification` MongoDB collections. It does not modify the existing app's `SafetyJourney` collection.

## Run locally

```sh
cd reva-journey-service
npm install
cp .env.example .env
# Use the same JWT_SECRET and MONGO_URI as Reva's existing app.
npm start
```

Health check: `GET http://localhost:3001/health`. All `/api/journeys` endpoints require a Reva JWT as `Authorization: Bearer <token>`.

## Main endpoints

- `GET /api/journeys/modes` — supported transport modes and matching avatar keys.
- `POST /api/journeys` — create a draft from coordinates or place text; shared recipients must be accepted Reva friends in the shared MongoDB.
- `POST /api/journeys/:id/routes` — calculate a route with the free public OpenStreetMap-based Valhalla service. Public endpoint has rate limits/no SLA; no API key or paid routing account is required.
- `POST /api/journeys/:id/approve` — explicitly approve the route before sharing/tracking begins.
- `PATCH /api/journeys/:id/eta` — set a new ETA after a safety check-in.
- `POST /api/journeys/:id/sync` — idempotently ingest 1–100 location, offline/online, check-in, arrival, emergency, or cancellation events; event IDs prevent duplicate sync.
- `GET /api/journeys`, `GET /api/journeys/shared`, `GET /api/journeys/:id` — list own journeys, shared journeys, or a permitted journey.
- `PATCH /api/journeys/:id/sharing`, `POST /api/journeys/:id/cancel` — stop sharing or cancel a journey.
- `GET /api/journeys/notifications`, `PATCH /api/journeys/notifications/:notificationId/read` — durable notification inbox and read receipts.

A background worker requests a traveller check-in when an enabled shared journey reaches its ETA, then notifies shared friends if the grace period expires. An overdue status is not itself proof of an emergency. Emergency alerts are created only after an explicit emergency event.

## Important integration notes

This service is independently runnable and its journey data is isolated from the existing `SafetyJourney` model. It shares the existing MongoDB database initially so it can verify accepted friendships and validate Reva JWTs. The main app has an optional API proxy. To enable it, set `JOURNEY_SERVICE_URL=http://127.0.0.1:3001` in the main app environment and restart the main API; with this variable unset, the legacy in-process API remains active. The existing UI has not yet been adapted to the service response shape, so leave this proxy unset until the UI integration is completed and tested. Do not deploy it publicly until the gateway/client integration, friend-recipient validation, and deployment CORS/origin settings are reviewed. The free public geocoder/router is best effort and may rate-limit requests.
