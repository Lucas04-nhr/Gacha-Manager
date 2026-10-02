# Repository instructions

## Scope and privacy

This repository is a Cloudflare Workers backend for **public gacha item and pool metadata queries and maintenance only**. The blog frontend owns UIGF file parsing, import/export, record storage, statistics, display and incremental history fetching. Do not implement those features here.

Never accept, store or log player UIDs, account identifiers, cookies, authkeys, user gacha records, uploaded archives or history URLs. Do not introduce account systems, history proxies, user-storage bindings or unauthenticated metadata writes. Blog API callers send only namespace, language and public item/pool IDs. Operator POST updates require the `METADATA_UPDATE_TOKEN` secret and normalized public metadata, and must reject browser origins. Never embed this operator token in the blog frontend. Platform request logging still exists; do not describe the service as having no logs whatsoever.

## Architecture

- `src/index.ts`: HTTP routing, validation, CORS, D1 queries and scheduled entry point.
- `src/update.ts`: authenticated operator updates and deployment-configured scheduled feed synchronization.
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

Each table distinguishes `kind=item` and `kind=pool`. The primary key is `(namespace, kind, lang, entity_id)`. Do not merge the outfit table into normal Genshin metadata. Never interpret a pool's category (`gacha_type`) as its schedule ID (`pool_id`). For outfits, `pool_id` corresponds to `schedule_id` and `gacha_type` to `op_gacha_type`.

Keep IDs and `rank_type` as strings. Ordinary Genshin and Star Rail raw ranks are 3/4/5. ZZZ raw ranks are 2/3/4, with display `rarity` equal to the raw rank plus one. Preserve outfit ranks as decimal strings; return `rarity: null` until a verified display mapping exists. Never fabricate rarity, names, types or pool identities. Unknown IDs return in `missing_ids`; language queries do not silently fall back. Preserve historical pool metadata during updates.

Keep SQL table names exclusively in the static catalog allowlist and bind every request value using prepared statements. Bound query size must remain below D1's SQL parameter limit, including namespace/kind/language parameters. Reject unknown or repeated query parameters. Queries are GET/HEAD, with OPTIONS for CORS. Do not enable credentialed CORS. Origin restrictions are browser controls, not authentication.

Updates use a single D1 batch across affected tables, after full validation. JSON expansion bounds SQL parameters even for large payloads. Enforce 1 MiB/2000-entry HTTP and feed limits. Do not delete rows absent from a feed. Cron fetch URLs are deployment-controlled `METADATA_FEEDS`, never request-provided. Do not follow redirects, forward operator credentials or log payloads, feed URLs, tokens or raw errors. Attempt all configured feeds and report any failure to the scheduled runtime; each feed is atomic, multiple feeds are independent. Empty feeds disable sync. Metadata producers must normalize upstream data to the documented schema; do not claim automatic coverage of all raw upstream APIs.

## Implementation and verification

Use strict TypeScript, two-space indentation, explicit error handling and no `any` or unsafe double casts. Do not keep request-scoped state in module globals. Keep API errors sanitized and avoid logging request URLs, headers, bodies, SQL parameters or raw exceptions. Public successes may have short cache lifetimes; errors must use `no-store`.

Before changing Workers APIs or bindings, consult current official Cloudflare documentation and the installed Wrangler schema. Consult the [UIGF standard](https://uigf.org/en/standards/uigf.html) for namespace/field semantics. Reference repositories inform public metadata conventions; do not copy their account/history backend architecture into this service.

Run `npm ci`, `npm run types`, `npm run check` and `npm test`. Tests build the Worker and execute its HTTP API against local workerd/D1. Add meaningful tests when changing namespace isolation, schema, rank conversion, query validation or operator validation. After config changes, regenerate binding types. Run `git diff --check` for tracked changes.

Do not claim cloud deployment, remote migrations or complete metadata coverage based on local tests. State precisely what was verified. Keep README API examples and the served documentation consistent with actual responses. Preserve unrelated user changes and the existing license.
