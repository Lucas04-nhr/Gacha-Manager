import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { metadataSql } from "../scripts/metadata-sql.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/metadata.json", import.meta.url), "utf8"),
);
fixture.entries = fixture.entries.filter((row) => row.kind === "item");
const migration = (
  await Promise.all(
    ["0001_metadata.sql", "0002_item_details.sql"].map((file) =>
      readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
    ),
  )
).join("\n");
let mf;
let db;
const options = {
  modules: true,
  scriptPath: "dist/index.js",
  compatibilityDate: "2026-10-02",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: "test-gacha" },
  bindings: { ALLOWED_ORIGINS: "*" },
};

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions(options));
  db = await mf.getD1Database("DB");
  for (const sql of migration.split(";").filter((sql) => sql.trim()))
    await db.prepare(sql).run();
  for (const sql of metadataSql(fixture, "2026-10-02T00:00:00.000Z")
    .split("\n")
    .filter((sql) => sql.startsWith("INSERT")))
    await db.prepare(sql).run();
  const cleanup = await readFile(
    new URL("../migrations/0003_remove_gacha_type.sql", import.meta.url),
    "utf8",
  );
  for (const sql of cleanup.split(";").filter((sql) => sql.trim()))
    await db.prepare(sql).run();
});
after(async () => {
  await mf?.dispose();
});

const request = (path, init) =>
  mf.dispatchFetch(`https://worker.test${path}`, init);
const data = async (path) => (await request(path)).json();

test("four business tables and physical namespace isolation", async () => {
  const result = await db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '_cf_%'",
    )
    .all();
  assert.deepEqual(result.results.map((row) => row.name).sort(), [
    "genshin_meta",
    "genshin_ugc_meta",
    "starrail_meta",
    "zenless_meta",
  ]);
  await assert.rejects(
    db.prepare("INSERT INTO genshin_meta SELECT * FROM genshin_ugc_meta").run(),
  );
  for (const table of [
    "genshin_meta",
    "genshin_ugc_meta",
    "starrail_meta",
    "zenless_meta",
  ]) {
    const columns = await db.prepare(`PRAGMA table_info(${table})`).all();
    assert.equal(
      columns.results.some((column) => column.name === "gacha_type"),
      false,
    );
  }
  const standard = await data(
    "/api/v1/items?game=hk4e&lang=zh-cn&ids=10000003",
  );
  const costume = await data(
    "/api/v1/items?game=hk4e_ugc&lang=zh-cn&ids=10000003",
  );
  assert.equal(standard.items[0].name, "琴");
  assert.equal(costume.items[0].name, "测试衣装");
  assert.equal(costume.items[0].rank_type, "7");
  assert.equal(costume.items[0].rarity, null);
});

test("batch IDs stay strings, deduplicate, preserve order and explicitly report missing", async () => {
  const result = await data(
    "/api/v1/items?game=hk4e&lang=zh-cn&ids=11401,10000003,11401,99999999999999999999",
  );
  assert.deepEqual(
    result.items.map((item) => item.item_id),
    ["11401", "10000003"],
  );
  assert.deepEqual(result.missing_ids, ["99999999999999999999"]);
  assert.equal(result.items[1].rank_type, "5");
  assert.equal(result.items[1].rarity, 5);
});

test("requested language is exact and never silently falls back", async () => {
  assert.equal(
    (await data("/api/v1/items?game=hk4e&ids=10000003")).items[0].name,
    "Jean",
  );
  assert.equal(
    (await data("/api/v1/items?game=hk4e&lang=en-us&ids=10000003")).items[0]
      .name,
    "Jean",
  );
  const missing = await data("/api/v1/items?game=hk4e&lang=ja-jp&ids=10000003");
  assert.deepEqual(missing.items, []);
  assert.deepEqual(missing.missing_ids, ["10000003"]);
});

