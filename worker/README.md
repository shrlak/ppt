# Shared Recognition Proxy

A minimal Cloudflare Worker that lets everyone using the deployed lyrics app
recognize scores with Gemini / Hugging Face **without each person needing
their own API key**. It holds your keys as server-side secrets and relays
requests to the real provider — the keys never appear in the browser or in
the app's JavaScript bundle.

Without this, "bring your own key" (the app's default) is the only safe
option: a key baked directly into the static site's build would be visible
to anyone who opens dev tools, since the app has no backend of its own.

## How it works

```
Browser  ──POST /gemini/:model──▶  Worker (adds real key)  ──▶  Gemini API
Browser  ──POST /huggingface───▶  Worker (adds real key)  ──▶  Hugging Face API
Admin   ◀──GET /usage──────────  Worker + Durable Object usage counter
```

The Worker is a thin relay: it forwards the exact request body the browser
would have sent directly to the provider, just with the real key attached
server-side. It only accepts requests from the origins you allow
(`ALLOWED_ORIGINS`), so it can't be used as an open proxy by other sites.

Successful and failed upstream requests are grouped by exact model in a
SQLite-backed Durable Object. This is included in Cloudflare's Workers Free
plan and is provisioned automatically by the migration in `wrangler.toml`.
The admin panel reads `GET /usage` to show the shared-key totals across every
browser using the site.

Gemini does not publish a portable API for the active project's remaining
quota. Set `GEMINI_DAILY_REQUEST_LIMIT` in `wrangler.toml` to the current RPD
shown in AI Studio. Hugging Face's bar uses its monthly free credit and an
estimate based on `x-compute-time`; adjust `HUGGINGFACE_MONTHLY_CREDIT_USD` and
`HUGGINGFACE_USD_PER_SECOND` if the account allowance or hardware rate changes.
Provider billing dashboards remain authoritative.

## Deploy — automated via GitHub Actions (recommended)

`.github/workflows/deploy-worker.yml` deploys this Worker automatically on
every push to `worker/**` (and can be run manually from the Actions tab).
It also pushes your API keys into the Worker as secrets for you — you never
run a CLI command or touch the raw key outside GitHub's own secret UI.

**One-time setup:**

1. **Create a free [Cloudflare](https://dash.cloudflare.com/sign-up) account**
   if you don't have one, then find your **Account ID** — Cloudflare
   dashboard → any domain/Workers page → right sidebar ("Account ID").

2. **Create a Cloudflare API token**: dash.cloudflare.com/profile/api-tokens
   → *Create Token* → template **"Edit Cloudflare Workers"** → create, then
   copy the token (shown once).

3. In the GitHub repo, go to **Settings → Secrets and variables → Actions**
   and add these **Repository secrets** (Secrets tab, not Variables —
   paste each value directly into GitHub's field, never into a chat or a
   committed file):
   - `CLOUDFLARE_API_TOKEN` — from step 2
   - `CLOUDFLARE_ACCOUNT_ID` — from step 1
   - `GEMINI_API_KEY` — your Gemini key (optional; skip if only sharing Hugging Face)
   - `HUGGINGFACE_API_KEY` — your Hugging Face key (optional; skip if only sharing Gemini)

4. Edit `wrangler.toml` in this repo — set `ALLOWED_ORIGINS` to your deployed
   site's origin (e.g. `https://<your-username>.github.io`, no trailing
   slash), commit, and push to the default branch. This triggers the
   `Deploy AI Proxy Worker` workflow, which deploys the Worker and syncs
   your keys into it.

5. The workflow logs (Actions tab → the run → "Deploy Worker and sync
   secrets" step) print the deployed Worker URL, e.g.
   `https://lyrics-ai-proxy.<you>.workers.dev`. Add it as a repository
   **Variable** (Settings → Secrets and variables → Actions → **Variables**
   tab, not Secrets — it's just a URL, not sensitive) named
   `RECOGNITION_PROXY_URL`.

6. Push anything to trigger the main `CI & Deploy` workflow (or re-run it)
   so the site rebuilds with `VITE_RECOGNITION_PROXY_URL` set — see
   `.github/workflows/ci.yml`, which already reads this variable into the
   build.

From then on, editing `worker/` and pushing redeploys the Worker
automatically, and rotating a key is just: update the GitHub secret value,
push any change under `worker/` (or re-run the workflow manually) to re-sync
it.

## Deploy manually (alternative, for local testing)

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put HUGGINGFACE_API_KEY
npx wrangler deploy
```

## Wire it into the app

The app reads the proxy URL from the `VITE_RECOGNITION_PROXY_URL` build-time
variable — see step 5-6 above for the GitHub Actions path.

**Local dev:** create `.env.local` in the repo root:
```
VITE_RECOGNITION_PROXY_URL=https://lyrics-ai-proxy.<you>.workers.dev
```

Once set, anyone using the deployed site can leave the API key field blank
in AI 설정 and recognition will go through your shared proxy automatically.
Users who *do* enter their own key always use it directly instead (never the
proxy), so power users aren't limited by your shared quota.

## Abuse protection (optional but recommended)

The Worker checks `Origin` against `ALLOWED_ORIGINS`, but that header can be
spoofed by non-browser clients (curl, scripts). For real protection against
someone burning your quota:

- In the Cloudflare dashboard, add a **Rate Limiting Rule** on this Worker's
  route (Security → WAF → Rate limiting rules on the free tier) — e.g. block
  an IP after 20 requests/10 minutes.
- Keep an eye on usage in the Gemini/Hugging Face dashboards; rotate the key
  (`wrangler secret put ...` again) if you see unexpected volume.

## Local testing

```bash
cd worker
npx wrangler dev
```

This runs the Worker locally (default `http://localhost:8787`). Point
`VITE_RECOGNITION_PROXY_URL` at that URL and add `http://localhost:4173` (or
wherever `npm run preview` serves the app) to `ALLOWED_ORIGINS` for local
end-to-end testing.
