# Privacy-Aware Real-Time Location Tracker with RAG

A Node.js, Express, MongoDB, Socket.IO, Leaflet and Gemini API project. This branch adds opt-in sharing, accepted-friend access control, location history retrieval, and a Gemini-powered Ask My Map endpoint.

## Requirements
- Node.js 18+ (native `fetch` is used)
- MongoDB
- A Gemini API key from Google AI Studio

## Setup
1. Create a local `.env` file based on `.env.example`.
2. Set `MONGO_URI`, a long random `JWT_SECRET`, and `GEMINI_API_KEY`.
3. In a terminal run:
   ```bash
   npm install
   npm run dev
   ```
4. Open http://localhost:3000/register and create two test accounts.
5. Sign in to each account in separate browser profiles. Send friend requests by exact username and accept them.
6. Click **Start sharing** only on the account whose location you want to share. The browser will request location permission.
7. Use **Ask My Map** to ask a question about the records retrieved for your account.

## Privacy behavior
- Location sharing defaults to off for new users.
- Socket.IO verifies the JWT during the handshake; clients cannot join by emitting an untrusted token event.
- Live coordinates are sent only to accepted friends who have sharing enabled, not broadcast globally.
- Friend lists and RAG retrieval are scoped to accepted friendships and current sharing consent.
- Stopping sharing deletes the latest live-location record and notifies accepted friends; the user's location history is retained for their own RAG questions.
- Gemini is called from the server. Never expose `GEMINI_API_KEY` in browser code or commit a real `.env` file.

## Gemini and free tier
The app currently uses `gemini-2.5-flash`. Availability and quotas can change by project and region; inspect the active quota in Google AI Studio. The free tier has rate limits and Google notes that data submitted on the free tier may be used to improve its products. Do not send real sensitive location data to an external model unless every user understands and accepts that processing.

Official docs:
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/rate-limits

## Important limitations before public deployment
This is a development foundation, not a security audit. Configure HTTPS, a strong secret, production CORS origin, request rate limits, input validation, account deletion/export, retention controls, and automated authorization tests before public deployment. Location history is sensitive. Do not use real users' data for early testing.
