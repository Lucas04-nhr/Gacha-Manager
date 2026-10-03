import catalog from './catalog.json';
import { readJson, UpdateError } from './update';

const maxEntries = 2000;
const maxPage = 500;
type ObjectValue = Record<string, unknown>;
interface State { revision: number; commit_id: string }
interface Account { game: string; uid: string; timezone: number }
interface StoredRecord { id: string; record: string }

function invalid(): never {
  throw new UpdateError(400, 'INVALID_SYNC', 'Invalid personal sync payload; see the documented schema and limits.');
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as ObjectValue;
}

function keys(value: ObjectValue, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) invalid();
  return BigInt(value).toString();
}

function pageLimit(value: unknown): number {
  if (value === undefined) return 100;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maxPage) invalid();
  return value;
}

function record(value: unknown, game: string): ObjectValue {
  const row = object(value);
  const decimalFields = ['gacha_type', 'uigf_gacha_type', 'gacha_id', 'count', 'rank_type', 'schedule_id', 'op_gacha_type'];
  keys(row, ['id', 'item_id', 'time', ...decimalFields]);
  const result: ObjectValue = { id: id(row.id), item_id: id(row.item_id), time: row.time };
  if (typeof row.time !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.time)) invalid();
  const date = new Date(row.time.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19).replace('T', ' ') !== row.time) invalid();
  for (const field of decimalFields) {
    if (row[field] !== undefined) {
      id(row[field]); // Keep raw public rank/pool fields as strings.
      result[field] = row[field];
    }
  }
  if (row.rank_type !== undefined) {
    const ranks = game === 'nap' ? ['2', '3', '4'] : game === 'hk4e_ugc' ? ['0', '1', '2', '3', '4', '5'] : ['3', '4', '5'];
    if (!ranks.includes(String(row.rank_type))) invalid();
  }
  if (game === 'hk4e_ugc') {
    if (row.schedule_id === undefined || row.op_gacha_type === undefined || row.rank_type === undefined) invalid();
  } else {
    if (row.gacha_type === undefined) invalid();
    if (game === 'hk4e' && row.uigf_gacha_type !== (row.gacha_type === '400' ? '301' : row.gacha_type)) invalid();
    if (game === 'hkrpg' && row.gacha_id === undefined) invalid();
  }
  return result;
}

function json(value: unknown): Response {
  return Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
}

