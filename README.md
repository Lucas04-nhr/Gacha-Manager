# Gacha Metadata API

A Cloudflare Worker that serves public item metadata to a blog's gacha record management page. The frontend sends a game, language and item IDs; the Worker queries the existing D1 database `gacha_meta` and returns names, rarity, types and icons.

This repository handles public metadata queries and maintenance, plus optional **personal remote synchronization** of already saved records. The frontend handles UIGF import/export, link parsing, incremental fetching, display and local storage. Only the authenticated personal sync endpoint accepts UIDs and normalized records. The Worker never accepts cookies, game authkeys, history URLs or uploaded archives. It has no multi-user account system and does not maintain banner schedules.

**Personal sync is for a single owner, using only their own self-deployed Worker and D1 database. Using someone else's Worker URL or token can leak your account information and gacha records.** A token does not make an untrusted server safe: its operator and anyone holding the personal sync token can read, modify and delete all synchronized data. Do not use the public metadata service as a shared personal-storage service or embed a personal token in published frontend code.

## Data sources and architecture

```text
Enka processed store (GI / HSR / ZZZ)
                 ↓
Unified item schema: { id, name, rank, type, icon }
                 ↑
Dimbreath: on-demand completion of missing Enka fields only

Starward public static metadata → Bangboo / Miliastra outfits
Dimbreath outfit configuration + TextMaps → missing Miliastra language names
                 ↓
Existing D1 gacha_meta → Public query API
```

