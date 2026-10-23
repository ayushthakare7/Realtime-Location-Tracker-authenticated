# Reva — Privacy-Aware Real-Time Location Tracker

Reva is a location-sharing application with a Node.js web backend/frontend and a separate Python RAG microservice. The existing JavaScript application remains responsible for accounts, authentication, friendships, live GPS sharing, consent, and deterministic geospatial calculations. Python owns the RAG pipeline: embeddings, MongoDB Vector Search retrieval, LangGraph orchestration, and natural-language answer generation through LangChain.

## Two-service architecture

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
  - Consent check and authorized user ID selection
          |
          | HTTP POST + Bearer service token
          v
Python service (FastAPI + LangChain + LangGraph)
  - Event embeddings (sentence-transformers)
  - MongoDB Vector Search retrieval
  - LangGraph intent -> retrieve -> evidence -> answer
  - LangChain LLM and embedding integrations
          |
          v
MongoDB locationevents collection + vector index
```

Both services read the same MongoDB database. The Python service is private to the backend and should not be called directly by the browser.

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
│   ├── main.py                     # FastAPI + LangChain + LangGraph service
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

## Environment variables

| Variable | Purpose |
|---|---|
| `MONGO_URI` | Shared MongoDB connection string |
| `JWT_SECRET` | Node authentication secret |
| `GROQ_API_KEY` | Model API key used by the existing backend and Python service |
| `GROQ_MODEL` | Chat model identifier |
| `RAG_SERVICE_URL` | Internal Python service URL |
| `RAG_SERVICE_TOKEN` | Shared secret for Node-to-Python requests |
| `RAG_PORT` | Intended Python port; local command defaults to 8001 |
| `EMBEDDING_MODEL` | Python Sentence Transformers model |
| `RAG_VECTOR_INDEX` | MongoDB Atlas vector index name |
| `RAG_TOP_K` | Maximum number of relevant events retrieved |

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
- **First query is slow:** the Python embedding model may be downloading/loading for the first time.
- **Road distance vs. straight-line distance:** deterministic routing remains in the JavaScript location-query layer; semantic RAG should not estimate route distances.
