/**
 * Estado interno del pipeline: se publica como state.json y se recarga en la siguiente ejecución.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { CONTRACT_VERSION, type BrentJson, type NewsJson } from './contract.ts';
import type { DailyStat } from './stats.ts';

export interface StateStation {
  id: number;
  name: string;
  address: string;
  locality: string;
  municipality: string;
  provinceId: number;
  provinceName: string;
  postalCode: string;
  schedule: string;
  lat: number;
  lng: number;
  saleType: string;
  firstSeen: number;
  lastSeen: number;
}

/** [price, prev | null, changedAt(segundos)] */
export type CurrentEntry = [number, number | null, number];

export interface State {
  version: number;
  updatedAt: string;
  sourceDate: string;
  /** ts (segundos) del último snapshot aplicado; una estación está activa si lastSeen === lastSnapshotTs */
  lastSnapshotTs: number;
  stations: Record<string, StateStation>;
  /** clave "id:fuel" */
  current: Record<string, CurrentEntry>;
  /** clave "id:fuel" -> [[ts, price], ...] ascendente */
  history: Record<string, [number, number][]>;
  /** daily[fuel][scope][date] */
  daily: Record<string, Record<string, Record<string, DailyStat>>>;
  news: NewsJson | null;
  brent: BrentJson | null;
  runs: { at: string; sourceDate: string; stations: number; changed: number; mode: string }[];
}

export function emptyState(): State {
  return {
    version: CONTRACT_VERSION,
    updatedAt: new Date(0).toISOString(),
    sourceDate: '',
    lastSnapshotTs: 0,
    stations: {},
    current: {},
    history: {},
    daily: {},
    news: null,
    brent: null,
    runs: [],
  };
}

export function isEmptyState(s: State): boolean {
  return Object.keys(s.stations).length === 0;
}

export class StateLoadError extends Error {}

/**
 * Carga el estado desde una URL o ruta local.
 * - URL con 404 -> estado vacío (primera ejecución).
 * - Cualquier otro fallo -> StateLoadError (nunca sobrescribir histórico por un fallo transitorio).
 */
export async function loadState(source: string | undefined): Promise<State> {
  if (!source) return emptyState();
  let text: string;
  if (/^https?:\/\//.test(source)) {
    const url = source + (source.includes('?') ? '&' : '?') + 'cb=' + Date.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'Cache-Control': 'no-cache' } }).catch((e) => {
      throw new StateLoadError(`No se pudo descargar el estado: ${e instanceof Error ? e.message : e}`);
    });
    if (res.status === 404) return emptyState();
    if (!res.ok) throw new StateLoadError(`Estado: HTTP ${res.status}`);
    text = await res.text();
  } else {
    try {
      text = await readFile(source, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return emptyState();
      throw new StateLoadError(`No se pudo leer el estado: ${e instanceof Error ? e.message : e}`);
    }
  }
  let parsed: State;
  try {
    parsed = JSON.parse(text) as State;
  } catch {
    throw new StateLoadError('El estado no es JSON válido');
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.stations || !parsed.current) {
    throw new StateLoadError('El estado no tiene la forma esperada');
  }
  return { ...emptyState(), ...parsed };
}

export async function saveState(path: string, state: State): Promise<void> {
  await writeFile(path, JSON.stringify(state));
}
