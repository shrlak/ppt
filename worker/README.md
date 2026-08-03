# Shared Recognition Proxy and Library Backend

A minimal Cloudflare Worker that lets everyone using the deployed lyrics app
recognize scores with Gemini / OpenRouter / Hugging Face **without each person
needing their own API key**. It holds your keys as server-side secrets and
relays requests to the real provider — the keys never appear in the browser
or in the app's JavaScript bundle.

Without this, "bring your own key" (the app's default) is the only safe
option: a key baked directly into the static site's build would be visible
to anyone who opens dev tools, since the app has no backend of its own.

## How it works

```
Browser  ──POST /gemini/:model──▶  Worker (adds real key)  ──▶  Gemini API
Browser  ──POST /openrouter────▶  Worker (adds real key)  ──▶  OpenRouter free vision models
Browser  ──POST /huggingface───▶  Worker (adds real key)  ──▶  Hugging Face API
Admin   ◀──GET /usage──────────  Worker + Durable Object usage counter
Everyone ◀──GET /settings──────  shared recognition settings (model pool, excluded titles)
Admin    ──POST /settings─────▶  update shared settings (관리자 비밀번호 required)
Everyone ◀──GET /libraries/lyrics── shared user-added lyrics
Admin    ──PUT/DELETE /libraries/lyrics── save or delete lyrics
Everyone ◀──GET /libraries/ppt───── shared PPT metadata and file chunks
Admin    ──POST/DELETE /libraries/ppt── save, edit, or delete PPT entries
Cron     ──Sun 5 PM ET────────▶  wipe every PPT entry and its files
Admin    ──POST /libraries/ppt/purge── run that wipe now
```

`GET/POST /settings` is what makes 관리자 설정 changes apply to **every
device**: the concurrent model pool and excluded-title list live in the Worker's
Durable Object, every browser fetches them before recognizing, and writes
require the admin password (default: the app's built-in one; override with
the `ADMIN_PASSWORD` secret). Only models from the shared catalog
(`src/config.js`, mirrored in the app) can be prioritized, and POST /openrouter
only forwards allowlisted catalog models to the shared key.

The same Durable Object is also the source of truth for both user-facing
libraries. Existing `localStorage` lyrics and IndexedDB PPT records are merged
automatically the first time a browser connects. Every file on an entry — the
generated PPTX, the 콘티 PDF, the 설교 PPTX, and the JSON snapshot of the
wizard inputs that 편집 reopens — is transferred and stored in 1 MiB chunks,
then fetched only when the user downloads or edits that entry. The chunk
routes are generated from `PPT_FILE_KINDS` in `src/library.js`: the client
uploads every kind it declares and a rejected chunk fails the whole deck, so
adding a kind there is all that a new file needs.
Each PPT-library entry is capped at 100 MB
across all its files, and the shared library accepts up to 250 PPT entries.
Browser storage remains an offline cache, so a temporary Worker outage does
not discard a newly generated presentation. Deletion tombstones keep an old
device from restoring an item deleted elsewhere.

### Weekly PPT purge (Sunday 5 PM)

The shared PPT library holds one week of material at a time. A cron trigger
deletes **every saved PPT entry and all of its files** each Sunday at 5 PM
`PURGE_TIMEZONE` (default `America/New_York`), so the next week's 콘티 starts
from an empty library. Half-finished uploads go with them. The 곡 (lyrics)
library, shared settings, and usage counters are never touched.

Cron triggers are UTC-only, so `wrangler.toml` fires the Worker at **both**
UTC hours that can be 5 PM Eastern — `crons = ["0 21,22 * * SUN"]`, i.e.
21:00 UTC (EDT) and 22:00 UTC (EST). `src/purge.js` compares the actual local
time and records the local date of each purge, so exactly one firing per week
does the work and DST never shifts the deletion off 5 PM. Changing
`PURGE_TIMEZONE`, `PURGE_HOUR`, or `PURGE_WEEKDAY` means updating that cron
expression (and the notice shown in the app's 라이브러리 panel) to match.

Two numbering traps live in that one line:

- **Cloudflare weekdays run 1 = Sunday … 7 = Saturday**, unlike the usual cron
  convention where Sunday is 0. Writing `0 21 * * 0` puts the weekday out of
  range, and the deploy fails after uploading the script with `Some triggers
  failed to deploy … /workers/scripts/<name>/schedules`. Use the three-letter
  form (`SUN`) and the ambiguity disappears.
- `PURGE_WEEKDAY`, in contrast, is read by `src/purge.js` and follows
  JavaScript's `Date#getDay()` — **0 = Sunday**. It is not a cron field.

Both hours ride a single expression rather than two array entries, so the
purge costs one cron trigger. The Workers Free plan allows five per account.

Each deleted deck leaves a tombstone behind, so a browser that cached the
deck drops its local copy on the next sync instead of uploading it back.
Tombstones older than 90 days are swept during the purge.

Check the schedule and the last run, or trigger a purge immediately:

```bash
curl https://<worker>.workers.dev/libraries/ppt/purge -H 'Origin: https://shrlak.github.io'
curl -X POST https://<worker>.workers.dev/libraries/ppt/purge \
  -H 'Origin: https://shrlak.github.io' -H 'Authorization: Bearer <ADMIN_PASSWORD>'
```

A manual purge deletes the same things but is not recorded as that week's
scheduled run, so Sunday evening still wipes anything saved in between.

Library reads are limited by the same origin allowlist as recognition. Library
writes require the administrator credential used by `/settings`. This matches
the app's current shared-admin model; it is not per-user account isolation.

The `/openrouter` route pins every request to one of three free vision models:
NVIDIA Nemotron Nano 12B VL (document intelligence), Gemma 4 31B, or the
multilingual Gemma 3 27B. The legacy `/nvidia` path remains as an alias for
older deployed clients, but new builds use `/openrouter`. No request goes
directly from the deployed browser to OpenRouter.

OpenRouter free endpoints may log prompts and outputs for provider
improvement. Do not submit personal, confidential, or otherwise sensitive
score images through these models.

The Worker is a thin relay: it forwards the exact request body the browser
would have sent directly to the provider, just with the real key attached
server-side. It only accepts requests from the origins you allow
(`ALLOWED_ORIGINS`), so it can't be used as an open proxy by other sites.

Successful and failed upstream requests, shared settings, lyrics entries, and
chunked PPT-library files are stored in a SQLite-backed Durable Object. It is
provisioned automatically by the migration in `wrangler.toml`; no additional
R2 bucket or database binding is required. The admin panel reads `GET /usage`
to show the shared-key totals across every browser using the site.

Gemini does not publish a portable API for the active project's remaining
quota. Set `GEMINI_DAILY_REQUEST_LIMIT` in `wrangler.toml` to the current RPD
shown in AI Studio. OpenRouter's free-model request allowance is shared by
the three configured `:free` models. Hugging Face's bar uses its monthly
free credit and an estimate based on `x-compute-time`; adjust
`HUGGINGFACE_MONTHLY_CREDIT_USD` and `HUGGINGFACE_USD_PER_SECOND` if the
account allowance or hardware rate changes. Provider billing dashboards
remain authoritative.

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
   - `GEMINI_API_KEY` — your Gemini key (optional; skip to share only the other providers)
   - `HUGGINGFACE_API_KEY` — your Hugging Face key (optional)
   - `OPENROUTER_API_KEY` — a key from <https://openrouter.ai/settings/keys>

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
npx wrangler secret put OPENROUTER_API_KEY
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
- Keep an eye on usage in the Gemini/OpenRouter/Hugging Face dashboards; rotate the key
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

To exercise the weekly purge without waiting for Sunday, `wrangler dev`
exposes the cron trigger on its scheduled endpoint. `time` is a Unix
timestamp in **milliseconds**, so any Sunday 5 PM local can be replayed:

```bash
# 2026-08-02 21:00Z = 5 PM EDT -> purges
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+21,22+*+*+SUN&time=1785704400000"
# 2026-11-15 21:00Z = 4 PM EST -> skipped; 22:00Z = 5 PM EST -> purges
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+21,22+*+*+SUN&time=1794776400000"
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+21,22+*+*+SUN&time=1794780000000"
```

That runs the same code path the real trigger does, including the local-time
check; the decision and the deleted-file counts are logged to the `wrangler
dev` console. `POST /libraries/ppt/purge` skips the schedule entirely. The
pure schedule logic is unit tested in `tests/storage/pptLibraryPurge.test.ts`
(`npm test` in the repo root).
