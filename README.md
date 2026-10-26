# Reva — Privacy-Aware Real-Time Location Tracker

Reva is a location-sharing application with a Node.js web backend/frontend and a separate Python RAG microservice. The existing JavaScript application remains responsible for accounts, authentication, friendships, live GPS sharing, consent, and deterministic geospatial calculations. Python owns the RAG pipeline: embeddings, MongoDB Vector Search retrieval, LangGraph orchestration, and natural-language answer generation through LangChain.

## Service architecture

```text
Browser (EJS + JavaScript + Leaflet)
          |
          | HTTP / Socket.IO
          v
Node.js service (Express + MongoDB/Mongoose)
  - Authentication and authorization
  - Friends and sharing permissions
  - Live location and location-event creation
  - Deterministic distance/geocoding/routing
  - Safety Travel journeys, route approval, progress/offline event sync, and overdue checks
  - Persistent in-app safety notifications
  - Consent check and authorized user ID selection
          |
          | HTTP POST + Bearer service token
          v
Python service (standard-library HTTP server + LangChain + LangGraph)
  - Event embeddings (sentence-transformers)
  - MongoDB Vector Search retrieval
  - LangGraph intent -> retrieve -> evidence -> answer
  - LangChain LLM and embedding integrations
          |
          v
MongoDB locationevents collection + vector index
```

Both services read the same MongoDB database. The Python service is private to the backend and should not be called directly by the browser. The local launch command binds it to `127.0.0.1:8001`. Safety Travel is implemented as a module in the existing Node service, not as an additional microservice. Safety Travel uses a public OpenStreetMap-based Valhalla router by default and does not require a Google Maps API key. The public endpoint has rate limits and no uptime guarantee; unsupported modes return an explicit error rather than a fabricated route.

## Request and response flow

1. The user submits a Reva question in the existing browser UI.
2. Express authentication middleware validates the user's session/JWT. The API checks the user's explicit AI consent.
3. The Node.js controller computes the allowed scope: the current user and accepted friends who have location sharing enabled. It prepares a minimal current-location/distance context.
4. For deterministic current-location and distance requests, the JavaScript backend continues to resolve authorized people/places and calculate coordinates/distances. The LLM is never trusted to invent coordinates or calculate exact distances.
5. For history and general location questions, Node sends the question, authorized user IDs, and minimal context to `POST /ask` on the Python service, using `Authorization: Bearer <RAG_SERVICE_TOKEN>`.
6. LangGraph classifies the question, retrieves semantically relevant authorized events from MongoDB Vector Search, prepares evidence, and generates a grounded response with LangChain.
7. Python returns a JSON answer. Node returns it through the existing API to the browser.

## Python RAG workflow

The current graph in `rag_service/main.py` is:

- `classify_intent`: classifies the query as history, summary, shared presence, or other.
- `retrieve_authorized_events`: embeds the question and performs MongoDB Vector Search, filtering by the authorized ObjectId list and optional time range.
- `prepare_evidence`: formats the retrieved events into explicit evidence.
- `generate_answer`: asks the language model to answer only from supplied evidence and current context.

LangGraph coordinates the workflow. LangChain provides the chat model and Hugging Face embedding integration. The application does **not** fine-tune a model on users' locations; it retrieves relevant records at question time.

## Location event indexing

The JavaScript backend still detects visits and creates arrival/stay/departure records in `LocationEvent`. It no longer generates embeddings. When an event is saved, Node calls the Python service's `POST /index-event` endpoint. Python creates the semantic text, generates a 384-dimensional embedding, and stores it on the event document.

The `npm run rag:setup` command calls the Python `POST /reindex` endpoint. That endpoint creates the configured Atlas Vector Search index if necessary and embeds existing location events. The index fields are:

- `embedding`: vector, 384 dimensions, cosine similarity
- `userId`: filter
- `recordedAt`: filter

MongoDB Atlas Vector Search is required for semantic retrieval. If an existing index has a different dimension count, use the configured index name `location_event_vector_index_384` and allow Atlas time to finish building it.

## Repository layout

