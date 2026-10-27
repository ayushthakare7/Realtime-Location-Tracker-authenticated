# Reva Python RAG Service

## Module map
- `main.py`: process startup and graceful HTTP server shutdown.
- `config.py`: environment variables, model aliases, and retrieval settings.
- `api.py`: authenticated HTTP routes, input validation, health responses, and HTTP error mapping.
- `database.py`: MongoDB client, collection access, and Atlas vector-index setup.
- `embeddings.py`: lazy FastEmbed/Groq clients and background embedding warm-up health.
- `indexing.py`: event text generation and vector writes.
- `intent.py`: graph state and question-intent extraction/classification.
- `retrieval.py`: authorized history retrieval, public location-tool routing, evidence formatting.
- `graph.py`: LangGraph node wiring and answer generation.
- `time_queries.py`: deterministic time-based location/history answers.
- `location_tools.py`: public geocoding and location-label helpers.

## Compatibility
The existing standard-library HTTP server and endpoint contracts are retained: `GET /health`, `POST /ask`, `POST /index-event`, and `POST /reindex`. Bearer-token authorization and the current MongoDB/embedding fallback remain. No FastAPI dependency or separate deployment is introduced.

## Smoke checks
From `rag_service/`, run `python -m compileall -q .`; then test `GET /health`, authenticated `POST /ask`, `POST /index-event`, and `POST /reindex` against a non-production database.
