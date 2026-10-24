# Reva Journey Service

Standalone Node.js microservice for Safety Travel journey lifecycle and event ingestion. It runs as a separate process on port 3001 by default and stores its data in the `JourneyServiceJourney` MongoDB collection, separate from the existing API's `SafetyJourney` collection.

## Run locally

```sh
cd reva-journey-service
npm install
cp .env.example .env
# Set MONGO_URI and the same JWT_SECRET used by Reva's existing API.
npm start
```

Health check: `GET http://localhost:3001/health`

All journey API routes require the existing Reva JWT in `Authorization: Bearer <token>`. The service verifies the signature itself; it does not trust a user ID supplied in request JSON.

## Endpoints

- `GET /api/journeys/modes` — supported travel modes and matching avatar keys.
- `POST /api/journeys` — create an active journey using explicit origin/destination coordinates and a supported travel mode.
- `GET /api/journeys` — list journeys owned by the authenticated user.
- `GET /api/journeys/:id` — read an owned journey or a journey explicitly shared with the authenticated user while sharing is enabled.
- `POST /api/journeys/:id/sync` — idempotently ingest 1–100 offline/online, location, check-in, arrival, emergency, or cancellation events.
- `PATCH /api/journeys/:id/sharing` — enable/disable sharing for the journey's preconfigured recipients.
- `POST /api/journeys/:id/cancel` — cancel a journey and stop sharing.

## Current boundaries

This is the first independently runnable service boundary. It intentionally does not modify the existing `/api/journeys` routes or `main` branch. The existing app integration, friendship-validated recipient provisioning, route/geocoding provider, ETA monitor, persisted notification delivery, and end-to-end tests are follow-up integration work on the same feature branch. Do not expose this service publicly until the gateway validates friend relationships before provisioning `sharedWith` recipients.
