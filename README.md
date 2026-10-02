# Gacha Metadata API

A Cloudflare Worker that serves public item metadata to a blog's gacha record management page. The frontend sends a game, language and item IDs; the Worker queries the existing D1 database `gacha_meta` and returns names, rarity, types and icons.

This repository handles public metadata queries and maintenance only. The frontend handles user records, UIGF import/export, link parsing, incremental fetching, display and local storage. The Worker does not accept UIDs, cookies, authkeys, user records or authorization links. It has no account system and does not maintain banner schedules.

## Data sources and architecture

```text
Enka processed store (GI / HSR / ZZZ)
                 ↓
Unified item schema: { id, name, rank, type, icon }
                 ↑
Dimbreath: on-demand completion of missing Enka fields only

Starward public static metadata → Bangboo / Miliastra outfits
                 ↓
Existing D1 gacha_meta → Public query API
```

The primary source is the [EnkaNetwork/API-docs processed store](https://github.com/EnkaNetwork/API-docs/tree/master/store). GI uses `gi/avatars.json`, `weapons.json` and `locs.json`; HSR uses `hsr/avatars.json`, `weapons.json` and `hsr.json`; ZZZ uses `zzz/avatars.json`, `weapons.json` and `locs.json`. Only public store files are read; player APIs are not called.

Existing Enka values always take precedence. Dimbreath is accessed only when a name, rank or icon is missing. GI/HSR use the corresponding configuration files and text maps; ZZZ uses verified text maps. HSR's 64-bit text hashes are preserved as exact strings. Text maps are streamed, retaining only the required keys, with a 64 MiB limit. Configuration files are limited to 8 MiB, and Enka/Starward files to 1 MiB. Each request has a 20-second timeout, and redirects are rejected. ZZZ's obfuscated configuration has no reliable fallback mapping for ranks or icons yet, so these fields are never guessed.

If the primary download fails, Dimbreath does not replace the entire source. Entries that remain incomplete after fallback are skipped. Logs contain fixed events, game/language identifiers, fallback counts and unresolved counts, without raw payloads. The primary `source` points to Enka; the `metadata_fallback` event reports how many entries were completed using Dimbreath. Skipping an entry does not delete an existing database row.

Special items follow the public metadata sources used by [Starward](https://github.com/Scighost/Starward):

- **Bangboo:** `https://starward-static.scighost.com/metadata/v1/zzz/ZZZGachaInfo.nap_global.<lang>.json`. Only Bangboo IDs in the `5xxxx` range are imported, with type `bangboo`. Agents and W-Engines remain managed through Enka.
- **Miliastra Wonderland outfits:** `https://starward-static.scighost.com/game-assets/genshin/GenshinBeyondGachaInfo.json`, stored in the separate `hk4e_ugc` table. The source currently provides Chinese names only, so entries are stored under `zh-cn`, never relabeled as English or another language. The list includes outfits and related rewards, using the generic type `ugc_item`. Unnamed entries are skipped.

These public sources change over time and do not guarantee coverage of every gacha item. Enka stores also contain items that are not obtainable through gacha. The API looks up metadata by ID; it does not determine whether an item is available in a current banner.

## Bindings and tables

`wrangler.jsonc` binds the existing database `gacha_meta` as `DB`. No new database, KV, R2 or Durable Objects are required.

| `game`     | Separate D1 table  | Content                                      |
| ---------- | ------------------ | -------------------------------------------- |
| `hk4e`     | `genshin_meta`     | Genshin Impact characters and weapons        |
| `hkrpg`    | `starrail_meta`    | Honkai: Star Rail characters and Light Cones |
| `nap`      | `zenless_meta`     | ZZZ agents, W-Engines and Bangboo            |
| `hk4e_ugc` | `genshin_ugc_meta` | Miliastra outfits and related rewards        |

The primary key is `(namespace, kind, lang, entity_id)`. Only `kind=item` is currently maintained. Migration `0003_remove_gacha_type.sql` removes the unused `gacha_type` column and restricts rows to items while preserving existing metadata. The API neither queries nor writes banner schedules; `/api/v1/pools` returns 404. Migration `0002_item_details.sql` adds unified type and icon fields. Apply all migrations before deployment.

`ALLOWED_ORIGINS` defaults to `*` and can be changed to a comma-separated list of complete blog origins. Public API requests omit credentials; CORS origin restrictions are not authentication. The admin API uses the separate secret `METADATA_UPDATE_TOKEN`, which must never be included in the blog frontend.

## Local development

All Wrangler commands and npm scripts use the Homebrew-installed `wrangler`.

Requires Node.js 22.18+ (or a newer version supported by Wrangler) and npm.

```sh
npm ci
npm run types
npm run check
npm run db:migrate:local
npm run dev
npm test
```

Open `http://localhost:8787/` for the plain-text welcome message and documentation link. Development uses local D1 by default and does not modify the production database. Migrations do not populate metadata; empty tables correctly return `missing_ids`. `npm run build` performs a deployment dry run without publishing the Worker. Tests use local workerd/D1 and mocked upstream sources; test fixtures must not be used in production.

## Public query API

Public queries support `GET`, `HEAD` and `OPTIONS`, without authentication, cookies or user request bodies. Only the documented query parameters are allowed, and each parameter may appear once.

| Path                                                    | Purpose                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `/`                                                     | Plain-text welcome message linking to https://blog.lucas04.top/docs/gacha-meta/ |
| `/api/v1/health`                                        | Check that all four business tables can be queried                              |
| `/api/v1/games`                                         | Supported games, languages, default language and query limit                    |
| `/api/v1/items?game=hk4e&lang=zh-cn&ids=10000003,11401` | Batch lookup by item ID                                                         |

`game` is required. `lang` defaults to `en-us`. `ids` is required and contains 1–90 decimal string IDs, each up to 20 digits. The service deduplicates IDs and returns results in request order. It does not fall back to another language.

Example response (does not imply these entries have been imported):

```json
{
  "game": "hk4e",
  "lang": "zh-cn",
  "items": [
    {
      "item_id": "10000003",
      "name": "琴",
      "rank_type": "5",
      "rarity": 5,
      "rank": 5,
      "type": "character",
      "item_type": "character",
      "icon": "https://enka.network/ui/UI_AvatarIcon_Side_Qin.png",
      "source": "https://github.com/EnkaNetwork/API-docs/tree/master/store/gi",
      "updated_at": "2026-10-02T03:00:00.000Z"
    }
  ],
  "data": {
    "10000003": {
      "name": "琴",
      "rank": 5,
      "type": "character",
      "icon": "https://enka.network/ui/UI_AvatarIcon_Side_Qin.png"
    }
  },
  "missing_ids": ["11401"]
}
```

`data` is the unified dictionary keyed by ID. `items` also preserves raw ranks, sources and update timestamps. Unified `type` values are `character`, `weapon`, `light_cone`, `w_engine`, `bangboo` and `ugc_item`; manual outfit maintenance also supports `outfit`. Legacy manual rows without a type or icon return `null` for those fields instead of fabricated values.

`rank_type` preserves the raw string. `rank` and `rarity` are display ranks: GI/HSR use 3/4/5; ZZZ raw values 2/3/4 map to display values 3/4/5. The Miliastra source directly provides ranks 1–5; rank 0 or another unknown rank returns `null`. `item_type` is the type text supplied by the maintainer; automatic synchronization uses the unified type value.

Missing IDs appear in `missing_ids`. A query with no matches still returns 200. Chinese outfit queries must explicitly use `lang=zh-cn`. Successful queries are cached for 300 seconds and configuration responses for 3600 seconds, so updates may briefly return cached results.

```js
const params = new URLSearchParams({
  game: "hk4e_ugc",
  lang: "zh-cn",
  ids: publicItemIds.join(","),
});
const response = await fetch(`${metadataApiBase}/api/v1/items?${params}`, {
  credentials: "omit",
});
if (!response.ok) throw new Error(`Metadata API: ${response.status}`);
const { data, missing_ids } = await response.json();
```

Errors use `{ "error": { "code": "…", "message": "…" } }` with `no-store`: 400 for invalid parameters, 403 for rejected origins, 404 for unknown endpoints, 405 for unsupported methods, 414 for oversized queries, and 503 for database failures or missing migrations. SQL and raw exceptions are not exposed. Platform logs may still contain request information, so the frontend must send public query conditions only.

## Scheduled synchronization and REST updates

The default Cron schedule is `0 3 * * *`, running daily at **03:00 UTC**. Deployment variables:

```json
{
  "UPSTREAM_SYNC_ENABLED": "true",
  "UPSTREAM_LANGUAGES": "[\"en-us\",\"zh-cn\"]",
  "METADATA_FEEDS": "[]"
}
```

`UPSTREAM_SYNC_ENABLED=false` disables built-in sources. The language list controls the three games and Bangboo; outfits are always maintained in Chinese only. Sources may not provide every declared language, and a missing language causes that task to fail. `METADATA_FEEDS` is a string containing a JSON array of additional normalized feed URLs, empty by default. These feeds run after built-in synchronization and can provide maintainer overrides. Each feed is limited to 2000 rows/1 MiB, with at most eight public HTTPS domain URLs. Credentials, ports, query strings and fragments are rejected. Requests cannot select fetch destinations.

Each game/language task uses an independent transaction and preserves existing data. A failed source does not prevent subsequent tasks from running; the overall synchronization reports failure, while successful tasks remain committed. Logs contain fixed identifiers and counts only. Admin credentials are not forwarded to upstream sources.

Configure a random production secret of at least 32 characters:

```sh
wrangler secret put METADATA_UPDATE_TOKEN
```

For local development, set the same variable in the ignored `.dev.vars` file. The admin API returns 503 if the secret is missing or its length is outside 32–512 characters. Public queries and Cron do not depend on this token. Admin endpoints are for maintainer scripts/CI only, require `Authorization: Bearer <token>`, reject all browser `Origin` headers and do not enable CORS. Never put real tokens in source code or command history.

- `POST /api/v1/admin/sync`: accepts no request body and immediately runs the same built-in and additional feed synchronization. Success returns `{ "updated": 123, "sources": 9 }`. Failure returns 502 `SYNC_FAILED`; successful tasks have already committed.
- `POST /api/v1/admin/metadata`: requires `Content-Type: application/json` and manually writes normalized public item metadata, limited to 2000 rows/1 MiB. Compressed request bodies are not accepted.

Manual payload:

```json
{
  "source": "https://example.com/public-metadata",
  "entries": [
    {
      "game": "hk4e",
      "lang": "en-us",
      "kind": "item",
      "item_id": "10000003",
      "name": "Jean",
      "item_type": "character",
      "rank_type": "5",
      "type": "character",
      "icon": "https://enka.network/ui/UI_AvatarIcon_Side_Qin.png"
    }
  ]
}
```

The source must be a public HTTPS URL without credentials, a query string or a fragment. `type` and `icon` may be omitted for compatibility with legacy manual payloads; omitting them during an update does not clear existing values. All fields are validated before one atomic D1 batch upsert. User fields, numeric IDs, duplicate keys and invalid ranks are rejected. Rows absent from the request are preserved. Success returns `{ "updated": 1, "updated_at": "…" }`.

Example maintenance script (token injected through the environment):

```js
const response = await fetch(
  `${process.env.GACHA_API_BASE}/api/v1/admin/sync`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GACHA_ADMIN_TOKEN}` },
  },
);
if (!response.ok) throw new Error(`Sync failed: ${response.status}`);
console.log(await response.json());
```

For offline maintenance, run `npm run metadata:sql -- metadata.json metadata.sql` to validate metadata and generate SQL, then import it locally with `wrangler d1 execute gacha_meta --local --file metadata.sql`. The script does not access the network or overwrite an existing output file. Generated `/metadata.sql` at the repository root is ignored; migration and test sources remain under version control.

Test Cron locally:

```sh
wrangler dev --test-scheduled
curl 'http://localhost:8787/cdn-cgi/local/scheduled?cron=0+3+*+*+*'
```

## Cloud deployment

Source code and local verification do not imply that the Worker has been deployed or remote D1 has been modified. Maintainers can deploy with:

```sh
wrangler login
wrangler secret put METADATA_UPDATE_TOKEN
npm run db:migrate:remote
npm run deploy
```

The public API is available at https://gachameta.lucas04.top/. Documentation is hosted at https://blog.lucas04.top/docs/gacha-meta/. After deployment, check `/api/v1/health`, then call the admin synchronization endpoint to populate metadata and query imported IDs. Cron or configuration changes require redeployment. Deployment credentials and admin tokens must not be committed to Git.
