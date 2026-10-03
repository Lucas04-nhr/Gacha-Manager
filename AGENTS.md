# Repository instructions

## Scope and privacy

This repository is a Cloudflare Workers backend for **public gacha item metadata queries and maintenance, plus optional personal remote record synchronization**. The blog frontend owns UIGF parsing, import/export, local storage, statistics, display and incremental history fetching. Do not implement those frontend features here.

Public metadata callers send only namespace, language and public item IDs. Only the authenticated personal sync endpoint may accept player UIDs and normalized saved records, stored separately in personal tables. Personal synchronization is single-owner only, against the owner's self-deployed Worker and D1. Warn that using someone else's endpoint or token risks leaking account information and records; the operator and token holders can read and modify all synchronized data. Never accept cookies, authkeys, uploaded archives or history URLs; never log UIDs, tokens or records. Do not introduce multi-user account systems, history proxies or unauthenticated metadata writes. Operator POST metadata updates require `METADATA_UPDATE_TOKEN`, including requests from allowed browser origins. Admin metadata and sync endpoints support POST/OPTIONS under `ALLOWED_ORIGINS`, with Authorization and Content-Type preflight headers. Operators may enter their own token manually in trusted browser tools; never embed that operator token in published frontend code. Platform request logging still exists; do not claim the service has no logs.

## Architecture

- `src/index.ts`: HTTP routing, validation, CORS, D1 queries and authenticated personal-sync routing.
- `src/update.ts`: authenticated operator updates and manual built-in upstream and deployment-configured feed synchronization.
- `src/personal-sync.ts`: token-authenticated, version-checked personal account/record CRUD; no history fetching or UIGF archive parsing.
- `src/upstream.ts`: Enka processed stores, lazy Dimbreath field completion and Starward buddy/UGC adapters.
- `src/metadata.mjs` and `src/metadata.d.mts`: shared metadata validation for Worker and offline operator tool, and its type contract. Keep them consistent.
- `src/catalog.json`: namespace-to-table allowlist, languages and query limits, shared with the operator tool.
- `src/page.ts`: exact plain-text welcome message at `/`, linking to the external documentation; no HTML or user-data forms.
- `migrations/`: versioned D1 schema; do not edit a migration already applied to a shared database.
- `.github/workflows/metadata-sync.yml`: daily/manual public metadata download, validation and D1 upload; no Worker Cron.
- `scripts/metadata-sql.mjs`: offline, operator-only public metadata validation and upsert generation.
- `test/`: workerd/Miniflare integration tests. Fixtures contain synthetic rows and must not be loaded into production.
- `wrangler.jsonc`: source of truth for bindings. `worker-configuration.d.ts` is generated with `npm run types`; never edit it manually.

Use the existing D1 database `gacha_meta` bound as `DB`. Do not create a replacement database. Account/database IDs in config are resource identifiers, not secrets. Local development and tests must use local D1; remote access is explicit.

Personal sync uses separate `personal_sync_state`, `personal_sync_accounts` and `personal_sync_records` tables. Its global revision is a server-generated millisecond UNIX timestamp (initially 0), strictly increasing via `MAX(previous + 1, now)`. Every write compares the last-read revision and atomically commits or returns 409. Account deletion advances the version; never automatically retry stale writes without reconciliation. Keep tokens mandatory for allowed CORS origins. Requests are limited to 1 MiB and 2000 record operations, and reads to 500 entries per page. Accept only the documented normalized record fields, never arbitrary JSON or archives. Frontend synchronization controls remain out of scope here.

## Data contract

Keep four physically separate tables:

| UIGF namespace | D1 table | Content |
| --- | --- | --- |
| `hk4e` | `genshin_meta` | Genshin wishes |
| `hk4e_ugc` | `genshin_ugc_meta` | Miliastra Wonderland outfit gacha |
| `hkrpg` | `starrail_meta` | Star Rail warps |
| `nap` | `zenless_meta` | Zenless Zone Zero signals |

