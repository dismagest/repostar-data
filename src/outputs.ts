/**
 * Genera los ficheros publicados (contrato §3) a partir del estado.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DATA_FILES, FUEL_IDS, SHARDS, shardOf, levelFor, CONTRACT_VERSION, EV_SHARDS, EV_CONNECTOR_BIT, evShardOf,
  type EvLayerJson, type EvLayerSite, type EvShard,
  type ChangeItem, type ChangesJson, type FuelId, type HistoryShard, type LayerJson, type LayerStation,
  type MetaJson, type PlaceItem, type PlacesJson, type ProvinceMeta, type StationRecord, type StationsShard,
  type Thresholds, type TrendPoint, type TrendsJson,
} from './contract.ts';
import { activeStationIds, key, referenceThresholds } from './apply.ts';
import { speedTier } from './ev.ts';
import { madridDate } from './ministry.ts';
import type { State } from './state.ts';

const DAY = 86_400;
export const CHANGES_WINDOW_DAYS = 7;
export const TRENDS_WINDOW_DAYS = 90;
export const MIN_BRAND_COUNT = 25;

/** Marcas principales: el rótulo se canoniza si contiene una de estas palabras. */
const BRAND_TOKENS = [
  'REPSOL', 'CEPSA', 'MOEVE', 'BP', 'GALP', 'SHELL', 'PETRONOR', 'BALLENOIL', 'PLENOIL', 'PETROPRIX',
  'ALCAMPO', 'CARREFOUR', 'EROSKI', 'BONAREA', 'AVIA', 'DISA', 'MEROIL', 'TAMOIL', 'Q8', 'ESSO',
  'VALCARCE', 'PETROCAT', 'ANDAMUR', 'AUTONETOIL', 'GM OIL', 'CAMPSA', 'ENERGY', 'PETROMIRALLES',
  'PCAN', 'TGAS', 'STAROIL', 'FAST FUEL', 'EASYGAS', 'COSTCO', 'SUPECO', 'LEROY', 'HIPERDINO', 'NIETO',
  'GASEXPRESS', 'GASOLINERAS LOW COST', 'LOW COST', 'ESERGUI', 'ZOILO RIOS', 'CARBURANTS', 'ADN',
];

export function canonicalBrand(name: string): string {
  const up = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const t of BRAND_TOKENS) {
    const re = new RegExp(`(^|\\s)${t.replace(/ /g, '\\s')}(\\s|$)`);
    if (re.test(up)) return t === 'MOEVE' ? 'MOEVE (CEPSA)' : t === 'CEPSA' ? 'MOEVE (CEPSA)' : t;
  }
  return up;
}

