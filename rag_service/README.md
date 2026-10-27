# Reva Python RAG Service

## Module map

- `main.py`: process startup, HTTP server lifecycle, graceful shutdown.
- `config.py`: environment configuration and model/index settings.
- `api.py`: authenticated HTTP endpoints, payload validation, health checks.
- `database.py`: MongoDB client, collection access, Atlas vector-index setup.
- `embeddings.py`: lazy FastEmbed/Groq clients and background warm-up status.
- `indexing.py`: location-event text serialization and embedding writes.
- `intent.py`: GraphState and natural-language intent extraction/fallback classification.
- `retrieval.py`: authorized event retrieval, location-tool routing, evidence formatting.
- `graph.py`: LangGraph node wiring and answer generation.
- `time_queries.py`: existing deterministic time-specific history answers.
- `location_tools.py`: existing public geocoding/location-label tools.

## Compatibility notes

The public endpoints remain `GET /health`, `POST /ask`, `POST /index-event`, and `POST /reindex`. Authorization remains the existing Bearer token contract. Keep this service on the standard-library HTTP server; no FastAPI migration is introduced. The Node.js caller and existing request/response fields are intentionally unchanged.

## Local checks

From this directory, run `python -m compileall -q .` and the existing project tests. Then smoke-test `GET /health`, an authorized `POST /ask`, and `POST /index-event` against a non-production environment.
