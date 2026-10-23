# Privacy-Aware Real-Time Location Tracker with Reva

Reva is a privacy-aware location-history assistant inside a Node.js, Express, MongoDB, Socket.IO and Leaflet location tracker.

## Architecture

- **Node.js backend** owns login/JWT validation, friendships, location sharing, consent checks, current coordinates and the authorized user scope.
- **Python RAG service** uses LangChain, LangGraph, Hugging Face sentence-transformers, MongoDB Atlas Vector Search and Groq to retrieve authorized history and generate grounded answers.
- **MongoDB Atlas** stores the same location events and their 384-dimensional embeddings. Both services use the existing `location_event_vector_index_384` index.
- The Python service uses Python's standard-library HTTP server; FastAPI is not required.

The frontend talks only to Node.js. Node.js authenticates the request and determines which users may be included: the signed-in user plus accepted friends who currently have location sharing enabled. It sends that scope to the internal Python service over an authenticated HTTP request. Never accept authorization scope directly from browser input or expose the Python service publicly.

## Run locally

1. Create `.env` from `.env.example`; set `MONGO_URI`, a long random `JWT_SECRET`, `GROQ_API_KEY`, and a separate long random `RAG_SERVICE_TOKEN`.
2. Install Node dependencies:
   ```bash
   npm install
   ```
3. Install Python 3.11+ and the RAG service dependencies:
   ```bash
   python -m pip install langchain-core langchain-groq langchain-huggingface langgraph pymongo sentence-transformers
   ```
4. Start the Python RAG service from the repository root:
   ```bash
   python rag-main.txt
   ```
   It listens on `http://127.0.0.1:8001` by default. The `.txt` extension is intentional for this repository's source-file restrictions; it is Python source executed by the Python interpreter.
5. In a second terminal, start Node.js:
   ```bash
   npm run dev
   ```
6. Open `http://localhost:3000/register`, create test accounts, accept a friendship, enable sharing, and opt in to AI processing before asking Reva questions.

## Environment variables

- `MONGO_URI`: MongoDB connection string. The Python service uses the database in the URI unless `MONGO_DB_NAME` is set.
- `RAG_SERVICE_URL`: Node-to-Python URL; defaults to `http://127.0.0.1:8001`.
- `RAG_SERVICE_TOKEN`: shared internal bearer token; set the same random secret for both processes.
- `RAG_PORT`: Python service port, default `8001`.
- `RAG_VECTOR_INDEX`: defaults to `location_event_vector_index_384`.
- `GROQ_API_KEY` and `GROQ_MODEL`: answer generation configuration.
- `EMBEDDING_MODEL`: the existing Node event-indexing model is `Xenova/all-MiniLM-L6-v2`. Python retrieval uses the matching `sentence-transformers/all-MiniLM-L6-v2` model. Keep the model and 384 dimensions aligned; changing them requires re-embedding existing events and updating the Atlas index.

## RAG behavior

1. Meaningful GPS visits are stored as semantic arrival, stay and departure events.
2. Node validates the user and computes the allowed user IDs before calling Python.
3. Python embeds the question and performs Atlas vector retrieval constrained to those IDs.
4. LangGraph runs the retrieval and grounded-answer steps.
5. Exact distance calculations and current-location access checks remain in Node.js, not the language model.

The service requires a MongoDB Atlas Vector Search index on `embedding` with 384 dimensions and cosine similarity, plus filter fields `userId` and `recordedAt`. Use the repository's `npm run rag:setup` command to set up the index and embed existing events.

## Privacy and deployment

Location history is sensitive. Keep the Python service private, use a strong random service token, require user consent before AI processing, and never commit a real `.env`. The internal token authenticates service calls; the Node backend remains responsible for calculating the authorized user scope. Before public deployment, add automated authorization tests, request rate limits, HTTPS, retention controls and monitoring.
