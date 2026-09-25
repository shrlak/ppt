# Shared Recognition Proxy and Library Backend

A minimal Cloudflare Worker that lets everyone using the deployed lyrics app
recognize scores with Gemini / OpenRouter **without each person
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
Browser  ──GET  /lyrics────────▶  Worker (search + scrape) ──▶  allowlisted lyrics sites
Admin   ◀──GET /usage──────────  Worker + Durable Object usage counter
Everyone ◀──GET /settings──────  shared recognition settings (model pool, excluded titles)
Admin    ──POST /settings─────▶  update shared settings (관리자 비밀번호 required)
Everyone ◀──GET /learning/models── measured per-model accuracy (numbers only)
Everyone ◀──GET /learning/memory── title aliases, safe corrections, examples
Admin    ──POST /learning/feedback▶ one verified user correction
Admin    ◀─▶ /learning/corpus──── verified training corpus (metadata + images)
Admin    ──▶ /learning/correction-model── upload / activate / roll back
Everyone ◀──GET /learning/correction-model/:v/resolve/*── model files (app origins)
Everyone ◀──GET /libraries/lyrics── shared user-added lyrics
Admin    ──PUT/DELETE /libraries/lyrics── save or delete lyrics
Browser  ──GET  /wednesday/songs──▶ Worker (search) ──▶ 찬양 PPT hits + signed tokens
Browser  ──POST /wednesday/songs/file▶ Worker downloads that .pptx and relays it
Browser  ──GET  /wednesday/songs/sheets▶ Worker (image search) ──▶ 악보 사진 hits
Browser  ──POST /wednesday/songs/image▶ Worker downloads that image and relays it
Everyone ◀──GET /libraries/wednesday-songs── 수요예배 song titles + source links
Admin    ──PUT/DELETE /libraries/wednesday-songs── save or delete one
Everyone ◀──GET /libraries/praise-english── 찬양집회 Korean + English lyrics, slide by slide
Admin    ──PUT/POST/DELETE /libraries/praise-english── save, merge or delete one
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

### 수요예배 찬양 PPT routes

수요예배 찬양 slides are the 악보 pages of each song's own PowerPoint file, so
the app needs the file itself. A browser cannot fetch one: search result pages
and file hosts send no CORS headers, so the request is refused before it
starts. These two routes do it on its behalf.

`GET /wednesday/songs?title=…` searches the web (the same keyless DuckDuckGo
HTML endpoints the lyrics route uses) for `"<제목> 찬양 ppt"` and returns the
hits, **each with an HMAC-signed token in place of its URL**. That keeps the
`/lyrics` invariant — the browser sends a title, never a URL — so a search
result cannot be swapped for an address of the caller's choosing.

`POST /wednesday/songs/file` takes `{ token }` (or `{ url }`, for an address
the operator pasted) and returns the `.pptx` bytes. Before anything is
fetched: https only, IP literals and `localhost`/`.local`/`.internal` names are
refused outright, the final URL after redirects is re-checked, the transfer is
capped at 25 MB and timed out, and the bytes must actually be a PowerPoint
package (ZIP magic plus a `ppt/presentation.xml` part) — a login page returned
with HTTP 200 is not a deck. A post URL is followed exactly one step to its
`.pptx` attachment, with the post as `Referer` (attachment hosts require it);
the attachment is the link whose address ends in `.pptx`, preferring a file
host we know or the post's own domain, or failing that the link whose visible
text names a `.pptx` (갓피플 and most 자료실 boards hide the file behind a
download script).

`GET /wednesday/songs/sheets?title=…` and `POST /wednesday/songs/image` are the
same pair for **악보 사진**, which is how most Korean worship songs are shared.
Each hit comes back ranked against the title (`scoreSongMatch` in
`src/songPpt.js`): a hit whose own title or file name carries the song is
marked `auto`, and the app attaches those by itself; anything below that is
`review` and is shown to the operator instead of acted on.

The image route works the same way — https only, never an address that
resolves inside, 8 MB cap, the final URL re-checked after redirects, and bytes
that start with the PNG or JPEG magic number, so a 200-with-an-HTML-page is
refused.

**Neither route is gated by a host list**, and that is deliberate. The way a
song is actually found is to search its title and open whichever site comes up
first — 네이버 블로그 one week, 갓피플 or some 티스토리 blog the next, and
악보 images sit on whatever CDN their blog uses. A list would have to name
every 자료실 that has ever hosted a 찬양 PPT, and everything it missed would
come back as "직접 올려 주세요" — the manual work these routes exist to
remove. What makes that safe is the checks above, on **what comes back**: the
response has to be a real PowerPoint package or a real PNG/JPEG, under its
cap, from an address that does not resolve inside. A deployment that wants a
list anyway sets `WEDNESDAY_PPT_HOSTS_ONLY=true` (and
`WEDNESDAY_IMAGE_HOSTS_ONLY=true` for images); off-list hits are then returned
as **links** to open and download by hand.

Because those two routes fetch an outside address and return its bytes, they
also check the `Origin` header against `ALLOWED_ORIGINS` server-side (403
otherwise) instead of leaving that to the browser, so the proxy is not a
general-purpose downloader for anything that finds the URL.

`WEDNESDAY_PPT_HOSTS` (see `wrangler.toml`) is therefore a preference, not a
permission: hits on a host it names — the 네이버 블로그·카페 file hosts,
갓피플 and 티스토리 defaults plus a deployment's own, subdomains included —
are tried before a page that merely shares a word with the title, and hosts
that can never hold a file (streaming, video, wikis) are not fetched at all.
Uploading by hand stays the path that always works, and the only one for a
source that needs a login (네이버 카페), so these routes failing never blocks
a service.

`GET|PUT|DELETE /libraries/wednesday-songs` is the 수요예배 song index: a
title, where its PPT or 악보 came from, and how many slides it made. **Links only, no
files** — it remembers where to find a deck again, so the next week starts
from "open this and download it" rather than from a search. It lives outside
`library:ppt:*`, so the weekly purge below leaves it alone, exactly like the
lyrics library. The week's actual files ride along with that week's PPT-library
entry and are cleared with it.

`GET|PUT|POST|DELETE /libraries/praise-english` is the 찬양집회 bilingual lyrics
library: for each song, its Korean slides and the English printed under each one.
The 찬양집회 page writes to it by itself whenever a song's lyrics settle, and reads
it to fill next year's English. Writes take the administrator password like every
other shared write; deletes leave a tombstone so a stale device cannot bring a song
back. Like the lyrics library it lives outside `library:ppt:*`, so the weekly purge
never touches it.

### Weekly PPT purge (Sunday 5 PM)

The shared PPT library holds one week of material at a time. A cron trigger
deletes **every saved PPT entry and all of its files** each Sunday at 5 PM
`PURGE_TIMEZONE` (default `America/New_York`), so the next week's 콘티 starts
from an empty library. Half-finished uploads go with them. The 곡 (lyrics)
library, the 찬양집회 English-lyrics library (`/libraries/praise-english`), shared
settings, and usage counters are never touched — and neither is any deck saved with
`keep: true` (every 찬양집회 and 수련회 deck), which stays until someone deletes it by hand. The
purge record counts those as `kept`.

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

The `/openrouter` route pins every request to one of the two free vision
models in the pool: NVIDIA Nemotron Nano 12B VL (document intelligence) or
NVIDIA Nemotron 3 Nano Omni 30B (reasoning). The legacy `/nvidia` path remains
as an alias for older deployed clients, but new builds use `/openrouter`. No
request goes directly from the deployed browser to OpenRouter.

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
the configured `:free` models. Provider billing dashboards remain
authoritative.

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
- Keep an eye on usage in the Gemini/OpenRouter dashboards; rotate the key
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


## Learning routes

Recognition improves from corrections a user explicitly verified. The Worker is
the shared store for that; it does no learning itself.

| route | who | what it holds |
| --- | --- | --- |
| `GET /learning/models` | anyone | Per-model accuracy for title, artist, order and lyrics, plus failure rate and sample count. **Numbers only** — the browser does the comparison, so no lyric text or score image is ever stored under these keys. Safe to read from the dashboard. |
| `POST /learning/models/evaluations` | admin | Field scores the client already calculated. Every value must be finite and in `[0,1]`; one out-of-range value could not be averaged back out. |
| `POST /learning/feedback` | admin | One verified correction: the models' answers, the reading consensus produced, and the reading the user saved. The page hash plus the hash of the saved answer is the idempotency key — a deck is re-saved constantly while it is edited, and counting the same evidence twice would inflate every model's sample count. Model accuracy is only updated alongside a record that was newly stored. |
| `GET /learning/memory?title=` | anyone | Title aliases, correction pairs and at most three short before/after snippets. No stored song is returned whole. |
| `GET/PUT /learning/corpus`, `…/manifests`, `…/:id/chunks/:i`, `…/exported`, `DELETE …/:id` | admin | The training corpus: one record per verified page, its saved answers, and the page image in 1 MiB chunks. **Administrator-only in both directions** — this is the only place the proxy keeps score images. |
| `GET/PUT /learning/correction-model`, `…/activate`, `…/rollback`, `…/:v/files/<path>/chunks/:i` | admin | The hand-trained correction model. The proxy re-checks the score gate before a version may go live, so a client that skipped its own check cannot activate a model that made things worse. |
| `GET /learning/correction-model/:version/resolve/<path>` | app origins | The model files themselves, fetched by the browser runtime. Versioned URL, `immutable` caching, restricted to `ALLOWED_ORIGINS`. No training record is reachable through it. |

### Storage caps

| what | cap | what happens at the cap |
| --- | --- | --- |
| tracked models | 100 | a new model key is ignored, so made-up keys cannot grow storage |
| verified corrections | 2000 | oldest first; the corpus is a rolling window, not an archive |
| training images | 300 | **only records already exported** are evicted, oldest first. Over the cap with nothing exported, the corpus is allowed to overflow — evicting an unexported record would silently lose a correction somebody made, and the dashboard surfaces the overflow instead. |
| correction-model versions | 2 | the older of the two is deleted on the next activation, so a rollback target always exists |

**The weekly PPT purge does not touch `learning:*`.** A corpus wiped every
Sunday could never train anything; see `wrangler.toml`.

### Secrets and variables

| name | kind | purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | secret | Gemini free-tier key |
| `OPENROUTER_API_KEY` | secret | OpenRouter key, used only for `:free` vision models |
| `ADMIN_PASSWORD` | secret | Gate on every shared write, including all learning writes |
| `ALLOWED_ORIGINS` | var | Origins allowed to call the proxy, and the only ones allowed to read model files |
| `BUGS_SCRAPING_ALLOWED` | var | `"true"` in this deployment's `wrangler.toml` (the code's default is off). Whether this deployment may read Bugs pages — a permission decision, not a code one. While it is off, a Bugs search hit may be shown to the user as a **link**, but the page is never fetched. There is deliberately no client-side toggle. |

```bash
npx wrangler secret put ADMIN_PASSWORD
# Only after the deployment's administrator actually has permission:
npx wrangler deploy --var BUGS_SCRAPING_ALLOWED:true
```

### Training a correction model (all free)

1. 관리자 설정 → 학습 자료 → **학습 자료 ZIP 내려받기**.
2. Run `notebooks/lyrics-correction-finetune.ipynb` on a free Colab (T4) or
   Kaggle session. It refuses to produce an artifact unless overall accuracy
   improves by at least one point and lyric accuracy does not fall.
3. Check the artifact before uploading:

   ```bash
   npm run validate:correction-model artifacts/lyrics-corrector/lyrics-corrector-v1.zip
   ```

   It verifies every file hash against the manifest, the score gate, the base
   model allowlist and the files the runtime cannot start without, and prints
   the exact version, scores, byte count and SHA-256 values the upload screen
   will show.
4. Upload and activate in 관리자 설정 → 학습. If the model turns out worse in
   practice, **이전 버전으로 되돌리기** switches back in one request.

Artifacts are gitignored (`artifacts/lyrics-corrector/`): they are derived from
copyrighted 악보 and are far too large for git.

### What is not stored

- No score image outside `learning:corpus:*`, which is administrator-only.
- No lyric text in model statistics, in the memory endpoint's counters, or in
  any error message or log line — a provider response body can echo the prompt
  back, and the prompt carries lyrics, so failures are recorded as a
  **category** (`quota`, `rate-limit`, `timeout`, …) and nothing else.
- No third-party lyric text: a web candidate is stored as provenance (which
  page was offered, how it scored), never as its lines.
