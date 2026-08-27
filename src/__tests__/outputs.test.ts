import { describe, expect, it } from 'vitest';
import { applySnapshot } from '../apply.ts';
import { DATA_FILES, type ChangesJson, type LayerJson, type MetaJson, type PlacesJson, type StationsShard, type TrendsJson, type HistoryShard, shardOf } from '../contract.ts';
import type { NormalizedStation, Snapshot } from '../ministry.ts';
import { buildOutputs, canonicalBrand, titleCase, validateOutputs } from '../outputs.ts';
import { emptyState } from '../state.ts';

const T0 = Date.UTC(2026, 7, 20, 10, 0) / 1000;
const H = 3600;

function station(id: number, prices: NormalizedStation['prices'], over: Partial<NormalizedStation> = {}): NormalizedStation {
  return {
    id, name: 'REPSOL', address: 'Calle 1', locality: 'MADRID', municipality: 'Madrid', provinceId: 28, provinceName: 'MADRID',
    postalCode: '28001', schedule: 'L-D: 24H', lat: 40.4 + id / 1000, lng: -3.7, margin: 'D', saleType: 'P', prices, ...over,
  };
}
const snap = (stations: NormalizedStation[]): Snapshot => ({ sourceDate: '2026-08-20T10:00:00.000Z', stations });

describe('buildOutputs', () => {
  const st = emptyState();
  const stations = Array.from({ length: 40 }, (_, i) => station(i + 1, { goa: 1.4 + i * 0.01, g95: 1.6 }));
  applySnapshot(st, snap(stations), T0);
  const changed = stations.map((s) => (s.id === 1 ? { ...s, prices: { goa: 1.35, g95: 1.6 } } : s));
  applySnapshot(st, snap(changed), T0 + H);
  const now = new Date((T0 + 2 * H) * 1000);
  const out = buildOutputs(st, now);

  it('meta con provincias, umbrales y marcas', () => {
    const meta = out.get(DATA_FILES.meta) as MetaJson;
    expect(meta.stationsActive).toBe(40);
    expect(meta.provinces['28'].name).toBe('Madrid');
    expect(meta.thresholds.goa['28'].n).toBe(40);
    expect(meta.brands).toEqual(['REPSOL']);
  });

  it('capa con filas compactas, nivel y delta', () => {
    const layer = out.get(DATA_FILES.layer('goa')) as LayerJson;
    expect(layer.stations).toHaveLength(40);
    const row = layer.stations.find((r) => r[0] === 1)!;
    expect(row[3]).toBe(1.35);
    expect(row[4]).toBe(3); // chollo: muy por debajo de p10 y mediana
    expect(row[5]).toBe(0); // REPSOL
    expect(layer.schedules[row[6]]).toBe('L-D: 24H');
    expect(row[7]).toBe(28);
    expect(row[8]).toBeCloseTo(-0.05, 3);
  });

  it('fichas e histórico por shard', () => {
    const shard = out.get(DATA_FILES.stations(shardOf(1))) as StationsShard;
    expect(shard['1'].prices.goa).toMatchObject({ price: 1.35, prev: 1.4, level: 3 });
    const hist = out.get(DATA_FILES.history(shardOf(1))) as HistoryShard;
    expect(hist['1'].goa).toEqual([[T0, 1.4], [T0 + H, 1.35]]);
  });

  it('cambios por provincia', () => {
    const ch = out.get(DATA_FILES.changes(28)) as ChangesJson;
    expect(ch.items).toHaveLength(1);
    expect(ch.items[0]).toMatchObject({ id: 1, fuel: 'goa', from: 1.4, to: 1.35, at: T0 + H });
  });

  it('tendencias y lugares', () => {
    const tr = out.get(DATA_FILES.trends('goa')) as TrendsJson;
    expect(tr.national).toHaveLength(1);
    expect(tr.national[0][0]).toBe('2026-08-20');
    expect(tr.national[0][4]).toBe(1); // 1 bajada
    const pl = out.get(DATA_FILES.places) as PlacesJson;
    expect(pl.items).toEqual([['Madrid', 28, expect.any(Number), expect.any(Number)]]);
  });

  it('validación rechaza pocos datos', () => {
    const v = validateOutputs(out);
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/estaciones activas/);
  });
});

describe('helpers', () => {
  it('canonicalBrand agrupa por marca principal', () => {
    expect(canonicalBrand('REPSOL')).toBe('REPSOL');
    expect(canonicalBrand('E.S. Repsol Norte')).toBe('REPSOL');
    expect(canonicalBrand('CEPSA')).toBe('MOEVE (CEPSA)');
    expect(canonicalBrand('Gasolinera Pepe')).toBe('GASOLINERA PEPE');
    expect(canonicalBrand('BPX')).toBe('BPX');
  });
  it('titleCase respeta partículas', () => {
    expect(titleCase('SAN SEBASTIÁN DE LOS REYES')).toBe('San Sebastián de los Reyes');
    expect(titleCase('CASTELLÓN / CASTELLÓ')).toBe('Castellón / Castelló');
  });
});