test("ZZZ original rank is distinct from display rarity", async () => {
  const item = (await data("/api/v1/items?game=nap&lang=zh-cn&ids=1001"))
    .items[0];
  assert.equal(item.rank_type, "4");
  assert.equal(item.rarity, 5);
  assert.equal(
    (await data("/api/v1/items?game=hkrpg&lang=zh-cn&ids=1001")).items[0]
      .rarity,
    4,
  );
});

test("bounded batch query supports exactly 90 IDs", async () => {
  const ids = Array.from({ length: 90 }, (_, i) => String(i + 1));
  assert.equal(
    (await request(`/api/v1/items?game=hk4e&lang=zh-cn&ids=${ids.join(",")}`))
      .status,
    200,
  );
  assert.equal(
    (
      await request(
        `/api/v1/items?game=hk4e&lang=zh-cn&ids=${[...ids, "91"].join(",")}`,
      )
    ).status,
    400,
  );
});

test("reject invalid, repeated, sensitive and injection-shaped parameters", async () => {
  for (const query of [
    "game=bad&ids=1",
    "game=hk4e",
    "game=hk4e&lang=bad&ids=1",
    "game=hk4e&ids=1,,2",
    "game=hk4e&ids=-1",
    "game=hk4e&ids=1e3",
    "game=hk4e&ids=1&ids=2",
    "game=hk4e&game=nap&ids=1",
    "game=hk4e&ids=1&uid=123",
    "game=hk4e&ids=1%27%3BDELETE%20FROM%20genshin_meta",
    "game=hk4e&ids=123456789012345678901",
  ]) {
    const response = await request(`/api/v1/items?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(
    (await request(`/api/v1/items?${"x".repeat(4097)}`)).status,
    414,
  );
});

test("public CORS, preflight, methods, HEAD and webpage", async () => {
  const response = await request("/api/v1/games", {
    headers: { Origin: "https://blog.test" },
  });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
  assert.equal(response.headers.get("Vary"), "Origin");
  assert.equal(
    (
      await request("/api/v1/items", {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "GET" },
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await request("/api/v1/items", {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "POST" },
      })
    ).status,
    405,
  );
  assert.equal(
    (await request("/api/v1/items", { method: "POST", body: "{}" })).status,
    405,
  );
  assert.equal((await request("/unknown")).status, 404);
  assert.equal((await request("/api/v1/health?authkey=secret")).status, 400);
  const head = await request(
    "/api/v1/items?game=hk4e&lang=zh-cn&ids=10000003",
    { method: "HEAD" },
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const page = await request("/");
  assert.equal(page.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.equal(
    await page.text(),
    "Welcome to Gacha Metadata API hosted by Lucas04-nhr! See https://blog.lucas04.top/docs/gacha-manager/backend/ for documentation.",
  );
  assert.match(
    page.headers.get("Content-Security-Policy"),
    /default-src 'none'/,
  );
});

test("config reports supported namespaces, not claims of data completeness", async () => {
  assert.deepEqual((await data("/api/v1/games")).games.sort(), [
    "hk4e",
    "hk4e_ugc",
    "hkrpg",
    "nap",
  ]);
  assert.equal((await request("/api/v1/health")).status, 200);
});

test("origin allowlist rejects unlisted browser origins", async () => {
  const restricted = new Miniflare(
    convertV4MiniflareOptions({
      ...options,
      bindings: { ALLOWED_ORIGINS: "https://blog.test, https://second.test" },
    }),
  );
  try {
    const blocked = await restricted.dispatchFetch(
      "https://worker.test/api/v1/games",
      { headers: { Origin: "https://bad.test" } },
    );
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("Access-Control-Allow-Origin"), null);
    const allowed = await restricted.dispatchFetch(
      "https://worker.test/api/v1/games",
      { headers: { Origin: "https://blog.test" } },
    );
    assert.equal(allowed.status, 200);
    assert.equal(
      allowed.headers.get("Access-Control-Allow-Origin"),
      "https://blog.test",
    );
  } finally {
    await restricted.dispose();
  }
});

test("hostname rules allow local ports and bounded subdomains for GET, HEAD and preflight", async () => {
  const restricted = new Miniflare(convertV4MiniflareOptions({
    ...options,
    bindings: { ALLOWED_ORIGINS: "*.lucas04.top, 127.0.0.1, localhost" },
  }));
  try {
    for (const origin of ["http://127.0.0.1:8085", "http://localhost:8085", "https://localhost:3000", "https://blog.lucas04.top", "https://nested.blog.lucas04.top"]) {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        const response = await restricted.dispatchFetch("https://worker.test/api/v1/games", {
          method,
          headers: { Origin: origin, ...(method === "OPTIONS" ? { "Access-Control-Request-Method": "GET" } : {}) },
        });
        assert.equal(response.status, method === "OPTIONS" ? 204 : 200);
        assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
        assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
        assert.equal(response.headers.get("Vary"), "Origin");
      }
    }
    for (const origin of ["https://lucas04.top", "https://evillucas04.top", "https://blog.lucas04.top.evil.test", "http://localhost.evil.test:8085", "http://127.0.0.2:8085", "http://127.0.0.1:8085/path", "http://user@localhost:8085", "ftp://localhost", "null"]) {
      const response = await restricted.dispatchFetch("https://worker.test/api/v1/games", { headers: { Origin: origin } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
    const admin = await restricted.dispatchFetch("https://worker.test/api/v1/admin/metadata", {
      method: "POST", headers: { Origin: "http://127.0.0.1:8085" },
    });
    assert.equal(admin.status, 503);
    assert.equal(admin.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:8085");
  } finally {
    await restricted.dispose();
  }
});

test("missing schema yields sanitized 503 instead of pretending the item is unknown", async () => {
  const empty = new Miniflare(
    convertV4MiniflareOptions({
      ...options,
      d1Databases: { DB: "empty-database" },
    }),
  );
  try {
    for (const path of [
      "/api/v1/health",
      "/api/v1/items?game=hk4e&lang=zh-cn&ids=1",
    ]) {
      const response = await empty.dispatchFetch(`https://worker.test${path}`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "Metadata database is unavailable.",
        },
      });
    }
  } finally {
    await empty.dispose();
  }
});

