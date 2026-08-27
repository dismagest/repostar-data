import { describe, expect, it } from 'vitest';
import { applySnapshot, dayDirection, key, referenceThresholds } from '../apply.ts';
import { levelFor } from '../contract.ts';
import type { NormalizedStation, Snapshot } from '../ministry.ts';
import { emptyState } from '../state.ts';

const T0 = Date.UTC(2026, 7, 20, 10, 0) / 1000; // 20 ago 2026 12:00 Madrid
const H = 3600;
const D = 86400;

function station(id: number, prices: NormalizedStation['prices'], over: Partial<NormalizedStation> = {}): NormalizedStation {
  return {
    id, name: `EESS ${id}`, address: 'Calle 1', locality: 'MADRID', municipality: 'Madrid', provinceId: 28, provinceName: 'MADRID',
    postalCode: '28001', schedule: 'L-D: 24H', lat: 40.4 + id / 1000, lng: -3.7, margin: 'D', saleType: 'P', prices, ...over,
  };
}
const snap = (stations: NormalizedStation[], sourceDate = '2026-08-20T10:00:00.000Z'): Snapshot => ({ sourceDate, stations });

describe('applySnapshot', () => {
  it('primer snapshot: alta de precios sin contar como cambio', () => {
    const st = emptyState();
    const r = applySnapshot(st, snap([station(1, { goa: 1.5, g95: 1.6 }), station(2, { goa: 1.4 })]), T0);
    expect(r).toEqual({ seen: 2, changed: 0, added: 3 });
    expect(st.current[key(1, 'goa')]).toEqual([1.5, null, T0]);
    expect(st.history[key(1, 'goa')]).toEqual([[T0, 1.5]]);
    expect(st.lastSnapshotTs).toBe(T0);
    expect(st.daily.goa.ES['2026-08-20'].n).toBe(2);
    expect(st.daily.goa.ES['2026-08-20'].nUp).toBe(0);
  });

  it('cambio de precio: actualiza actual, histórico y contadores diarios', () => {
    const st = emptyState();
    applySnapshot(st, snap([station(1, { goa: 1.5 }), station(2, { goa: 1.4 })]), T0);
    const r = applySnapshot(st, snap([station(1, { goa: 1.55 }), station(2, { goa: 1.4 })]), T0 + H);
    expect(r.changed).toBe(1);
    expect(st.current[key(1, 'goa')]).toEqual([1.55, 1.5, T0 + H]);
    expect(st.history[key(1, 'goa')]).toEqual([[T0, 1.5], [T0 + H, 1.55]]);
    expect(st.daily.goa.ES['2026-08-20'].nUp).toBe(1);
    expect(st.daily.goa.ES['2026-08-20'].nDown).toBe(0);
    expect(st.daily.goa['28']['2026-08-20'].nUp).toBe(1);
  });

  it('precio igual: no toca histórico', () => {
    const st = emptyState();
    applySnapshot(st, snap([station(1, { goa: 1.5 })]), T0);
    applySnapshot(st, snap([station(1, { goa: 1.5 })]), T0 + H);
    expect(st.history[key(1, 'goa')]).toHaveLength(1);
  });

  it('la estación deja de vender un combustible: desaparece de current', () => {
    const st = emptyState();
    applySnapshot(st, snap([station(1, { goa: 1.5, glp: 0.9 })]), T0);
    applySnapshot(st, snap([station(1, { goa: 1.5 })]), T0 + H);
    expect(st.current[key(1, 'glp')]).toBeUndefined();
    expect(st.current[key(1, 'goa')]).toBeDefined();
  });

  it('estación ausente del snapshot: queda inactiva pero conserva datos', () => {
    const st = emptyState();
    applySnapshot(st, snap([station(1, { goa: 1.5 }), station(2, { goa: 1.4 })]), T0);
    applySnapshot(st, snap([station(1, { goa: 1.5 })]), T0 + H);
    expect(st.stations[2].lastSeen).toBe(T0);
    expect(st.current[key(2, 'goa')]).toBeDefined();
    expect(st.daily.goa.ES['2026-08-20'].n).toBe(1); // solo activas
  });

  it('retención: histórico de más de 30 días se poda conservando el último punto anterior', () => {
    const st = emptyState();
    applySnapshot(st, snap([station(1, { goa: 1.5 })]), T0);
    applySnapshot(st, snap([station(1, { goa: 1.6 })]), T0 + 5 * D);
    applySnapshot(st, snap([station(1, { goa: 1.7 })]), T0 + 40 * D);
    expect(st.history[key(1, 'goa')]).toEqual([[T0 + 5 * D, 1.6], [T0 + 40 * D, 1.7]]);
  });

  it('estaciones no vistas en 30 días se eliminan', () => {
    const st = emptyState();
    applySnapshot(st, snap([station(1, { goa: 1.5 }), station(2, { goa: 1.4 })]), T0);
    applySnapshot(st, snap([station(1, { goa: 1.5 })]), T0 + 31 * D);
    expect(st.stations[2]).toBeUndefined();
    expect(st.current[key(2, 'goa')]).toBeUndefined();
  });
});

describe('dayDirection', () => {
  it('detecta subida/bajada neta del día y nada si es el primer registro', () => {
    expect(dayDirection([[T0, 1.5]], '2026-08-20')).toBeNull();
    expect(dayDirection([[T0 - D, 1.5], [T0, 1.6]], '2026-08-20')).toBe('up');
    expect(dayDirection([[T0 - D, 1.5], [T0, 1.6], [T0 + H, 1.45]], '2026-08-20')).toBe('down');
    expect(dayDirection([[T0 - D, 1.5], [T0, 1.6], [T0 + H, 1.5]], '2026-08-20')).toBeNull();
  });
});

describe('semáforo', () => {
  it('usa la provincia si tiene ≥ 30 muestras, si no nacional', () => {
    const st = emptyState();
    const stations: NormalizedStation[] = [];
    for (let i = 1; i <= 40; i++) stations.push(station(i, { goa: 1.4 + i * 0.01 }, { provinceId: 28 }));
    for (let i = 41; i <= 45; i++) stations.push(station(i, { goa: 1.9 }, { provinceId: 51, provinceName: 'CEUTA' }));
    applySnapshot(st, snap(stations), T0);
    expect(referenceThresholds(st, 'goa', 28)!.n).toBe(40);
    expect(referenceThresholds(st, 'goa', 51)!.n).toBe(45); // nacional
  });

  it('levelFor aplica las cuatro reglas', () => {
    const t = { p10: 1.4, p25: 1.45, median: 1.5, p75: 1.55, n: 100 };
    expect(levelFor(1.39, t)).toBe(3); // ≤ p10 y ≤ mediana − 0,05
    expect(levelFor(1.44, t)).toBe(2);
    expect(levelFor(1.5, t)).toBe(1);
    expect(levelFor(1.55, t)).toBe(0);
    // p10 muy cerca de la mediana: no hay chollo aunque esté por debajo de p10
    expect(levelFor(1.49, { p10: 1.495, p25: 1.5, median: 1.5, p75: 1.55, n: 100 })).toBe(2);
  });
});