```text
.
├── server.js                       # Starts Express, MongoDB and Socket.IO
├── package.json                    # Node scripts/dependencies
├── rag_service/
│   ├── main.py                     # Python HTTP + LangChain + LangGraph service
│   └── requirements.txt            # Python-only dependencies
├── scripts/
│   └── setup-rag.js                # Requests setup/reindex from Python
└── src/
    ├── app.js                      # Express configuration and web routes
    ├── config/db.js                # MongoDB connection
    ├── controllers/
    │   ├── trackerController.js    # Sharing, history and Node-to-RAG handoff
    │   └── locationQueryController.js # Deterministic location/distance tools
    ├── models/
    │   ├── LocationEvent.js        # Semantic location events and embeddings
    │   ├── Location.js             # Latest shared coordinates
    │   ├── LocationVisit.js        # Active/recent visit state
    │   ├── LocationPoint.js        # Raw historical GPS points
    │   ├── Friendship.js           # Friendship/access relationships
    │   └── User.js                 # Account and privacy settings
    ├── routes/trackerRoutes.js     # Authenticated tracker endpoints
    ├── services/
    │   ├── ragClient.service.js    # Authenticated HTTP client for Python
    │   ├── locationEvents.service.js # Detects visits; asks Python to embed events
    │   ├── locationQueryPlanner.service.js # Deterministic distance-query parsing
    │   ├── geocoding.service.js    # Resolves place names to coordinates
    │   └── gemini.service.js       # Existing hosted-model query parsing/answer helpers
    ├── sockets/locationSocket.js   # Real-time location updates
    ├── views/                      # EJS web pages
    └── public/                     # Browser JavaScript and CSS
```

## Setup

### 1. Configure Node.js

1. Copy `.env.example` to `.env`.
2. Set `MONGO_URI`, a long random `JWT_SECRET`, `GROQ_API_KEY`, and a long random `RAG_SERVICE_TOKEN`.
3. Keep `RAG_SERVICE_URL=http://127.0.0.1:8001` for local development.
4. Never commit the real `.env` file or expose the service token in browser code.

Install Node dependencies:

```bash
npm install
```

### 2. Configure Python

Use Python 3.11 or a compatible recent Python version. From the repository root:

**Windows PowerShell**
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r rag_service/requirements.txt
```

**macOS/Linux**
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r rag_service/requirements.txt
```

The Python service reads the same root `.env` file, including `MONGO_URI`, `GROQ_API_KEY`, `RAG_SERVICE_TOKEN`, `RAG_VECTOR_INDEX`, and `EMBEDDING_MODEL`.

### 3. Run both services

Terminal 1 — Python RAG service:

```bash
npm run rag:start
```

Terminal 2 — Node.js application:

```bash
npm run dev
```

Open `http://localhost:3000`. Check Python service health at `http://127.0.0.1:8001/health`.

### 4. Create the vector index and embed existing events

With both services running and MongoDB Atlas configured:

```bash
npm run rag:setup
```

This can take time on the first run because the embedding model must be downloaded and existing events must be embedded. Ensure the vector index finishes building before testing semantic queries.

## Deploy to Render

This repository uses two separate Render web services. Deploy the Python RAG service first, then the Node.js app. Do not expose the Python service token in browser code.

### Python RAG service

Create or update a Render **Web Service** connected to this repository with:

- **Root Directory:** `rag_service`
- **Runtime:** Python
- **Build Command:** `pip install -r requirements.txt && python download_model.py`
- **Start Command:** `python main.py`
- **Python version:** set Render environment variable `PYTHON_VERSION=3.11.11` (or use the included `.python-version` file)

The build command downloads and smoke-tests the ONNX FastEmbed model during deployment. This avoids loading the larger PyTorch sentence-transformers runtime in the live service. The model cache is part of the built service image. If the build fails during model download, fix that build failure before enabling embeddings.
- **Health check path:** `/health` (use this if your Render plan/settings support health checks)

Set these environment variables in Render (never commit their values):

- `RAG_SERVICE_TOKEN`: a long random secret shared only with the Node service
- `MONGO_URI`: the MongoDB Atlas connection string
- `GROQ_API_KEY`: the Groq API key
- Optional: `GROQ_MODEL`, `RAG_VECTOR_INDEX`, `RAG_TOP_K`, `EMBEDDING_MODEL`
- Set `RAG_DISABLE_EMBEDDINGS=false` to enable embedding generation and vector search after the model-preload build succeeds.