test("operator upserts retain historical rows and safely escape names", async () => {
  const update = {
    source: fixture.source,
    entries: [{ ...fixture.entries[0], name: "Jean's name; not SQL" }],
  };
  const sql = metadataSql(update, "2026-10-02T01:00:00.000Z");
  await db
    .prepare(sql.split("\n").find((line) => line.startsWith("INSERT")))
    .run();
  assert.equal(
    (await data("/api/v1/items?game=hk4e&lang=zh-cn&ids=10000003")).items[0]
      .name,
    "Jean's name; not SQL",
  );
  assert.equal(
    (await data("/api/v1/items?game=hk4e&lang=en-us&ids=10000003")).items[0]
      .name,
    "Jean",
  );
  assert.equal(
    (await data("/api/v1/items?game=hkrpg&lang=zh-cn&ids=1001")).items.length,
    1,
  );
});

test("operator input refuses user data, numeric IDs, duplicate keys and invalid ranks", () => {
  for (const row of [
    { ...fixture.entries[0], uid: "123" },
    { ...fixture.entries[0], item_id: 10000003 },
    { ...fixture.entries[0], rank_type: "2" },
    { ...fixture.entries[0], game: "__proto__" },
  ]) {
    assert.throws(() =>
      metadataSql({ source: fixture.source, entries: [row] }),
    );
  }
  assert.throws(() =>
    metadataSql({
      ...fixture,
      entries: [fixture.entries[0], fixture.entries[0]],
    }),
  );
  assert.throws(() => metadataSql({ ...fixture, authkey: "secret" }));
  assert.throws(() =>
    metadataSql({ ...fixture, source: "https://example.com?authkey=secret" }),
  );
});