export function titleCase(s: string): string {
  const small = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'al', 'da', 'do', 'des', 'i', 'les']);
  return s
    .toLowerCase()
    .split(/(\s+|-|\/|\()/)
    .map((w, i) => (small.has(w) && i > 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

export type OutputMap = Map<string, unknown>;

/** 5 decimales ≈ 1 m: suficiente para el mapa y ahorra bytes en la capa. */
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

export function buildOutputs(state: State, now = new Date()): OutputMap {
  const out: OutputMap = new Map();
  const generatedAt = now.toISOString();
  const nowTs = Math.floor(now.getTime() / 1000);
  const active = activeStationIds(state).sort((a, b) => a - b);
  const date = madridDate(state.lastSnapshotTs);

  // --- marcas ---
  const brandCounts = new Map<string, number>();
  for (const id of active) {
    const b = canonicalBrand(state.stations[id].name);
    brandCounts.set(b, (brandCounts.get(b) ?? 0) + 1);
  }
  const brands = [...brandCounts.entries()]
    .filter(([, n]) => n >= MIN_BRAND_COUNT)
    .sort((a, b) => b[1] - a[1])
    .map(([b]) => b);
  const brandIdx = new Map(brands.map((b, i) => [b, i]));

  // --- provincias ---
  const provinces: Record<string, ProvinceMeta> = {};
  for (const id of active) {
    const s = state.stations[id];
    const p = (provinces[s.provinceId] ??= { name: titleCase(s.provinceName), bbox: [s.lng, s.lat, s.lng, s.lat], n: 0 });
    p.n++;
    p.bbox = [Math.min(p.bbox[0], s.lng), Math.min(p.bbox[1], s.lat), Math.max(p.bbox[2], s.lng), Math.max(p.bbox[3], s.lat)];
  }

  // --- umbrales ---
  const thresholds: Record<string, Record<string, Thresholds>> = {};
  for (const fuel of FUEL_IDS) {
    thresholds[fuel] = {};
    const scopes = state.daily[fuel] ?? {};
    for (const scope of Object.keys(scopes)) {
      const d = scopes[scope][date];
      if (d) thresholds[fuel][scope] = { p10: d.p10, p25: d.p25, median: d.median, p75: d.p75, n: d.n };
    }
  }

  // --- capas por combustible + fichas + histórico ---
  const stationShards: StationsShard[] = Array.from({ length: SHARDS }, () => ({}));
  const historyShards: HistoryShard[] = Array.from({ length: SHARDS }, () => ({}));
  const layers: Record<string, LayerJson> = {};
  const scheduleIdx = new Map<string, number>();
  const schedules: string[] = [];
  const schedIndex = (s: string) => {
    let i = scheduleIdx.get(s);
    if (i === undefined) {
      i = schedules.length;
      schedules.push(s);
      scheduleIdx.set(s, i);
    }
    return i;
  };
  for (const fuel of FUEL_IDS) layers[fuel] = { generatedAt, fuel, schedules, brands, stations: [] };

  const historyCutoff = nowTs - 30 * DAY;
  for (const id of active) {
    const s = state.stations[id];
    const rec: StationRecord = {
      id, name: s.name, address: s.address, locality: s.locality, municipality: s.municipality,
      provinceId: s.provinceId, postalCode: s.postalCode, schedule: s.schedule, lat: s.lat, lng: s.lng,
      saleType: s.saleType, prices: {},
    };
    const bIdx = brandIdx.get(canonicalBrand(s.name)) ?? -1;
    const sIdx = schedIndex(s.schedule);
    let hasHistory = false;
    const hist: HistoryShard[string] = {};
    for (const fuel of FUEL_IDS) {
      const cur = state.current[key(id, fuel)];
      if (!cur) continue;
      const t = referenceThresholds(state, fuel, s.provinceId);
      const level = t ? levelFor(cur[0], t) : 1;
      rec.prices[fuel] = { price: cur[0], prev: cur[1], changedAt: new Date(cur[2] * 1000).toISOString(), level };
      const delta = cur[1] === null ? 0 : Math.round((cur[0] - cur[1]) * 1000) / 1000;
      const row: LayerStation = [id, r5(s.lat), r5(s.lng), cur[0], level, bIdx, sIdx, s.provinceId, delta];
      layers[fuel].stations.push(row);
      const h = state.history[key(id, fuel)];
      if (h && h.length) {
        let firstKeep = h.findIndex((e) => e[0] >= historyCutoff);
        if (firstKeep === -1) firstKeep = h.length;
        const slice = h.slice(Math.max(0, firstKeep - 1));
        if (slice.length) {
          hist[fuel] = slice;
          hasHistory = true;
        }
      }
    }
    stationShards[shardOf(id)][id] = rec;
    if (hasHistory) historyShards[shardOf(id)][id] = hist;
  }

  for (const fuel of FUEL_IDS) out.set(DATA_FILES.layer(fuel), layers[fuel]);
  for (let i = 0; i < SHARDS; i++) {
    out.set(DATA_FILES.stations(i), stationShards[i]);
    out.set(DATA_FILES.history(i), historyShards[i]);
  }

  // --- cambios por provincia (7 días) ---
  const changesCutoff = nowTs - CHANGES_WINDOW_DAYS * DAY;
  const changesByProvince = new Map<number, ChangeItem[]>();
  for (const id of active) {
    const s = state.stations[id];
    for (const fuel of FUEL_IDS) {
      const h = state.history[key(id, fuel)];
      if (!h || h.length < 2 || !state.current[key(id, fuel)]) continue;
      for (let i = 1; i < h.length; i++) {
        if (h[i][0] < changesCutoff) continue;
        const item: ChangeItem = { id, name: s.name, fuel, from: h[i - 1][1], to: h[i][1], at: h[i][0], lat: s.lat, lng: s.lng };
        const arr = changesByProvince.get(s.provinceId);
        if (arr) arr.push(item);
        else changesByProvince.set(s.provinceId, [item]);
      }
    }
  }
  for (const pid of Object.keys(provinces).map(Number)) {
    const items = (changesByProvince.get(pid) ?? []).sort((a, b) => b.at - a.at);
    const json: ChangesJson = { generatedAt, provinceId: pid, items };
    out.set(DATA_FILES.changes(pid), json);
  }

  // --- tendencias ---
  const trendsCutoff = madridDate(nowTs - TRENDS_WINDOW_DAYS * DAY);
  for (const fuel of FUEL_IDS) {
    const scopes = state.daily[fuel] ?? {};
    const series = (scope: string): TrendPoint[] =>
      Object.entries(scopes[scope] ?? {})
        .filter(([d]) => d >= trendsCutoff)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([d, st]) => [d, st.avg, st.median, st.nUp, st.nDown, st.n]);
    const json: TrendsJson = { generatedAt, fuel, national: series('ES'), provinces: {} };
    for (const pid of Object.keys(provinces)) json.provinces[pid] = series(pid);
    out.set(DATA_FILES.trends(fuel), json);
  }

  // --- lugares ---
  const placeAgg = new Map<string, { name: string; provinceId: number; lat: number; lng: number; n: number }>();
  for (const id of active) {
    const s = state.stations[id];
    for (const raw of new Set([s.locality, s.municipality])) {
      if (!raw) continue;
      const name = titleCase(raw);
      const k = `${name}|${s.provinceId}`;
      const p = placeAgg.get(k);
      if (p) {
        p.lat += s.lat;
        p.lng += s.lng;
        p.n++;
      } else placeAgg.set(k, { name, provinceId: s.provinceId, lat: s.lat, lng: s.lng, n: 1 });
    }
  }
  const places: PlaceItem[] = [...placeAgg.values()]
    .map((p) => [p.name, p.provinceId, Math.round((p.lat / p.n) * 1e5) / 1e5, Math.round((p.lng / p.n) * 1e5) / 1e5] as PlaceItem)
    .sort((a, b) => a[0].localeCompare(b[0], 'es'));
  const placesJson: PlacesJson = { generatedAt, items: places };
  out.set(DATA_FILES.places, placesJson);

  // --- recarga eléctrica (DATEX2 de la DGT) ---
  let evMeta: MetaJson['ev'];
  if (state.ev && state.ev.sites.length > 0) {
    const operatorCounts = new Map<string, number>();
    for (const s of state.ev.sites) operatorCounts.set(s.operator, (operatorCounts.get(s.operator) ?? 0) + 1);
    const operators = [...operatorCounts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const opIdx = new Map(operators.map((n, i) => [n, i]));
    const evShards: EvShard[] = Array.from({ length: EV_SHARDS }, () => ({}));
    const layer: EvLayerJson = { generatedAt, publishedAt: state.ev.publishedAt, operators, sites: [] };
    let connectorsTotal = 0;
    let pointsTotal = 0;
    for (const s of state.ev.sites) {
      let mask = 0;
      for (const c of s.connectors) {
        mask |= EV_CONNECTOR_BIT[c.type];
        connectorsTotal += c.n;
      }
      pointsTotal += s.points;
      const row: EvLayerSite = [s.id, s.lat, s.lng, s.maxKw, speedTier(s.maxKw), s.points, mask, opIdx.get(s.operator) ?? -1, s.open24h ? 1 : 0];
      layer.sites.push(row);
      evShards[evShardOf(s.id)][s.id] = s;
    }
    out.set(DATA_FILES.evLayer, layer);
    for (let i = 0; i < EV_SHARDS; i++) out.set(DATA_FILES.evShard(i), evShards[i]);
    evMeta = { sites: state.ev.sites.length, points: pointsTotal, connectors: connectorsTotal, publishedAt: state.ev.publishedAt };
  }

  // --- meta, brent, noticias ---
  const meta: MetaJson = {
    version: CONTRACT_VERSION,
    generatedAt,
    sourceDate: state.sourceDate,
    stationsActive: active.length,
    fuels: FUEL_IDS,
    provinces,
    thresholds,
    brands,
    ...(evMeta ? { ev: evMeta } : {}),
  };
  out.set(DATA_FILES.meta, meta);
  out.set(DATA_FILES.brent, state.brent ?? { updatedAt: '', series: [] });
  out.set(DATA_FILES.news, state.news ?? { updatedAt: '', items: [] });
  return out;
}

export interface Validation {
  ok: boolean;
  problems: string[];
}

export function validateOutputs(out: OutputMap): Validation {
  const problems: string[] = [];
  const meta = out.get(DATA_FILES.meta) as MetaJson | undefined;
  if (!meta) problems.push('falta meta.json');
  else if (meta.stationsActive < 8000) problems.push(`solo ${meta.stationsActive} estaciones activas (< 8000)`);
  let fuelsWithData = 0;
  for (const fuel of FUEL_IDS) {
    const layer = out.get(DATA_FILES.layer(fuel)) as LayerJson | undefined;
    if (layer && layer.stations.length > 100) fuelsWithData++;
  }
  if (fuelsWithData < 5) problems.push(`solo ${fuelsWithData} combustibles con datos (< 5)`);
  return { ok: problems.length === 0, problems };
}

export async function writeOutputs(dir: string, out: OutputMap): Promise<number> {
  let bytes = 0;
  for (const [rel, value] of out) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    const text = JSON.stringify(value);
    bytes += Buffer.byteLength(text);
    await writeFile(path, text);
  }
  await writeFile(join(dir, '.nojekyll'), '');
  await writeFile(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Repostar data</title><p>Datos abiertos de precios de carburantes (fuente: MITECO). Ver <a href="meta.json">meta.json</a>.');
  return bytes;
}

export function fuelOf(k: string): FuelId {
  return k.split(':')[1] as FuelId;
}
