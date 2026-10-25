# Reva service keep-alive setup

The GitHub Actions workflow `.github/workflows/reva-keepalive.yml` sends lightweight HTTP GET requests to all three deployed services every 8 minutes. It runs outside the Reva app, so it does not require a user to keep the UI open and does not change the frontend.

## Configure the URLs

After this workflow is merged into the repository default branch:

1. Open the GitHub repository.
2. Go to **Settings → Secrets and variables → Actions → Variables**.
3. Create these **repository variables** (not secrets; they are endpoint URLs):
   - `REVA_NODE_HEALTH_URL` — full Node service health URL, e.g. `https://YOUR-NODE-SERVICE.onrender.com/health`
   - `REVA_RAG_HEALTH_URL` — full Python RAG health URL, e.g. `https://YOUR-RAG-SERVICE.onrender.com/health`
   - `REVA_MOBILITY_HEALTH_URL` — full Mobility service health URL, e.g. `https://YOUR-MOBILITY-SERVICE.onrender.com/health`
4. Confirm each service really exposes the specified health endpoint. If a service uses a different path, set that exact working URL instead.
5. Open **Actions → Reva service keep-alive → Run workflow** to test it immediately. Inspect the run logs and make sure all three endpoints return a successful HTTP status.

Use the exact deployed URLs from the Render dashboards; the example URLs above are placeholders. Do not put API keys, service tokens, or other credentials in these variables or in the workflow. Health endpoints should return a minimal status response and must not trigger expensive RAG work, database reindexing, or location processing.

## Important limitations

- Scheduled GitHub Actions runs can be delayed and are not a real-time scheduler. The workflow needs to be on the repository default branch to run on schedule.
- This can reduce idle spin-down when requests arrive often enough, but it does **not** guarantee permanent uptime or prevent Render restarts, crashes, platform limits, or application-level hangs.
- Render free-tier services should normally wake automatically on a request. If RAG still requires redeployment after a successful health check, investigate its `/ask` request handling, model initialization, MongoDB connectivity, memory usage, and logs; a keep-alive ping cannot repair a broken request handler.
- This workflow only pings health endpoints. It does not send requests to users, access user data, or change the Reva UI.
- The workflow may consume GitHub Actions minutes depending on repository plan and usage.
