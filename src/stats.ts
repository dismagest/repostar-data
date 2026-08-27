import type { Thresholds } from './contract.ts';

export interface DailyStat extends Thresholds {
  avg: number;
  nUp: number;
  nDown: number;
}

/** Percentil por interpolación lineal sobre un array YA ordenado. */
export function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function computeThresholds(prices: number[]): Thresholds | null {
  if (prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  return {
    p10: r3(percentileSorted(sorted, 0.1)),
    p25: r3(percentileSorted(sorted, 0.25)),
    median: r3(percentileSorted(sorted, 0.5)),
    p75: r3(percentileSorted(sorted, 0.75)),
    n: sorted.length,
  };
}

export function mean(prices: number[]): number {
  if (prices.length === 0) return NaN;
  let s = 0;
  for (const p of prices) s += p;
  return r3(s / prices.length);
}

export function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
