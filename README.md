# Privacy-Aware Real-Time Location Tracker with RAG

A Node.js, Express, MongoDB, Socket.IO, Leaflet and Gemini project with opt-in location sharing, accepted-friend access control, semantic location history, Gemini embeddings, MongoDB Vector Search, and a Reva location-history assistant.

## RAG architecture

Reva is now a real RAG pipeline rather than keyword search:

1. GPS samples are stored as normal location data and converted into semantic events such as arrivals, stays and departures.
2. Each meaningful location event is turned into text and embedded with Gemini `gemini-embedding-001`.
3. The embedding is stored with the event in MongoDB.
4. MongoDB Vector Search retrieves semantically relevant events using the user's question.
5. Retrieval is pre-filtered by authorized user IDs and optional time ranges such as today, yesterday and this week.
6. The retrieved events are passed to Gemini as grounded context for the final answer.
7. Exact distance questions still use deterministic backend calculations instead of asking an LLM to estimate coordinates.

The system intentionally embeds semantic events instead of every raw GPS point. Stay-event embeddings are refreshed only when the duration changes meaningfully, reducing unnecessary embedding calls.

## Setup

1. Create a local `.env` file based on `.env.example`.
2. Set `MONGO_URI`, a long random `JWT_SECRET`, and `GEMINI_API_KEY`.
3. Use a MongoDB deployment that supports MongoDB Vector Search. Atlas is recommended.
4. Install dependencies:
   ```bash
   npm install
   ```
5. Create the vector index and embed existing location events:
   ```bash
   npm run rag:setup
   ```
6. Start the app:
   ```bash
   npm run dev
   ```
7. Open `http://localhost:3000/register` and create test accounts.
8. Sign in to separate browser profiles, create an accepted friendship, and enable location sharing.
9. Use Reva to ask questions such as:
   - `Where did Rahul spend most of his time yesterday?`
   - `When did I last visit IIT Bhilai?`
   - `What places did my friends visit recently?`
   - `How long did I stay at the university?`
   - `How far away is Rahul?`

### RAG environment variables

- `EMBEDDING_MODEL=gemini-embedding-001`
- `EMBEDDING_DIMENSIONS=768`
- `RAG_VECTOR_INDEX=location_event_vector_index`

The vector index contains the `embedding` vector plus filter fields for `userId` and `recordedAt`.

## Privacy behavior

- Location sharing defaults to off for new users.
- Socket.IO verifies the JWT during the handshake.
- Live coordinates are sent only to accepted friends who have sharing enabled, not broadcast globally.
- Reva authorization happens before retrieval: only the current user's own events and events belonging to accepted friends who currently share are eligible for retrieval.
- MongoDB Vector Search pre-filters the semantic search by those authorized user IDs.
- Stopping sharing deletes the latest live-location record and notifies accepted friends; the user's history remains available to that user for personal history questions.
- Gemini is called only from the server. Never expose `GEMINI_API_KEY` in browser code or commit a real `.env` file.
- Do not send real sensitive location data to an external model unless every user understands and accepts that processing.

## MongoDB Vector Search note

`npm run rag:setup` attempts to create `location_event_vector_index` programmatically and then embeds all existing location events. On MongoDB environments where programmatic search-index creation is unavailable, create the same Vector Search index in the MongoDB/Atlas UI with:

- Field `embedding`: vector, 768 dimensions, cosine similarity
- Field `userId`: filter
- Field `recordedAt`: filter

After the index is ready, run `npm run rag:setup` again to populate embeddings.

## Important limitations before public deployment

This is a development foundation, not a security audit. Configure HTTPS, a strong secret, production CORS origin, request rate limits, input validation, account deletion/export, retention controls, and automated authorization tests before public deployment. Location history is sensitive. Do not use real users' data for early testing.
