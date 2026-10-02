export interface ValidatedEntry {
  game: 'hk4e' | 'hk4e_ugc' | 'hkrpg' | 'nap';
  kind: 'item';
  entity_id: string;
  lang: string;
  name: string;
  item_type: string | null;
  rank_type: string | null;
  item_category: 'character' | 'weapon' | 'light_cone' | 'w_engine' | 'bangboo' | 'outfit' | 'ugc_item' | null;
  icon: string | null;
}
export function validateMetadata(input: unknown, maxEntries?: number): {
  source: string;
  entries: ValidatedEntry[];
};