The primary source is the [EnkaNetwork/API-docs processed store](https://github.com/EnkaNetwork/API-docs/tree/master/store). GI uses `gi/avatars.json`, `weapons.json` and `locs.json`; HSR uses `hsr/avatars.json`, `weapons.json` and `hsr.json`; ZZZ uses `zzz/avatars.json`, `weapons.json` and `locs.json`. Only public store files are read; player APIs are not called.

Existing Enka values always take precedence. Dimbreath is accessed only when a name, rank or icon is missing. GI/HSR use the corresponding configuration files and text maps; ZZZ uses verified text maps. HSR's 64-bit text hashes are preserved as exact strings. Text maps are streamed, retaining only the required keys, with a 64 MiB limit. Configuration files are limited to 8 MiB, and Enka/Starward files to 1 MiB. Each request has a 20-second timeout, and redirects are rejected. ZZZ's obfuscated configuration has no reliable fallback mapping for ranks or icons yet, so these fields are never guessed.

If the primary download fails, Dimbreath does not replace the entire source. Entries that remain incomplete after fallback are skipped. Logs contain fixed events, game/language identifiers, fallback counts and unresolved counts, without raw payloads. The primary `source` points to Enka; the `metadata_fallback` event reports how many entries were completed using Dimbreath. Skipping an entry does not delete an existing database row.

Special items follow the public metadata sources used by [Starward](https://github.com/Scighost/Starward):

- **Bangboo:** `https://starward-static.scighost.com/metadata/v1/zzz/ZZZGachaInfo.nap_global.<lang>.json`. Only Bangboo IDs in the `5xxxx` range are imported, with type `bangboo`. Agents and W-Engines remain managed through Enka.
- **Miliastra Wonderland outfits:** `https://starward-static.scighost.com/game-assets/genshin/GenshinBeyondGachaInfo.json`, stored in the separate `hk4e_ugc` table. Starward provides the authoritative Chinese names, ranks and icons under `zh-cn`. For other configured `UPSTREAM_LANGUAGES`, Dimbreath `BeyondCostumeExcelConfigData.json` maps matching `costumeId` values to `nameTextMapHash`, and streamed language TextMaps supply localized names. Chinese values are never overwritten or relabeled. Unmapped related rewards and missing translations are skipped with count-only logs; historical rows are retained. A failed Starward source does not trigger a Dimbreath-only import. Unchanged UGC rows are not rewritten, preserving their `updated_at`; `updated` counts actual inserted or changed rows. Upstream dictionaries are still checked on each sync so corrected translations can be discovered. The list includes outfits and related rewards, using the generic type `ugc_item`. Unnamed entries are skipped.

These public sources change over time and do not guarantee coverage of every gacha item. Enka stores also contain items that are not obtainable through gacha. The API looks up metadata by ID; it does not determine whether an item is available in a current banner.

## Bindings and tables

`wrangler.jsonc` binds the existing database `gacha_meta` as `DB`. D1 stores public metadata and, when explicitly enabled with a personal secret, separate personal records. R2 is not required. Migration `0004_personal_sync.sql` adds `personal_sync_state`, `personal_sync_accounts` and `personal_sync_records`; the four metadata tables remain separate. Old migrations are unchanged.

| `game`     | Separate D1 table  | Content                                      |
| ---------- | ------------------ | -------------------------------------------- |
| `hk4e`     | `genshin_meta`     | Genshin Impact characters and weapons        |
| `hkrpg`    | `starrail_meta`    | Honkai: Star Rail characters and Light Cones |
| `nap`      | `zenless_meta`     | ZZZ agents, W-Engines and Bangboo            |
| `hk4e_ugc` | `genshin_ugc_meta` | Miliastra outfits and related rewards        |

The primary key is `(namespace, kind, lang, entity_id)`. Only `kind=item` is currently maintained. Migration `0003_remove_gacha_type.sql` removes the unused `gacha_type` column and restricts rows to items while preserving existing metadata. Migration `0002_item_details.sql` adds unified type and icon fields. Apply all migrations before deployment.

`ALLOWED_ORIGINS` is a comma-separated allowlist. The checked-in configuration uses `*.lucas04.top, 127.0.0.1, localhost`: the wildcard matches subdomains on HTTP/HTTPS, and the two local host rules allow HTTP/HTTPS on any port (including `http://127.0.0.1:8085`). Complete origins such as `https://blog.example.com` match exactly, including the port; `*` permits all origins. Subdomain rules do not include the bare domain or similarly named domains. Public API requests omit credentials; CORS origin restrictions are not authentication. The admin API uses the separate secret `METADATA_UPDATE_TOKEN`, which must never be included in the blog frontend.

## Personal remote synchronization

仅供个人使用：只能同步到自己部署并管理的 Worker 和 D1。填写他人提供的 Worker 地址或 token，可能导致账号信息和抽卡记录泄漏。服务部署者以及持有 token 的人可以读取、修改或删除全部同步数据。允许的 CORS 来源也必须提供 token。

On your own deployment, apply all migrations and configure a separate secret with [Wrangler secrets](https://developers.cloudflare.com/workers/configuration/secrets/):

```sh
/opt/homebrew/bin/wrangler d1 migrations apply gacha_meta --remote
/opt/homebrew/bin/wrangler secret put PERSONAL_SYNC_TOKEN
/opt/homebrew/bin/wrangler deploy
```

These commands change your remote deployment; local checks do not execute them. Choose a random secret of 32–512 non-whitespace characters. Missing or invalid secrets disable personal sync with 503, without disabling public metadata queries. For local development put a synthetic token in ignored `.dev.vars`. Token rotation changes access credentials, preserves stored records and does not create another owner. `METADATA_UPDATE_TOKEN` is separate, and must never be used by browser clients.

All operations use `POST /api/v1/personal/sync`, `Authorization: Bearer <your-personal-token>` and `Content-Type: application/json`. No URL parameters, cookies, encoded bodies or credentials in URLs. Responses, including reads, use `Cache-Control: no-store`. Browser POST preflight supports only `Authorization` and `Content-Type`; configure `ALLOWED_ORIGINS` for your frontend. `*` alone does not allow browser access to personal sync. There is no token exemption for an allowed origin. Public metadata CORS and server-only admin endpoints keep their existing behavior.

| Action | JSON body fields | Response |
| --- | --- | --- |
| `list` | `action`, optional `limit`, `after` | `{ revision, accounts: [{ game, uid, timezone }], next }` |
| `read` | `action`, `game`, `uid`, optional `limit`, `after` | `{ revision, account: { game, uid, timezone } or null, list: [...], next }` |
| `write` | `action`, `game`, `uid`, `timezone`, `revision`, `list`, optional `delete_ids` | `{ revision }` |
| `delete_account` | `action`, `game`, `uid`, `revision` | `{ revision }` |

`game` is `hk4e`, `hk4e_ugc`, `hkrpg` or `nap`; namespaces are isolated even for the same UID/record ID. UID and all IDs must be decimal **strings**, at most 20 digits. UID, record ID and item ID are normalized with `BigInt` (leading zeros are removed); other raw fields are retained as strings. `timezone` is an integer from -12 to 14. Record fields are allowlisted: required `id`, `item_id`, `time`; optional decimal strings `gacha_type`, `uigf_gacha_type`, `gacha_id`, `count`, `rank_type`, `schedule_id`, `op_gacha_type`. Time must be a valid `YYYY-MM-DD HH:mm:ss` server-local timestamp. Non-UGC records require `gacha_type`; GI additionally requires matching `uigf_gacha_type` (400 maps to 301), HSR requires `gacha_id`, and UGC requires `schedule_id`, `op_gacha_type`, `rank_type`. Provided raw ranks must be GI/HSR 3/4/5, ZZZ 2/3/4, UGC 0–5. Sync stores raw ranks without display conversion, as informed by the [UIGF standard](https://uigf.org/en/standards/uigf.html).

Localized names, item types, language, arbitrary extra fields, authkeys, cookies, URLs and archive objects are rejected. The frontend must prepare normalized saved records rather than upload an entire UIGF archive. `write` creates or updates account metadata, upserts complete records by ID and deletes only explicit `delete_ids`. Omitted records remain stored; account removal deletes its records. Duplicate normalized IDs and overlapping upsert/delete IDs are rejected. Payloads are bounded to 1 MiB and 2000 combined record upserts/deletions per write, with at most 500 records/accounts per read page (default 100). Large histories use multiple write batches and read pages; use each successful write's returned revision for the next batch. Multiple HTTP batches are independent transactions.

`revision` is the global personal-store version, shared across all accounts. It starts at `0` for an untouched store. Each successful write uses a server-generated millisecond UNIX timestamp, `max(Date.now(), previous_revision + 1)`, to remain strictly increasing during same-millisecond writes or clock rollback. Treat it as an opaque synchronization version; do not generate it on the client. Read the remote version before writing and send it unchanged. Version mismatch returns **409 `SYNC_CONFLICT`** with no writes. Re-read and reconcile local changes before retrying; never blindly overwrite with a fresh revision. Account deletion also advances the global version, so stale clients cannot recreate deleted data using an old version.

Reads return `next: null` on the last page. For `list`, pass the returned `game:uid` cursor as `after`; for `read`, pass the returned record ID. Records are ordered by numeric ID without converting IDs to JavaScript numbers. Every page returns the global revision: if it changes between pages, restart the download to obtain a consistent store view. A missing/deleted account returns `account: null` and `list: []`. Writes validate the full payload before submitting a single [D1 transactional batch](https://developers.cloudflare.com/d1/worker-api/d1-database/); revision comparison, record edits and deletion commit together or roll back together.

Example first write after reading `{ "revision": 0, "accounts": [], "next": null }`:

```json
{
  "action": "write",
  "game": "hk4e",
  "uid": "123456789",
  "timezone": 8,
  "revision": 0,
  "list": [{
    "id": "9007199254740993",
    "item_id": "10000003",
    "time": "2026-10-03 12:00:00",
    "gacha_type": "301",
    "uigf_gacha_type": "301",
    "rank_type": "5"
  }],
  "delete_ids": []
}
```

The successful response contains a new timestamp version, for example `{ "revision": 1791028800000 }`. For record deletion, submit `write` with an empty `list` and the IDs in `delete_ids`, using the latest revision. This backend provides storage and conflict detection; frontend sync controls and automatic reconciliation are not implemented in this repository.

## Local development

For local Wrangler operations use `/opt/homebrew/bin/wrangler`. The portable package `build` script remains available for Cloudflare automatic builds; local verification uses the explicit executable below.

Requires Node.js 22.18+ (or a newer version supported by Wrangler) and npm.

```sh
npm ci
/opt/homebrew/bin/wrangler types
npm run check
/opt/homebrew/bin/wrangler d1 migrations apply gacha_meta --local
/opt/homebrew/bin/wrangler dev
/opt/homebrew/bin/wrangler deploy --dry-run --outdir dist
node --test test/*.test.mjs
```

Open `http://localhost:8787/` for the plain-text welcome message and documentation link. Development uses local D1 by default and does not modify the production database. Migrations do not populate metadata; empty tables correctly return `missing_ids`. `npm run build` performs a deployment dry run without publishing the Worker. Tests use local workerd/D1 and mocked upstream sources; test fixtures must not be used in production.

## Public query API

Public queries support `GET`, `HEAD` and `OPTIONS`, without authentication, cookies or user request bodies. Only the documented query parameters are allowed, and each parameter may appear once.

| Path                                                    | Purpose                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `/`                                                     | Plain-text welcome message linking to https://blog.lucas04.top/docs/gacha-manager/backend/ |
| `/api/v1/health`                                        | Check that all four business tables can be queried                                         |
| `/api/v1/games`                                         | Supported games, languages, default language and query limit                               |
| `/api/v1/items?game=hk4e&lang=zh-cn&ids=10000003,11401` | Batch lookup by item ID                                                                    |

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

Errors use `{ "error": { "code": "…", "message": "…" } }` with `no-store`: 400 for invalid parameters, 403 for rejected origins, 404 for unknown endpoints, 405 for unsupported methods, 414 for oversized queries, and 503 for database failures or missing migrations. SQL and raw exceptions are not exposed. Platform logs may still contain request information, so public metadata calls must send public query conditions only. Personal data belongs only in the authenticated sync POST body, never in URLs. Application logs do not include personal payloads, UIDs or tokens; platform request logging still exists.

## Scheduled synchronization and REST updates

The default Cron schedule is `0 3 * * *`, running daily at **03:00 UTC**. Deployment variables:

```json
{
  "UPSTREAM_SYNC_ENABLED": "true",
  "UPSTREAM_LANGUAGES": "[\"en-us\",\"zh-cn\",\"zh-tw\",\"ja-jp\"]",
  "METADATA_FEEDS": "[]"
}
```

`UPSTREAM_SYNC_ENABLED=false` disables built-in sources. The default synchronization languages are English (`en-us`), Simplified Chinese (`zh-cn`), Traditional Chinese (`zh-tw`) and Japanese (`ja-jp`). The language list controls the three games, Bangboo and non-Chinese outfit translations; Starward outfits are always maintained in Simplified Chinese as well. Missing outfit names or mappings are skipped without removing existing translations. Network or invalid-data failures still fail the affected task; missing primary languages for other games also fail their tasks. `METADATA_FEEDS` is a string containing a JSON array of additional normalized feed URLs, empty by default. These feeds run after built-in synchronization and can provide maintainer overrides. Each feed is limited to 2000 rows/1 MiB, with at most eight public HTTPS domain URLs. Credentials, ports, query strings and fragments are rejected. Requests cannot select fetch destinations.

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
/opt/homebrew/bin/wrangler login
/opt/homebrew/bin/wrangler secret put METADATA_UPDATE_TOKEN
/opt/homebrew/bin/wrangler d1 migrations apply gacha_meta --remote
/opt/homebrew/bin/wrangler deploy
```

The public API is available at https://gachameta.lucas04.top/. Documentation is hosted at https://blog.lucas04.top/docs/gacha-manager/backend/. After deployment, check `/api/v1/health`, then call the admin synchronization endpoint to populate metadata and query imported IDs. Cron or configuration changes require redeployment. Deployment credentials and admin tokens must not be committed to Git.

## Acknowledgements

Thank you to the maintainers and contributors of the following projects for the public data and implementation references that made this service possible.

### Data sources

- [Enka.Network API documentation and processed stores](https://github.com/EnkaNetwork/API-docs): the primary source of character and equipment metadata, localizations and icon paths for Genshin Impact, Honkai: Star Rail and Zenless Zone Zero.
- Dimbreath's [AnimeGameData2](https://gitlab.com/Dimbreath/animegamedata2), [TurnBasedGameData](https://gitlab.com/Dimbreath/turnbasedgamedata) and [ZenlessData](https://git.mero.moe/Dimbreath/ZenlessData): configuration files and text maps used to supplement missing Enka fields.
- [Starward](https://github.com/Scighost/Starward), by Scighost and contributors: public static metadata for Bangboo and Miliastra Wonderland outfits, and reference implementations for maintaining these special item categories.

### Inspiration and standards

- [PizzaHelperUnited](https://github.com/pizza-studio/PizzaHelperUnited) and [GachaMetaGenerator](https://github.com/pizza-studio/GachaMetaGenerator), by pizza-studio and contributors: references for gacha metadata organization and generation workflows.
- [hoyo-buddy](https://github.com/seriaati/hoyo-buddy), by seriaati and contributors: a reference for HoYoverse game integrations and gacha data handling.
- [UIGF](https://uigf.org/en/standards/uigf.html): the standard informing this service's game namespaces and raw item field semantics.

The runtime data sources are listed separately from projects consulted for inspiration. This Worker implements its own public metadata API and optional personal record storage; parsing, display, local storage and synchronization reconciliation remain the responsibility of the frontend.

## License

The Gacha Metadata API is licensed under the [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html). The public data sources are subject to their own licenses and terms of use, which may differ from this repository's license. Using the public data sources might require additional attribution or compliance with their respective licenses. 
