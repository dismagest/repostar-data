/**
 * Cotización diaria del Brent (futuro BZ=F) vía Yahoo Finance, sin clave.
 */
import type { BrentJson } from './contract.ts';

const URL = 'https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?range=6mo&interval=1d';
export const BRENT_RETENTION_DAYS = 400;

interface YahooChart {
  chart: {
    result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[];
    error?: unknown;
  };
}

export function parseYahoo(data: YahooChart): [string, number][] {
  const r = data.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const close = r?.indicators?.quote?.[0]?.close ?? [];
  const out: [string, number][] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c == null || !Number.isFinite(c)) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    out.push([date, Math.round(c * 100) / 100]);
  }
  return out;
}

export function mergeBrent(existing: BrentJson | null, fresh: [string, number][], now = new Date()): BrentJson {
  const byDate = new Map<string, number>();
  for (const [d, v] of existing?.series ?? []) byDate.set(d, v);
  for (const [d, v] of fresh) byDate.set(d, v);
  const cutoff = new Date(now.getTime() - BRENT_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  const series = [...byDate.entries()].filter(([d]) => d >= cutoff).sort(([a], [b]) => (a < b ? -1 : 1));
  return { updatedAt: now.toISOString(), series };
}

export async function fetchBrent(existing: BrentJson | null): Promise<BrentJson> {
  const res = await fetch(URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RepostarBot/1.0)', Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Brent HTTP ${res.status}`);
  const data = (await res.json()) as YahooChart;
  const fresh = parseYahoo(data);
  if (fresh.length === 0) throw new Error('Brent: serie vacía');
  return mergeBrent(existing, fresh);
}
