# CourseCompass

Evidence-first course discovery and comparison. Research results are obtained from live course pages through the TinyFish Agent API; the app never substitutes sample courses when research is unavailable.

## Run locally

Requires Node.js 18 or newer. No package installation is needed.

1. Copy `.env.example` to `.env`.
2. Add your server-side TinyFish key as `TINYFISH_API_KEY=...` in `.env`.
3. Run `npm start` and open <http://localhost:4173>.

Without a key, the interface and local preferences/saved-course features load, while live research returns a clear setup error. The key is read only by the server and is never sent to the browser.

## Research integration

`POST /api/research` accepts `{ "topic": "...", "selectedPlatforms": ["Coursera", "Udemy"] }` and responds with server-sent events. The backend calls TinyFish's official `POST https://agent.tinyfish.ai/v1/automation/run-sse` endpoint for each selected public platform search page, with `X-API-Key` authentication. It forwards real progress and source status, and normalizes returned course fields. Each platform run has a 120-second timeout. No login, CAPTCHA, or access-control bypass is attempted.

TinyFish documentation: [Agent API](https://docs.tinyfish.ai/agent-api). The agent output is prompted for JSON. If a site blocks access or returns no parseable results, that source status is surfaced and the result set stays empty.

## API

- `GET /api/status` — whether the server has TinyFish configured.
- `POST /api/research` — live SSE research; fields: `topic`, optional `selectedPlatforms`.
- `GET /api/saved` — read saved courses.
- `POST /api/saved` — save one normalized course.
- `DELETE /api/saved/:id` — remove a saved course.
- `GET /api/preferences` — read the local learning profile.
- `PUT /api/preferences` — persist the profile.

Saved courses and preferences are stored in `data/store.json` on the local server. Back this directory up for persistence across deployments. This single-user/local implementation intentionally does not claim multi-user authentication or Supabase isolation. Add an authenticated database adapter before deploying to a shared public service.

## Comparison

The comparison score uses the requested six dimensions and defaults (30/25/15/10/10/10). Users can adjust dimension weights. Missing fields are excluded from a course's weighted score and reported through data coverage/confidence; values are not treated as zero. Topic overlap currently uses exact topic label matches, so semantically similar labels may appear unique.

## Deployment

Run `npm start` behind an HTTPS reverse proxy that supports streaming responses. Set `TINYFISH_API_KEY`, `PORT`, and (if needed) `HOST` in the server environment. The default host is `127.0.0.1` for local use; set `HOST=0.0.0.0` only when the deployment requires external network access. Persist `data/store.json` on durable storage. Configure request rate limiting and user authentication at the edge before exposing the app to multiple users; the local server currently validates topic length but does not provide account-level access control.
