-- Rebuild tables because the original table CHECK references gacha_type.
-- Copy every existing row. Unsupported legacy pool rows fail rather than being discarded.
CREATE TABLE genshin_meta_without_gacha_type (

  namespace TEXT NOT NULL CHECK (namespace IN ('hk4e')),
  kind TEXT NOT NULL CHECK (kind = 'item'),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 20 AND entity_id NOT GLOB '*[^0-9]*'),
  lang TEXT NOT NULL CHECK (lang IN ('de-de', 'en-us', 'es-es', 'fr-fr', 'id-id', 'it-it', 'ja-jp', 'ko-kr', 'pt-pt', 'ru-ru', 'th-th', 'tr-tr', 'vi-vn', 'zh-cn', 'zh-tw')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  item_type TEXT NOT NULL CHECK (length(item_type) BETWEEN 1 AND 64),
  rank_type TEXT NOT NULL CHECK (rank_type IN ('3', '4', '5')),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 2048),
  updated_at TEXT NOT NULL,
  item_category TEXT CHECK (item_category IN ('character', 'weapon', 'light_cone', 'w_engine', 'bangboo', 'outfit', 'ugc_item')),
  icon TEXT,
  PRIMARY KEY (namespace, kind, lang, entity_id)
) WITHOUT ROWID;

INSERT INTO genshin_meta_without_gacha_type (namespace, kind, entity_id, lang, name, item_type, rank_type, source, updated_at, item_category, icon) SELECT namespace, kind, entity_id, lang, name, item_type, rank_type, source, updated_at, item_category, icon FROM genshin_meta;

DROP TABLE genshin_meta;

ALTER TABLE genshin_meta_without_gacha_type RENAME TO genshin_meta;

CREATE TABLE starrail_meta_without_gacha_type (

  namespace TEXT NOT NULL CHECK (namespace IN ('hkrpg')),
  kind TEXT NOT NULL CHECK (kind = 'item'),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 20 AND entity_id NOT GLOB '*[^0-9]*'),
  lang TEXT NOT NULL CHECK (lang IN ('de-de', 'en-us', 'es-es', 'fr-fr', 'id-id', 'it-it', 'ja-jp', 'ko-kr', 'pt-pt', 'ru-ru', 'th-th', 'tr-tr', 'vi-vn', 'zh-cn', 'zh-tw')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  item_type TEXT NOT NULL CHECK (length(item_type) BETWEEN 1 AND 64),
  rank_type TEXT NOT NULL CHECK (rank_type IN ('3', '4', '5')),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 2048),
  updated_at TEXT NOT NULL,
  item_category TEXT CHECK (item_category IN ('character', 'weapon', 'light_cone', 'w_engine', 'bangboo', 'outfit', 'ugc_item')),
  icon TEXT,
  PRIMARY KEY (namespace, kind, lang, entity_id)
) WITHOUT ROWID;

INSERT INTO starrail_meta_without_gacha_type (namespace, kind, entity_id, lang, name, item_type, rank_type, source, updated_at, item_category, icon) SELECT namespace, kind, entity_id, lang, name, item_type, rank_type, source, updated_at, item_category, icon FROM starrail_meta;

DROP TABLE starrail_meta;

ALTER TABLE starrail_meta_without_gacha_type RENAME TO starrail_meta;

CREATE TABLE zenless_meta_without_gacha_type (

  namespace TEXT NOT NULL CHECK (namespace IN ('nap')),
  kind TEXT NOT NULL CHECK (kind = 'item'),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 20 AND entity_id NOT GLOB '*[^0-9]*'),
  lang TEXT NOT NULL CHECK (lang IN ('de-de', 'en-us', 'es-es', 'fr-fr', 'id-id', 'it-it', 'ja-jp', 'ko-kr', 'pt-pt', 'ru-ru', 'th-th', 'tr-tr', 'vi-vn', 'zh-cn', 'zh-tw')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  item_type TEXT NOT NULL CHECK (length(item_type) BETWEEN 1 AND 64),
  rank_type TEXT NOT NULL CHECK (rank_type IN ('2', '3', '4')),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 2048),
  updated_at TEXT NOT NULL,
  item_category TEXT CHECK (item_category IN ('character', 'weapon', 'light_cone', 'w_engine', 'bangboo', 'outfit', 'ugc_item')),
  icon TEXT,
  PRIMARY KEY (namespace, kind, lang, entity_id)
) WITHOUT ROWID;

INSERT INTO zenless_meta_without_gacha_type (namespace, kind, entity_id, lang, name, item_type, rank_type, source, updated_at, item_category, icon) SELECT namespace, kind, entity_id, lang, name, item_type, rank_type, source, updated_at, item_category, icon FROM zenless_meta;

DROP TABLE zenless_meta;

ALTER TABLE zenless_meta_without_gacha_type RENAME TO zenless_meta;

CREATE TABLE genshin_ugc_meta_without_gacha_type (

  namespace TEXT NOT NULL CHECK (namespace IN ('hk4e_ugc')),
  kind TEXT NOT NULL CHECK (kind = 'item'),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 20 AND entity_id NOT GLOB '*[^0-9]*'),
  lang TEXT NOT NULL CHECK (lang IN ('de-de', 'en-us', 'es-es', 'fr-fr', 'id-id', 'it-it', 'ja-jp', 'ko-kr', 'pt-pt', 'ru-ru', 'th-th', 'tr-tr', 'vi-vn', 'zh-cn', 'zh-tw')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  item_type TEXT NOT NULL CHECK (length(item_type) BETWEEN 1 AND 64),
  rank_type TEXT NOT NULL CHECK (length(rank_type) BETWEEN 1 AND 20 AND rank_type NOT GLOB '*[^0-9]*'),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 2048),
  updated_at TEXT NOT NULL,
  item_category TEXT CHECK (item_category IN ('character', 'weapon', 'light_cone', 'w_engine', 'bangboo', 'outfit', 'ugc_item')),
  icon TEXT,
  PRIMARY KEY (namespace, kind, lang, entity_id)
) WITHOUT ROWID;

INSERT INTO genshin_ugc_meta_without_gacha_type (namespace, kind, entity_id, lang, name, item_type, rank_type, source, updated_at, item_category, icon) SELECT namespace, kind, entity_id, lang, name, item_type, rank_type, source, updated_at, item_category, icon FROM genshin_ugc_meta;

DROP TABLE genshin_ugc_meta;

ALTER TABLE genshin_ugc_meta_without_gacha_type RENAME TO genshin_ugc_meta;
