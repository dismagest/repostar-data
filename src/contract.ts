/**
 * Contrato de datos compartido entre el pipeline (escritor) y la app (lector).
 * Sin dependencias. Solo sintaxis TypeScript "borrable" (Node 24 la ejecuta sin compilar).
 *
 * Convenciones:
 *  - Timestamps dentro de arrays: segundos Unix (número).
 *  - Timestamps en campos de objeto (`generatedAt`, `changedAt`...): ISO 8601 UTC.
 *  - Precios: número con 3 decimales (€/l o €/kg).
 */

export const CONTRACT_VERSION = 1;
export const SHARDS = 128;

export const FUELS = [
  { id: 'g95', key: 'Precio Gasolina 95 E5', name: 'Gasolina 95', short: '95', unit: '€/l' },
  { id: 'g98', key: 'Precio Gasolina 98 E5', name: 'Gasolina 98', short: '98', unit: '€/l' },
  { id: 'goa', key: 'Precio Gasoleo A', name: 'Diésel', short: 'Diésel', unit: '€/l' },
  { id: 'goap', key: 'Precio Gasoleo Premium', name: 'Diésel Premium', short: 'Diésel+', unit: '€/l' },
  { id: 'glp', key: 'Precio Gases licuados del petróleo', name: 'GLP (Autogas)', short: 'GLP', unit: '€/l' },
  { id: 'gnc', key: 'Precio Gas Natural Comprimido', name: 'GNC', short: 'GNC', unit: '€/kg' },
] as const;

export type FuelId = (typeof FUELS)[number]['id'];
export const FUEL_IDS: FuelId[] = FUELS.map((f) => f.id);
export const FUEL_BY_ID: Record<FuelId, (typeof FUELS)[number]> = Object.fromEntries(
  FUELS.map((f) => [f.id, f]),
) as Record<FuelId, (typeof FUELS)[number]>;

export function isFuelId(x: unknown): x is FuelId {
  return typeof x === 'string' && (FUEL_IDS as string[]).includes(x);
}

/** 3 = chollo, 2 = barata, 1 = normal, 0 = cara */
export type Level = 0 | 1 | 2 | 3;

export interface Thresholds {
  p10: number;
  p25: number;
  median: number;
  p75: number;
  n: number;
}

/** Mínimo de estaciones con precio en una provincia para usarla como referencia. */
export const MIN_PROVINCE_SAMPLE = 30;
/** Un chollo debe estar al menos 5 céntimos por debajo de la mediana. */
export const BARGAIN_MIN_GAP = 0.05;

export function levelFor(price: number, t: Thresholds): Level {
  if (price <= t.p10 && price <= t.median - BARGAIN_MIN_GAP + 1e-9) return 3;
  if (price <= t.p25) return 2;
  if (price >= t.p75) return 0;
  return 1;
}

export const shardOf = (id: number): number => id % SHARDS;

/* ---------- Ficheros publicados ---------- */

export interface ProvinceMeta {
  name: string;
  /** [minLng, minLat, maxLng, maxLat] */
  bbox: [number, number, number, number];
  n: number;
}

export interface MetaJson {
  version: number;
  generatedAt: string;
  sourceDate: string;
  stationsActive: number;
  fuels: FuelId[];
  provinces: Record<string, ProvinceMeta>;
  /** thresholds[fuel]['ES' | provinceId] */
  thresholds: Record<string, Record<string, Thresholds>>;
  brands: string[];
}

/** [id, lat, lng, price, level, brandIdx(-1 = otras), scheduleIdx, provinceId, delta] */
export type LayerStation = [number, number, number, number, Level, number, number, number, number];

export interface LayerJson {
  generatedAt: string;
  fuel: FuelId;
  schedules: string[];
  brands: string[];
  stations: LayerStation[];
}

export interface StationPrice {
  price: number;
  prev: number | null;
  changedAt: string;
  level: Level;
}

export interface StationRecord {
  id: number;
  name: string;
  address: string;
  locality: string;
  municipality: string;
  provinceId: number;
  postalCode: string;
  schedule: string;
  lat: number;
  lng: number;
  saleType: string;
  prices: Partial<Record<FuelId, StationPrice>>;
}

export type StationsShard = Record<string, StationRecord>;

/** history[id][fuel] = [[ts, price], ...] ordenado ascendente, 30 días */
export type HistoryShard = Record<string, Partial<Record<FuelId, [number, number][]>>>;

export interface ChangeItem {
  id: number;
  name: string;
  fuel: FuelId;
  from: number;
  to: number;
  /** segundos Unix */
  at: number;
  lat: number;
  lng: number;
}

export interface ChangesJson {
  generatedAt: string;
  provinceId: number;
  items: ChangeItem[];
}

/** [date(YYYY-MM-DD), avg, median, nUp, nDown, n] */
export type TrendPoint = [string, number, number, number, number, number];

export interface TrendsJson {
  generatedAt: string;
  fuel: FuelId;
  national: TrendPoint[];
  provinces: Record<string, TrendPoint[]>;
}

export interface BrentJson {
  updatedAt: string;
  /** [date(YYYY-MM-DD), USD/barril] */
  series: [string, number][];
}

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

export interface NewsJson {
  updatedAt: string;
  items: NewsItem[];
}

/** [name, provinceId, lat, lng] */
export type PlaceItem = [string, number, number, number];

export interface PlacesJson {
  generatedAt: string;
  items: PlaceItem[];
}

export const DATA_FILES = {
  meta: 'meta.json',
  layer: (fuel: FuelId) => `layers/${fuel}.json`,
  stations: (shard: number) => `stations/${shard}.json`,
  history: (shard: number) => `history/${shard}.json`,
  changes: (provinceId: number) => `changes/${provinceId}.json`,
  trends: (fuel: FuelId) => `trends/${fuel}.json`,
  brent: 'brent.json',
  news: 'news.json',
  places: 'places.json',
  state: 'state.json',
} as const;
