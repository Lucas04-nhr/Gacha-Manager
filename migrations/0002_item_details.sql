ALTER TABLE genshin_meta ADD COLUMN item_category TEXT CHECK (item_category IN ('character', 'weapon', 'light_cone', 'w_engine', 'bangboo', 'outfit'));
ALTER TABLE genshin_meta ADD COLUMN icon TEXT;
ALTER TABLE genshin_ugc_meta ADD COLUMN item_category TEXT CHECK (item_category IN ('character', 'weapon', 'light_cone', 'w_engine', 'bangboo', 'outfit'));
ALTER TABLE genshin_ugc_meta ADD COLUMN icon TEXT;
ALTER TABLE starrail_meta ADD COLUMN item_category TEXT CHECK (item_category IN ('character', 'weapon', 'light_cone', 'w_engine', 'bangboo', 'outfit'));
ALTER TABLE starrail_meta ADD COLUMN icon TEXT;
ALTER TABLE zenless_meta ADD COLUMN item_category TEXT CHECK (item_category IN ('character', 'weapon', 'light_cone', 'w_engine', 'bangboo', 'outfit'));
ALTER TABLE zenless_meta ADD COLUMN icon TEXT;
