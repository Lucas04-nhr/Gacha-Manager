-- Four independent game namespaces containing only public item and pool metadata.

CREATE TABLE IF NOT EXISTS genshin_meta (
  namespace TEXT NOT NULL CHECK (namespace IN ('hk4e')),
  kind TEXT NOT NULL CHECK (kind IN ('item', 'pool')),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 20 AND entity_id NOT GLOB '*[^0-9]*'),
  lang TEXT NOT NULL CHECK (lang IN ('de-de', 'en-us', 'es-es', 'fr-fr', 'id-id', 'it-it', 'ja-jp', 'ko-kr', 'pt-pt', 'ru-ru', 'th-th', 'tr-tr', 'vi-vn', 'zh-cn', 'zh-tw')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  item_type TEXT,
  rank_type TEXT,
  gacha_type TEXT,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 2048),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, kind, lang, entity_id),
  CHECK ((kind = 'pool' AND item_type IS NULL AND rank_type IS NULL AND gacha_type IS NOT NULL
      AND length(gacha_type) BETWEEN 1 AND 20 AND gacha_type NOT GLOB '*[^0-9]*')
    OR (kind = 'item' AND gacha_type IS NULL AND item_type IS NOT NULL
      AND length(item_type) BETWEEN 1 AND 64 AND rank_type IS NOT NULL
      AND ((namespace IN ('hk4e', 'hkrpg') AND rank_type IN ('3', '4', '5'))
        OR (namespace = 'nap' AND rank_type IN ('2', '3', '4'))
        OR (namespace = 'hk4e_ugc' AND length(rank_type) BETWEEN 1 AND 20 AND rank_type NOT GLOB '*[^0-9]*'))))
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS starrail_meta (
  namespace TEXT NOT NULL CHECK (namespace IN ('hkrpg')),
  kind TEXT NOT NULL CHECK (kind IN ('item', 'pool')),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 20 AND entity_id NOT GLOB '*[^0-9]*'),
  lang TEXT NOT NULL CHECK (lang IN ('de-de', 'en-us', 'es-es', 'fr-fr', 'id-id', 'it-it', 'ja-jp', 'ko-kr', 'pt-pt', 'ru-ru', 'th-th', 'tr-tr', 'vi-vn', 'zh-cn', 'zh-tw')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  item_type TEXT,
  rank_type TEXT,
  gacha_type TEXT,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 2048),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, kind, lang, entity_id),
  CHECK ((kind = 'pool' AND item_type IS NULL AND rank_type IS NULL AND gacha_type IS NOT NULL
      AND length(gacha_type) BETWEEN 1 AND 20 AND gacha_type NOT GLOB '*[^0-9]*')
    OR (kind = 'item' AND gacha_type IS NULL AND item_type IS NOT NULL
      AND length(item_type) BETWEEN 1 AND 64 AND rank_type IS NOT NULL
      AND ((namespace IN ('hk4e', 'hkrpg') AND rank_type IN ('3', '4', '5'))
        OR (namespace = 'nap' AND rank_type IN ('2', '3', '4'))
        OR (namespace = 'hk4e_ugc' AND length(rank_type) BETWEEN 1 AND 20 AND rank_type NOT GLOB '*[^0-9]*'))))
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS zenless_meta (
  namespace TEXT NOT NULL CHECK (namespace IN ('nap')),
  kind TEXT NOT NULL CHECK (kind IN ('item', 'pool')),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 20 AND entity_id NOT GLOB '*[^0-9]*'),
  lang TEXT NOT NULL CHECK (lang IN ('de-de', 'en-us', 'es-es', 'fr-fr', 'id-id', 'it-it', 'ja-jp', 'ko-kr', 'pt-pt', 'ru-ru', 'th-th', 'tr-tr', 'vi-vn', 'zh-cn', 'zh-tw')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  item_type TEXT,
  rank_type TEXT,
  gacha_type TEXT,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 2048),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, kind, lang, entity_id),
  CHECK ((kind = 'pool' AND item_type IS NULL AND rank_type IS NULL AND gacha_type IS NOT NULL
      AND length(gacha_type) BETWEEN 1 AND 20 AND gacha_type NOT GLOB '*[^0-9]*')
    OR (kind = 'item' AND gacha_type IS NULL AND item_type IS NOT NULL
      AND length(item_type) BETWEEN 1 AND 64 AND rank_type IS NOT NULL
      AND ((namespace IN ('hk4e', 'hkrpg') AND rank_type IN ('3', '4', '5'))
        OR (namespace = 'nap' AND rank_type IN ('2', '3', '4'))
        OR (namespace = 'hk4e_ugc' AND length(rank_type) BETWEEN 1 AND 20 AND rank_type NOT GLOB '*[^0-9]*'))))
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS genshin_ugc_meta (
  namespace TEXT NOT NULL CHECK (namespace IN ('hk4e_ugc')),
  kind TEXT NOT NULL CHECK (kind IN ('item', 'pool')),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 20 AND entity_id NOT GLOB '*[^0-9]*'),
  lang TEXT NOT NULL CHECK (lang IN ('de-de', 'en-us', 'es-es', 'fr-fr', 'id-id', 'it-it', 'ja-jp', 'ko-kr', 'pt-pt', 'ru-ru', 'th-th', 'tr-tr', 'vi-vn', 'zh-cn', 'zh-tw')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  item_type TEXT,
  rank_type TEXT,
  gacha_type TEXT,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 2048),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, kind, lang, entity_id),
  CHECK ((kind = 'pool' AND item_type IS NULL AND rank_type IS NULL AND gacha_type IS NOT NULL
      AND length(gacha_type) BETWEEN 1 AND 20 AND gacha_type NOT GLOB '*[^0-9]*')
    OR (kind = 'item' AND gacha_type IS NULL AND item_type IS NOT NULL
      AND length(item_type) BETWEEN 1 AND 64 AND rank_type IS NOT NULL
      AND ((namespace IN ('hk4e', 'hkrpg') AND rank_type IN ('3', '4', '5'))
        OR (namespace = 'nap' AND rank_type IN ('2', '3', '4'))
        OR (namespace = 'hk4e_ugc' AND length(rank_type) BETWEEN 1 AND 20 AND rank_type NOT GLOB '*[^0-9]*'))))
) WITHOUT ROWID;