// No module-global cache: every authenticated request checks its own D1 binding.
async function ensurePersonalSchema(db: D1Database): Promise<void> {
  const tables = await db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('personal_sync_state', 'personal_sync_accounts', 'personal_sync_records')").all<{ name: string }>();
  if (tables.results.length === 3) {
    const state = await db.prepare('SELECT singleton FROM personal_sync_state WHERE singleton = 1').first();
    if (state) return;
  }
  // Concurrent first requests are safe; never replace an existing revision or record.
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS personal_sync_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      commit_id TEXT NOT NULL
    )`),
    db.prepare("INSERT OR IGNORE INTO personal_sync_state VALUES (1, 0, '')"),
    db.prepare(`CREATE TABLE IF NOT EXISTS personal_sync_accounts (
      game TEXT NOT NULL CHECK (game IN ('hk4e', 'hk4e_ugc', 'hkrpg', 'nap')),
      uid TEXT NOT NULL,
      timezone INTEGER NOT NULL CHECK (timezone BETWEEN -12 AND 14),
      PRIMARY KEY (game, uid)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS personal_sync_records (
      game TEXT NOT NULL,
      uid TEXT NOT NULL,
      id TEXT NOT NULL,
      record TEXT NOT NULL CHECK (json_valid(record)),
      PRIMARY KEY (game, uid, id),
      FOREIGN KEY (game, uid) REFERENCES personal_sync_accounts(game, uid) ON DELETE CASCADE
    )`),
  ]);
}

export async function personalSyncRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') throw new UpdateError(405, 'METHOD_NOT_ALLOWED', 'Personal sync supports POST only.');
  const token = env.PERSONAL_SYNC_TOKEN;
  if (!token || !/^[^\s]{32,512}$/.test(token)) {
    throw new UpdateError(503, 'PERSONAL_SYNC_DISABLED', 'Configure a personal sync secret of 32–512 non-whitespace characters.');
  }
  const supplied = /^Bearer ([^\s]{1,512})$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
  const encoder = new TextEncoder();
  const hashes = await Promise.all([token, supplied].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  if (!hashes[0] || !hashes[1] || !crypto.subtle.timingSafeEqual(hashes[0], hashes[1])) {
    throw new UpdateError(401, 'UNAUTHORIZED', 'A valid personal sync Bearer token is required.');
  }
  if (request.headers.has('Content-Encoding') || request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new UpdateError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send unencoded application/json.');
  }
  const input = object(await readJson(request.body));
  const db = env.DB;
  await ensurePersonalSchema(db);
  const stateQuery = db.prepare('SELECT revision, commit_id FROM personal_sync_state WHERE singleton = 1');
  if (input.action === 'list') {
    keys(input, ['action', 'after', 'limit']);
    const limit = pageLimit(input.limit);
    const after = input.after ?? '';
    if (typeof after !== 'string' || (after !== '' && !/^(hk4e|hk4e_ugc|hkrpg|nap):\d{1,20}$/.test(after))) invalid();
    const [state, accounts] = await db.batch<State | Account>([stateQuery, db.prepare(
      "SELECT game, uid, timezone FROM personal_sync_accounts WHERE game || ':' || uid > ? ORDER BY game || ':' || uid LIMIT ?",
    ).bind(after, limit + 1)]);
    const rows = accounts?.results as Account[] | undefined;
    if (!state?.results[0] || !rows) throw new Error('Sync schema unavailable');
    if (!('revision' in state.results[0])) throw new Error('Sync schema unavailable');
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return json({ revision: state.results[0].revision, accounts: page, next: rows.length > limit && last ? `${last.game}:${last.uid}` : null });
  }
  if (typeof input.game !== 'string' || !Object.hasOwn(catalog.games, input.game)) invalid();
  const game = input.game;
  const uid = id(input.uid);
  if (input.action === 'read') {
    keys(input, ['action', 'game', 'uid', 'after', 'limit']);
    const after = input.after === undefined ? '' : id(input.after).padStart(20, '0');
    const limit = pageLimit(input.limit);
    const [state, accounts, records] = await db.batch<State | Account | StoredRecord>([
      stateQuery,
      db.prepare('SELECT game, uid, timezone FROM personal_sync_accounts WHERE game = ? AND uid = ?').bind(game, uid),
      db.prepare('SELECT id, record FROM personal_sync_records WHERE game = ? AND uid = ? AND id > ? ORDER BY id LIMIT ?').bind(game, uid, after, limit + 1),
    ]);
    const rows = records?.results as StoredRecord[] | undefined;
    if (!state?.results[0] || !rows) throw new Error('Sync schema unavailable');
    if (!('revision' in state.results[0])) throw new Error('Sync schema unavailable');
    const page = rows.slice(0, limit);
    return json({ revision: state.results[0].revision, account: accounts?.results[0] ?? null,
      list: page.map(row => JSON.parse(row.record) as unknown), next: rows.length > limit ? page.at(-1)?.id.replace(/^0+(?=\d)/, '') : null });
  }
  if (input.action !== 'write' && input.action !== 'delete_account') invalid();
  keys(input, input.action === 'write' ? ['action', 'game', 'uid', 'revision', 'timezone', 'list', 'delete_ids'] : ['action', 'game', 'uid', 'revision']);
  if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision >= Number.MAX_SAFE_INTEGER) invalid();
  const revision = input.revision;
  const commit = crypto.randomUUID();
  const guard = 'EXISTS (SELECT 1 FROM personal_sync_state WHERE singleton = 1 AND commit_id = ?)';
  // Server time, monotonically increasing even during same-millisecond writes or clock rollback.
  const statements = [db.prepare('UPDATE personal_sync_state SET revision = MAX(revision + 1, ?), commit_id = ? WHERE singleton = 1 AND revision = ?')
    .bind(Date.now(), commit, revision)];
  if (input.action === 'delete_account') {
    statements.push(db.prepare(`DELETE FROM personal_sync_accounts WHERE game = ? AND uid = ? AND ${guard}`).bind(game, uid, commit));
  } else {
    if (typeof input.timezone !== 'number' || !Number.isInteger(input.timezone) || input.timezone < -12 || input.timezone > 14
      || !Array.isArray(input.list) || !Array.isArray(input.delete_ids ?? [])) invalid();
    const deletes = input.delete_ids === undefined ? [] : input.delete_ids;
    if (!Array.isArray(deletes) || input.list.length + deletes.length > maxEntries) invalid();
    const rows = input.list.map((value: unknown) => record(value, game));
    const deleteIds = deletes.map((value: unknown) => id(value).padStart(20, '0'));
    const rowIds = rows.map(row => id(row.id).padStart(20, '0'));
    if (new Set(rowIds).size !== rowIds.length || new Set(deleteIds).size !== deleteIds.length || rowIds.some(value => deleteIds.includes(value))) invalid();
    statements.push(db.prepare(`INSERT INTO personal_sync_accounts (game, uid, timezone)
      SELECT ?, ?, ? WHERE ${guard}
      ON CONFLICT (game, uid) DO UPDATE SET timezone = excluded.timezone`).bind(game, uid, input.timezone, commit));
    statements.push(db.prepare(`DELETE FROM personal_sync_records WHERE game = ? AND uid = ? AND id IN (SELECT value FROM json_each(?)) AND ${guard}`)
      .bind(game, uid, JSON.stringify(deleteIds), commit));
    statements.push(db.prepare(`INSERT INTO personal_sync_records (game, uid, id, record)
      SELECT ?, ?, json_extract(value, '$.key'), json_extract(value, '$.record') FROM json_each(?) WHERE ${guard}
      ON CONFLICT (game, uid, id) DO UPDATE SET record = excluded.record`)
      .bind(game, uid, JSON.stringify(rows.map((row, index) => ({ key: rowIds[index], record: JSON.stringify(row) }))), commit));
  }
  statements.push(stateQuery);
  const results = await db.batch<State>(statements);
  const state = results.at(-1)?.results[0];
  if (!state) throw new Error('Sync schema unavailable');
  if (state.commit_id !== commit) throw new UpdateError(409, 'SYNC_CONFLICT', 'Remote data changed. Read again and reconcile before retrying.');
  return json({ revision: state.revision });
}