Render supplies `PORT` automatically. The service listens on that port in Render; for local development it defaults to port 8001.

After deployment, verify `https://YOUR-RAG-SERVICE.onrender.com/health`. A healthy response should include `"success": true` and `"mongoConnected": true`.

### Node.js web service

Create or update a separate Render **Web Service** for the same repository with:

- **Root Directory:** leave blank (repository root)
- **Runtime:** Node
- **Build Command:** `npm install`
- **Start Command:** `npm start`

Configure the app's existing required environment variables, including `MONGO_URI`, `JWT_SECRET`, and any mail/model provider keys used by the app, plus:

- `RAG_SERVICE_URL`: the Python service base URL, for example `https://YOUR-RAG-SERVICE.onrender.com` (do not append `/ask`)
- `RAG_SERVICE_TOKEN`: exactly the same secret as on the Python service
- `CLIENT_ORIGIN`: the public URL of the web app if you need to set a specific CORS origin

Deploy the Python service before the Node service. Then test sign-in, live location sharing, and a Reva question on the public web app. If either service has auto-deploy enabled, pushing a commit to the connected branch triggers a deployment; otherwise use Render's **Manual Deploy → Deploy latest commit**.


## Safety Travel backend API

All endpoints below require the existing JWT bearer authentication.

| Endpoint | Purpose |
|---|---|
| `GET /api/journeys/modes` | Canonical travel-mode catalogue, including exact `avatarKey` values |
| `POST /api/journeys` | Create a draft with `originText`, `destinationText`, `transportModeId` or explicit `travelModeText`, and optional accepted-friend IDs in `sharedWith` |
| `POST /api/journeys/:id/routes` | Resolve origin/destination and request real route alternatives |
| `POST /api/journeys/:id/approve` | Approve a returned `optionId`; only then does the journey become active |
| `GET /api/journeys` | List the current user's journeys and active journeys shared by friends |
| `GET /api/journeys/:id` | Read a journey if the caller owns it or has valid, active sharing permission |
| `POST /api/journeys/:id/events` | Submit one event or an `events` batch for location, check-in, arrival, connectivity, or explicit emergency |
| `POST /api/journeys/:id/sync` | Alias for the event endpoint, suitable for queued offline batches |
| `POST /api/journeys/:id/cancel` | Cancel a journey |
| `PATCH /api/journeys/:id/sharing` | Explicitly stop or resume sharing for a journey |
| `GET /api/journeys/notifications` | Read persisted in-app safety notifications |
| `PATCH /api/journeys/notifications/:notificationId/read` | Mark a notification as read |

The route provider uses the public OpenStreetMap-based Valhalla endpoint by default and does not require a Google Maps API key. The endpoint is best-effort and may rate-limit or become unavailable. Unsupported transport types return an explicit error; Reva does not fabricate a route. The catalogue's avatar keys are exact identifiers (for example, `bicycle` stays `bicycle`, and natural-language walking maps to `walking`).

The browser-side queue lives in IndexedDB (`src/public/js/journey-offline-queue.js`), retains up to 2,000 events for up to seven days, and syncs in batches of at most 100 when connectivity returns. The Safety Travel page exposes `window.RevaSafetyTravelOffline.startTracking(approvedJourneyId, approvalObject)` and `stopTracking()`; the approval object must contain approved=true and consent=true; both backend route approval and explicit user consent are required before GPS tracking begins. GPS collection requires permission and the page/browser to remain active; this is not guaranteed background tracking. Queue data stays on that browser/device until the server acknowledges it. The current journey planning form is not yet wired to create/approve a journey, so end-to-end user journey start still needs integration and device testing.

Offline event batches are idempotent by `eventId`, accept up to 100 events per request, and preserve the most recent recorded location by timestamp. Friend map updates include location freshness and remaining distance along the approved route when route geometry is available. Overdue checks run in a persistent database-backed polling worker; the app sends a check-in prompt after ETA plus the configured journey grace period, then alerts shared friends if there is still no response. Explicit emergency events follow a separate alert path. Notifications are persisted and emitted over Socket.IO; native/background push delivery still requires a push subscription/provider integration before claiming alerts can reach a fully closed app.

