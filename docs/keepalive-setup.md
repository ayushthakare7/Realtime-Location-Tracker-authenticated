# Reva service keep-alive setup

The GitHub Actions workflow `.github/workflows/reva-keepalive.yml` sends lightweight HTTP GET requests to the deployed Reva services on a best-effort schedule. It runs outside the Reva app, so the UI does not need to stay open.

## Configure the URLs

Open the GitHub repository and go to **Settings → Secrets and variables → Actions → Variables**. Keep the existing variables and verify their values:

- `REVA_NODE_HEALTH_URL` — main Reva app health endpoint, currently `https://realtime-location-tracker-authenticated.onrender.com/health`
- `REVA_RAG_HEALTH_URL` — Python RAG health endpoint, currently `https://reva-rag-new.onrender.com/health`
- `REVA_MOBILITY_HEALTH_URL` — Mobility service health endpoint, currently `https://realtime-location-tracker-authenticated-1.onrender.com/health`

Add this new repository variable for the separate Node API service:

- `REVA_NODE_API_HEALTH_URL` — `https://reva-node-api.onrender.com/health`

Use the exact service URLs shown in Render if they differ. Confirm each URL returns a successful HTTP status. The current main app and Node API are separate Render services, so both are checked.

Then open **Actions → Reva service keep-alive → Run workflow** and inspect the run logs. All four checks should say `OK`.

## Limitations

- The workflow is configured to run every 5 minutes, but GitHub scheduled workflows can be delayed or skipped; it is not a guaranteed real-time scheduler.
- This may reduce free-tier spin-down when the pings arrive often enough, but it cannot guarantee permanent uptime or prevent crashes, platform limits, restarts, or application-level hangs.
- If a health check takes a long time on a cold start, inspect that service's Render logs. A health ping cannot repair a broken request handler or missing configuration.
- This workflow only pings health endpoints; it does not access user location data or change the Reva UI.
