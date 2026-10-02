# Repository instructions

## Scope and privacy

This repository is a Cloudflare Workers backend for **public gacha item metadata queries and maintenance only**. The blog frontend owns UIGF file parsing, import/export, record storage, statistics, display and incremental history fetching. Do not implement those features here.

Never accept, store or log player UIDs, account identifiers, cookies, authkeys, user gacha records, uploaded archives or history URLs. Do not introduce account systems, history proxies, user-storage bindings or unauthenticated metadata writes. Blog API callers send only namespace, language and public item IDs. Operator POST updates require the `METADATA_UPDATE_TOKEN` secret and normalized public metadata, and must reject browser origins. Never embed this operator token in the blog frontend. Platform request logging still exists; do not describe the service as having no logs whatsoever.

## Architecture

- `src/index.ts`: HTTP routing, validation, CORS, D1 queries and scheduled entry point.
- `src/update.ts`: authenticated operator updates and scheduled built-in upstream and deployment-configured feed synchronization.
- `src/upstream.ts`: Enka processed stores, lazy Dimbreath field completion and Starward buddy/UGC adapters.
- `src/metadata.mjs` and `src/metadata.d.mts`: shared metadata validation for Worker and offline operator tool, and its type contract. Keep them consistent.
- `src/catalog.json`: namespace-to-table allowlist, languages and query limits, shared with the operator tool.
- `src/page.ts`: static API documentation at `/`; no user-data input forms.
- `migrations/`: versioned D1 schema; do not edit a migration already applied to a shared database.
- `scripts/metadata-sql.mjs`: offline, operator-only public metadata validation and upsert generation.
- `test/`: workerd/Miniflare integration tests. Fixtures contain synthetic rows and must not be loaded into production.
- `wrangler.jsonc`: source of truth for bindings. `worker-configuration.d.ts` is generated with `npm run types`; never edit it manually.

Use the existing D1 database `gacha_meta` bound as `DB`. Do not create a replacement database. Account/database IDs in config are resource identifiers, not secrets. Local development and tests must use local D1; remote access is explicit.

## Data contract

Keep four physically separate tables:

| UIGF namespace | D1 table | Content |
| --- | --- | --- |
| `hk4e` | `genshin_meta` | Genshin wishes |
| `hk4e_ugc` | `genshin_ugc_meta` | Miliastra Wonderland outfit gacha |
| `hkrpg` | `starrail_meta` | Star Rail warps |
| `nap` | `zenless_meta` | Zenless Zone Zero signals |

Only maintain public items (`kind=item`). Keep the historical initial schema compatible, but do not expose a pool schedule API or accept pool writes. The primary key remains `(namespace, kind, lang, entity_id)`. Never merge UGC into normal Genshin metadata.

Keep IDs and raw `rank_type` as strings. GI/HSR raw ranks are 3/4/5; ZZZ raw 2/3/4 maps to display 3/4/5. UGC Starward Rank 1–5 maps directly; 0/unknown is null. Types and icons belong to the unified schema; UGC may contain related rewards, so its generic category is `ugc_item`. Do not fabricate names or icons. Missing IDs and languages are explicit.

Enka processed stores are primary for GI/HSR/ZZZ. Fetch Dimbreath only when Enka fields are missing; never overwrite a present Enka value or silently replace an unavailable primary source. Preserve 64-bit text hashes. Stream large flat localization dictionaries, retain only needed keys and enforce bounded size/time. Starward static metadata separately provides buddies (verified 5xxxx IDs only) and UGC (Chinese only). Skip unnamed/unresolved entries with fixed count logs, retain historical database rows and do not claim complete gacha coverage.
Keep SQL table names exclusively in the static catalog allowlist and bind every request value using prepared statements. Bound query size must remain below D1's SQL parameter limit, including namespace/kind/language parameters. Reject unknown or repeated query parameters. Queries are GET/HEAD, with OPTIONS for CORS. Do not enable credentialed CORS. Origin restrictions are browser controls, not authentication.

Updates use a single D1 batch across affected tables, after full validation. JSON expansion bounds SQL parameters even for large payloads. Enforce 1 MiB/2000-entry HTTP and feed limits. Do not delete rows absent from a feed. Cron fetch URLs are deployment-controlled `METADATA_FEEDS`, never request-provided. Do not follow redirects, forward operator credentials or log payloads, feed URLs, tokens or raw errors. Attempt all configured feeds and report any failure to the scheduled runtime; each feed is atomic, multiple feeds are independent. Empty extra feeds do not disable built-in sources; `UPSTREAM_SYNC_ENABLED=false` disables built-in synchronization. Extra feeds use normalized item metadata.

## Implementation and verification

Use strict TypeScript, two-space indentation, explicit error handling and no `any` or unsafe double casts. Do not keep request-scoped state in module globals. Keep API errors sanitized and avoid logging request URLs, headers, bodies, SQL parameters or raw exceptions. Public successes may have short cache lifetimes; errors must use `no-store`.

Before changing Workers APIs or bindings, consult current official Cloudflare documentation and the installed Wrangler schema. Consult the [UIGF standard](https://uigf.org/en/standards/uigf.html) for namespace/field semantics. Reference repositories inform public metadata conventions; do not copy their account/history backend architecture into this service.

Run `npm ci`, `npm run types`, `npm run check` and `npm test`. Tests build the Worker and execute its HTTP API against local workerd/D1. Add meaningful tests when changing namespace isolation, schema, rank conversion, query validation or operator validation. After config changes, regenerate binding types. Run `git diff --check` for tracked changes.

Do not claim cloud deployment, remote migrations or complete metadata coverage based on local tests. State precisely what was verified. Keep README API examples and the served documentation consistent with actual responses. Preserve unrelated user changes and the existing license.