## Environment variables

| Variable | Purpose |
|---|---|
| `MONGO_URI` | Shared MongoDB connection string |
| `JWT_SECRET` | Node authentication secret |
| `GROQ_API_KEY` | Model API key used by the existing backend and Python service |
| `GROQ_MODEL` | Chat model identifier |
| `RAG_SERVICE_URL` | Internal Python service URL |
| `RAG_SERVICE_TOKEN` | Shared secret for Node-to-Python requests |
| `EMBEDDING_MODEL` | Python Sentence Transformers model |
| `RAG_VECTOR_INDEX` | MongoDB Atlas vector index name |
| `RAG_TOP_K` | Maximum number of relevant events retrieved |
| `VALHALLA_ROUTE_URL` | Optional URL override for a compatible OpenStreetMap-based Valhalla router; defaults to the public no-key endpoint |
| `JOURNEY_CHECKIN_GRACE_MINUTES` | Minutes after an overdue check-in prompt before trusted contacts are notified (default 5) |
| `JOURNEY_WORKER_INTERVAL_MS` | Safety deadline polling interval (default 30000 ms; minimum 10000 ms) |

## Privacy and security

- The browser never receives the Python service token or model API key.
- The Node backend verifies identity and consent before calling the RAG service.
- The Python service accepts only authorized user IDs supplied by Node and applies them as a vector-search filter.
- Keep the Python port bound to localhost for local development; in production, use a private network and service authentication.
- Location data is highly sensitive. Make external model processing clear to users and send only the context required to answer the question.
- This is a development foundation, not a security audit. Add rate limits, production HTTPS, retention controls, deletion/export flows, monitoring, and automated authorization tests before public deployment.

## Troubleshooting

- **401 from Python:** ensure Node and Python load the same `RAG_SERVICE_TOKEN` from the same `.env`.
- **Connection refused:** start Python first and check `RAG_SERVICE_URL` and port 8001.
- **Vector index error:** verify MongoDB Atlas Vector Search support, the index name, 384 dimensions, and the `userId`/`recordedAt` filter fields.
- **No history answer:** confirm history events exist, have embeddings, and belong to the authorized user IDs.
- **Embedding model fails to load:** confirm the Render build command includes `python download_model.py`, the build completed successfully, and `EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2` and inspect the build logs for `[Reva RAG build] ONNX model ready; embedding dimension=384`.
- **Existing events have no embeddings:** after enabling embeddings, call the authenticated `POST /reindex` endpoint using the repository's `npm run rag:setup` script to backfill events and ensure the Atlas Vector Search index is ready.
- **First query is slow:** the model should be preloaded during the build; check logs for the exact stage if initialization still stalls.
- **Road distance vs. straight-line distance:** deterministic routing remains in the JavaScript location-query layer; semantic RAG should not estimate route distances.


## Reva Mobility Context (new feature branch)

The standalone Node.js service lives in `mobility-service/`. It owns the `mobilitytrips` collection, calculates routes and ETA through the configured OpenRouteService free tier, and reads the main app's existing `users`, `friendships`, and `locations` collections. The existing GPS/socket pipeline remains the source of live positions; GPS accuracy is carried through the existing location updates for more cautious arrival detection.

The authenticated main app exposes `/mobility` as the dedicated My Journey page and `/mobility/shared/:tripId` as a read-only road-route view for an authorized recipient. The main dashboard includes a My Journey entry link. The service sends authenticated internal callbacks to the main app for real-time trip notifications. Configure `MOBILITY_SERVICE_URL` and the same `MOBILITY_CALLBACK_SECRET` in both services, plus `ORS_API_KEY` and `MONGODB_URI` in `mobility-service/.env`. See `mobility-service/README.md` for the standalone setup and free-tier constraints.

This is a separate, unmerged feature branch. It does not change `main`.

## Unified Render deployment

This repository runs the Node app, Mobility service, and Python RAG service inside one Docker web service. Configure secrets as Render environment variables; do not commit them. See the example env files for variable names.
