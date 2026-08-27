/**
 * Descarga y normalización de los datos del Ministerio (Geoportal de Gasolineras).
 */
import { FUELS, type FuelId } from './contract.ts';

const BASE = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes';
const USER_AGENT = 'RepostarPipeline/1.0 (+https://github.com/dismagest/repostar-data)';

export interface RawResponse {
  Fecha: string;
  ListaEESSPrecio: Record<string, string>[];
  Nota?: string;
  ResultadoConsulta?: string;
}

export interface NormalizedStation {
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
  margin: string;
  saleType: string;
  prices: Partial<Record<FuelId, number>>;
}

export interface Snapshot {
  /** Fecha del Ministerio en ISO (o la de descarga si no se puede parsear). */
  sourceDate: string;
  stations: NormalizedStation[];
}

/** "1,459" -> 1.459 ; "" -> undefined ; valores absurdos -> undefined */
export function parsePrice(s: string | undefined | null): number | undefined {
  if (s == null) return undefined;
  const t = String(s).trim();
  if (!t) return undefined;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 30) return undefined;
  return Math.round(n * 1000) / 1000;
}

export function parseCoord(s: string | undefined | null): number | undefined {
  if (s == null) return undefined;
  const n = Number(String(s).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

/** "27/08/2026 19:02:54" -> ISO UTC (interpretado como hora de Madrid) */
export function parseMinistryDate(s: string | undefined, fallback: Date): string {
  if (!s) return fallback.toISOString();
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return fallback.toISOString();
  const [, d, mo, y, h, mi, se] = m;
  // Hora local de Madrid -> UTC usando el desfase real de esa fecha.
  const naive = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  const offsetMin = madridOffsetMinutes(new Date(naive));
  return new Date(naive - offsetMin * 60_000).toISOString();
}

/** Desfase de Europe/Madrid respecto a UTC (minutos) para un instante dado. */
export function madridOffsetMinutes(date: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** Fecha YYYY-MM-DD en hora de Madrid para un timestamp en segundos. */
export function madridDate(tsSeconds: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(tsSeconds * 1000));
}

const SPAIN_BBOX = { minLat: 27.3, maxLat: 44.2, minLng: -18.5, maxLng: 4.7 };

export function normalizeStation(r: Record<string, string>): NormalizedStation | null {
  const id = Number(r['IDEESS']);
  const lat = parseCoord(r['Latitud']);
  const lng = parseCoord(r['Longitud (WGS84)']);
  if (!Number.isInteger(id) || id <= 0 || lat === undefined || lng === undefined) return null;
  if (lat < SPAIN_BBOX.minLat || lat > SPAIN_BBOX.maxLat || lng < SPAIN_BBOX.minLng || lng > SPAIN_BBOX.maxLng) return null;
  const prices: Partial<Record<FuelId, number>> = {};
  for (const f of FUELS) {
    const p = parsePrice(r[f.key]);
    if (p !== undefined) prices[f.id] = p;
  }
  return {
    id,
    name: clean(r['Rótulo']) || 'Gasolinera',
    address: clean(r['Dirección']),
    locality: clean(r['Localidad']),
    municipality: clean(r['Municipio']),
    provinceId: Number(r['IDProvincia']) || 0,
    provinceName: clean(r['Provincia']),
    postalCode: clean(r['C.P.']),
    schedule: clean(r['Horario']),
    lat: round6(lat),
    lng: round6(lng),
    margin: clean(r['Margen']),
    saleType: clean(r['Tipo Venta']),
    prices,
  };
}

export function normalizeResponse(raw: RawResponse, downloadedAt = new Date()): Snapshot {
  const stations: NormalizedStation[] = [];
  const seen = new Set<number>();
  for (const r of raw.ListaEESSPrecio ?? []) {
    const s = normalizeStation(r);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    stations.push(s);
  }
  return { sourceDate: parseMinistryDate(raw.Fecha, downloadedAt), stations };
}

function clean(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

async function fetchJsonWithRetry(url: string, attempts = 3): Promise<RawResponse> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const data = (await res.json()) as RawResponse;
      if (!Array.isArray(data.ListaEESSPrecio)) throw new Error('Respuesta sin ListaEESSPrecio');
      return data;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchCurrent(): Promise<Snapshot> {
  const raw = await fetchJsonWithRetry(`${BASE}/EstacionesTerrestres/`);
  return normalizeResponse(raw);
}

/** Snapshot histórico del día indicado (precios en vigor a las 0:00 de ese día). */
export async function fetchHistoric(date: Date): Promise<Snapshot> {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  const raw = await fetchJsonWithRetry(`${BASE}/EstacionesTerrestresHist/${dd}-${mm}-${yyyy}`);
  return normalizeResponse(raw, date);
}