Only maintain public items (`kind=item`). Do not expose a pool schedule API or accept pool writes. Migration 0003 removes `gacha_type` by rebuilding the tables while retaining every item row. Do not modify already-applied migrations. The primary key remains `(namespace, kind, lang, entity_id)`. Never merge UGC into normal Genshin metadata.

Keep IDs and raw `rank_type` as strings. GI/HSR raw ranks are 3/4/5; ZZZ raw 2/3/4 maps to display 3/4/5. UGC Starward Rank 1–5 maps directly; 0/unknown is null. Types and icons belong to the unified schema; UGC may contain related rewards, so its generic category is `ugc_item`. Do not fabricate names or icons. Missing IDs and languages are explicit.

Enka processed stores are primary for GI/HSR/ZZZ. Fetch Dimbreath only when Enka fields are missing; never overwrite a present Enka value or silently replace an unavailable primary source. Preserve 64-bit text hashes. Stream large flat localization dictionaries, retain only needed keys and enforce bounded size/time. Starward static metadata separately provides buddies (verified 5xxxx IDs only) and UGC (Chinese only). Skip unnamed/unresolved entries with fixed count logs, retain historical database rows and do not claim complete gacha coverage.
Keep metadata SQL table names exclusively in the static catalog allowlist; personal sync uses fixed literal table names. Bind every request value using prepared statements. Bound query size must remain below D1's SQL parameter limit, including namespace/kind/language parameters. Reject unknown or repeated query parameters. Public queries are GET/HEAD; personal CRUD uses authenticated POST, with OPTIONS for CORS. Personal sync requires a token even for allowed origins and rejects wildcard-only browser access. Do not enable credentialed CORS. Origin restrictions are browser controls, not authentication.

Updates use a single D1 batch across affected tables, after full validation. JSON expansion bounds SQL parameters even for large payloads. Enforce 1 MiB/2000-entry HTTP and feed limits. Do not delete rows absent from a feed. Manual admin feed URLs are deployment-controlled `METADATA_FEEDS`, never request-provided. Do not follow redirects, forward operator credentials or log payloads, feed URLs, tokens or raw errors. Attempt all configured feeds and report any failure to the admin caller; each feed is atomic, multiple feeds are independent. Empty extra feeds do not disable built-in sources; `UPSTREAM_SYNC_ENABLED=false` disables built-in synchronization. Extra feeds use normalized item metadata.

## Wrangler executable

For local Wrangler operations, explicitly use the Homebrew-installed `/opt/homebrew/bin/wrangler`, including deployment, migrations, secrets, development, dry-run builds and type generation. Exception: keep the package.json `build` script as portable `wrangler deploy --dry-run --outdir dist`, because Cloudflare automatic builds cannot access a macOS Homebrew path. For local test verification, run `/opt/homebrew/bin/wrangler deploy --dry-run --outdir dist` followed by `node --test test/*.test.mjs` rather than invoking the portable build script.

## Implementation and verification

Use strict TypeScript, two-space indentation, explicit error handling and no `any` or unsafe double casts. Do not keep request-scoped state in module globals. Keep API errors sanitized and avoid logging request URLs, headers, bodies, SQL parameters or raw exceptions. Public successes may have short cache lifetimes; errors must use `no-store`.

Before changing Workers APIs or bindings, consult current official Cloudflare documentation and the installed Wrangler schema. Consult the [UIGF standard](https://uigf.org/en/standards/uigf.html) for namespace/field semantics. Reference repositories inform public metadata conventions; do not copy their account/history backend architecture into this service.

Run `npm ci`, `npm run types`, `npm run check` and `npm test`. Tests build the Worker and execute its HTTP API against local workerd/D1. Add meaningful tests when changing namespace isolation, schema, rank conversion, query validation or operator validation. After config changes, regenerate binding types. Run `git diff --check` for tracked changes.

Do not claim cloud deployment, remote migrations or complete metadata coverage based on local tests. State precisely what was verified. Keep README API examples and the served documentation consistent with actual responses. Preserve unrelated user changes and the existing license.
