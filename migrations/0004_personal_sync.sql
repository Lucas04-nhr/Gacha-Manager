-- Personal, single-owner storage, never queried by the public metadata API.
CREATE TABLE personal_sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  commit_id TEXT NOT NULL
);
INSERT INTO personal_sync_state VALUES (1, 0, '');
CREATE TABLE personal_sync_accounts (
  game TEXT NOT NULL CHECK (game IN ('hk4e', 'hk4e_ugc', 'hkrpg', 'nap')),
  uid TEXT NOT NULL,
  timezone INTEGER NOT NULL CHECK (timezone BETWEEN -12 AND 14),
  PRIMARY KEY (game, uid)
);
CREATE TABLE personal_sync_records (
  game TEXT NOT NULL,
  uid TEXT NOT NULL,
  id TEXT NOT NULL,
  record TEXT NOT NULL CHECK (json_valid(record)),
  PRIMARY KEY (game, uid, id),
  FOREIGN KEY (game, uid) REFERENCES personal_sync_accounts(game, uid) ON DELETE CASCADE
);
