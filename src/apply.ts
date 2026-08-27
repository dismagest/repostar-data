/**
 * Aplica un snapshot del Ministerio sobre el estado: estaciones, precios actuales, histórico y
 * estadísticas diarias.
 */
import { FUEL_IDS, MIN_PROVINCE_SAMPLE, type FuelId } from './contract.ts';
import { madridDate, type Snapshot } from './ministry.ts';
import { computeThresholds, mean, type DailyStat } from './stats.ts';
import type { State } from './state.ts';

export const HISTORY_RETENTION_DAYS = 30;
export const DAILY_RETENTION_DAYS = 400;
export const STATION_RETENTION_DAYS = 30;
const DAY = 86_400;

export interface ApplyResult {
  seen: number;
  changed: number;
  added: number;
}

export const key = (id: number, fuel: FuelId): string => `${id}:${fuel}`;

export function applySnapshot(state: State, snap: Snapshot, ts: number, mode = 'run'): ApplyResult {
  let changed = 0;
  let added = 0;
  const seenKeys = new Set<string>();

  for (const s of snap.stations) {
    const prevStation = state.stations[s.id];
    state.stations[s.id] = {
      id: s.id,
      name: s.name,
      address: s.address,
      locality: s.locality,
      municipality: s.municipality,
      provinceId: s.provinceId,
      provinceName: s.provinceName,
      postalCode: s.postalCode,
      schedule: s.schedule,
      lat: s.lat,
      lng: s.lng,
      saleType: s.saleType,
      firstSeen: prevStation?.firstSeen ?? ts,
      lastSeen: ts,
    };
    for (const fuel of FUEL_IDS) {
      const price = s.prices[fuel];
      const k = key(s.id, fuel);
      if (price === undefined) continue;
      seenKeys.add(k);
      const cur = state.current[k];
      if (!cur) {
        state.current[k] = [price, null, ts];
        (state.history[k] ??= []).push([ts, price]);
        added++;
      } else if (cur[0] !== price) {
        state.current[k] = [price, cur[0], ts];
        (state.history[k] ??= []).push([ts, price]);
        changed++;
      }
    }
  }

  // Combustibles que una estación (presente en el snapshot) ha dejado de vender.
  const presentIds = new Set(snap.stations.map((s) => s.id));
  for (const k of Object.keys(state.current)) {
    if (seenKeys.has(k)) continue;
    const id = Number(k.split(':')[0]);
    if (presentIds.has(id)) delete state.current[k];
  }

  state.lastSnapshotTs = ts;
  state.updatedAt = new Date(ts * 1000).toISOString();
  state.sourceDate = snap.sourceDate;

  prune(state, ts);
  computeDaily(state, ts);

  state.runs.push({ at: new Date().toISOString(), sourceDate: snap.sourceDate, stations: snap.stations.length, changed, mode });
  if (state.runs.length > 200) state.runs.splice(0, state.runs.length - 200);

  return { seen: snap.stations.length, changed, added };
}

/** Retención de histórico, estadísticas y estaciones desaparecidas. */
export function prune(state: State, ts: number): void {
  const cutoff = ts - HISTORY_RETENTION_DAYS * DAY;
  for (const k of Object.keys(state.history)) {
    const h = state.history[k];
    // Conservamos la última entrada anterior al corte para poder dibujar la línea desde el inicio.
    let firstKeep = h.findIndex((e) => e[0] >= cutoff);
    if (firstKeep === -1) firstKeep = h.length; // todo antiguo
    const start = Math.max(0, firstKeep - 1);
    if (start > 0) state.history[k] = h.slice(start);
    if (!state.current[k] && (state.history[k].length === 0 || state.history[k][state.history[k].length - 1][0] < cutoff)) {
      delete state.history[k];
    }
  }
  const stationCutoff = ts - STATION_RETENTION_DAYS * DAY;
  for (const id of Object.keys(state.stations)) {
    if (state.stations[id].lastSeen < stationCutoff) {
      delete state.stations[id];
      for (const fuel of FUEL_IDS) {
        delete state.current[key(Number(id), fuel)];
        delete state.history[key(Number(id), fuel)];
      }
    }
  }
  const dailyCutoff = madridDate(ts - DAILY_RETENTION_DAYS * DAY);
  for (const fuel of Object.keys(state.daily)) {
    for (const scope of Object.keys(state.daily[fuel])) {
      for (const date of Object.keys(state.daily[fuel][scope])) {
        if (date < dailyCutoff) delete state.daily[fuel][scope][date];
      }
    }
  }
}

export function activeStationIds(state: State): number[] {
  const out: number[] = [];
  for (const s of Object.values(state.stations)) if (s.lastSeen === state.lastSnapshotTs) out.push(s.id);
  return out;
}

/** Estadísticas del día (hora de Madrid) para cada combustible y ámbito (ES + provincias). */
export function computeDaily(state: State, ts: number): void {
  const date = madridDate(ts);
  const active = new Set(activeStationIds(state));

  for (const fuel of FUEL_IDS) {
    const byScope = new Map<string, number[]>();
    const upDown = new Map<string, { up: number; down: number }>();
    const push = (scope: string, p: number) => {
      const arr = byScope.get(scope);
      if (arr) arr.push(p);
      else byScope.set(scope, [p]);
    };
    const bump = (scope: string, dir: 'up' | 'down') => {
      const e = upDown.get(scope) ?? { up: 0, down: 0 };
      e[dir]++;
      upDown.set(scope, e);
    };

    for (const id of active) {
      const k = key(id, fuel);
      const cur = state.current[k];
      if (!cur) continue;
      const scope = String(state.stations[id].provinceId);
      push('ES', cur[0]);
      push(scope, cur[0]);
      const dir = dayDirection(state.history[k] ?? [], date);
      if (dir) {
        bump('ES', dir);
        bump(scope, dir);
      }
    }

    const fuelDaily = (state.daily[fuel] ??= {});
    for (const [scope, prices] of byScope) {
      const t = computeThresholds(prices);
      if (!t) continue;
      const ud = upDown.get(scope) ?? { up: 0, down: 0 };
      const stat: DailyStat = { ...t, avg: mean(prices), nUp: ud.up, nDown: ud.down };
      (fuelDaily[scope] ??= {})[date] = stat;
    }
  }
}

/** Dirección neta del precio de un par estación×combustible en un día concreto. */
export function dayDirection(history: [number, number][], date: string): 'up' | 'down' | null {
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < history.length; i++) {
    if (madridDate(history[i][0]) === date) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }
  if (firstIdx === -1) return null; // sin registros hoy
  // Línea base: el último precio anterior al día; si el alta fue hoy, el precio del alta.
  const baseIdx = firstIdx > 0 ? firstIdx - 1 : 0;
  if (lastIdx === baseIdx) return null; // sin cambio real hoy
  const before = history[baseIdx][1];
  const after = history[lastIdx][1];
  if (after > before) return 'up';
  if (after < before) return 'down';
  return null;
}

/** Umbrales de referencia por combustible: provincia si tiene muestra suficiente, si no nacional. */
export function referenceThresholds(state: State, fuel: FuelId, provinceId: number) {
  const date = madridDate(state.lastSnapshotTs);
  const prov = state.daily[fuel]?.[String(provinceId)]?.[date];
  if (prov && prov.n >= MIN_PROVINCE_SAMPLE) return prov;
  return state.daily[fuel]?.ES?.[date] ?? null;
}
