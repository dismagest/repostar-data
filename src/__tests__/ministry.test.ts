import { describe, expect, it } from 'vitest';
import { madridDate, normalizeResponse, normalizeStation, parseCoord, parseMinistryDate, parsePrice } from '../ministry.ts';

const raw = (over: Record<string, string> = {}): Record<string, string> => ({
  'C.P.': '02250',
  'Dirección': 'AVENIDA CASTILLA LA MANCHA, 26',
  'Horario': 'L-D: 07:00-22:00',
  'Latitud': '39,211417',
  'Localidad': 'ABENGIBRE',
  'Longitud (WGS84)': '-1,539167',
  'Margen': 'D',
  'Municipio': 'Abengibre',
  'Precio Gasoleo A': '1,789',
  'Precio Gasoleo B': '1,449',
  'Precio Gasolina 95 E5': '1,599',
  'Precio Gasolina 98 E5': '',
  'Provincia': 'ALBACETE',
  'Rótulo': 'Nº 10.935',
  'Tipo Venta': 'P',
  'IDEESS': '4375',
  'IDMunicipio': '52',
  'IDProvincia': '02',
  'IDCCAA': '07',
  ...over,
});

describe('parsePrice', () => {
  it('convierte coma decimal', () => expect(parsePrice('1,459')).toBe(1.459));
  it('vacío -> undefined', () => expect(parsePrice('')).toBeUndefined());
  it('valores absurdos -> undefined', () => {
    expect(parsePrice('0')).toBeUndefined();
    expect(parsePrice('99,9')).toBeUndefined();
    expect(parsePrice('abc')).toBeUndefined();
  });
});

describe('parseCoord', () => {
  it('convierte coma decimal y negativos', () => expect(parseCoord('-1,539167')).toBeCloseTo(-1.539167, 6));
});

describe('parseMinistryDate', () => {
  it('interpreta la fecha como hora de Madrid (verano = UTC+2)', () => {
    expect(parseMinistryDate('27/08/2026 19:02:54', new Date(0))).toBe('2026-08-27T17:02:54.000Z');
  });
  it('invierno = UTC+1', () => {
    expect(parseMinistryDate('15/01/2026 8:00:00', new Date(0))).toBe('2026-01-15T07:00:00.000Z');
  });
  it('formato desconocido -> fallback', () => {
    expect(parseMinistryDate('hoy', new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('madridDate', () => {
  it('cambia de día a las 00:00 de Madrid, no de UTC', () => {
    // 2026-08-27T22:30Z = 00:30 del 28 en Madrid
    expect(madridDate(Date.UTC(2026, 7, 27, 22, 30) / 1000)).toBe('2026-08-28');
    expect(madridDate(Date.UTC(2026, 7, 27, 21, 30) / 1000)).toBe('2026-08-27');
  });
});

describe('normalizeStation', () => {
  it('normaliza campos y solo incluye combustibles con precio', () => {
    const s = normalizeStation(raw())!;
    expect(s.id).toBe(4375);
    expect(s.lat).toBeCloseTo(39.211417, 6);
    expect(s.provinceId).toBe(2);
    expect(s.prices).toEqual({ goa: 1.789, g95: 1.599 });
    expect(s.name).toBe('Nº 10.935');
    expect(s.schedule).toBe('L-D: 07:00-22:00');
  });
  it('descarta estaciones sin coordenadas válidas o fuera de España', () => {
    expect(normalizeStation(raw({ Latitud: '' }))).toBeNull();
    expect(normalizeStation(raw({ Latitud: '60,0' }))).toBeNull();
    expect(normalizeStation(raw({ IDEESS: 'x' }))).toBeNull();
  });
  it('normalizeResponse deduplica ids y parsea la fecha', () => {
    const snap = normalizeResponse({ Fecha: '27/08/2026 19:02:54', ListaEESSPrecio: [raw(), raw(), raw({ IDEESS: '5' })] });
    expect(snap.stations).toHaveLength(2);
    expect(snap.sourceDate).toBe('2026-08-27T17:02:54.000Z');
  });
});
