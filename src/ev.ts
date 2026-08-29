/**
 * Puntos de recarga para vehículos eléctricos.
 *
 * Fuente estática oficial: publicación DATEX2 v3 de la DGT (datos del MITERD), ~100 MB de XML
 * con todos los emplazamientos, cargadores y conectores de España, actualizada a diario y sin
 * clave (licencia CC-BY). El fichero es enorme, así que no se parsea como árbol: se recorren los
 * bloques <egi:energyInfrastructureSite> con expresiones regulares.
 */
import { EV_CONNECTORS, type EvConnectorId, type EvSite } from './contract.ts';

export const DATEX2_URL = 'https://infocar.dgt.es/datex2/v3/miterd/EnergyInfrastructureTablePublication/electrolineras.xml';

const SITE_RE = /<egi:energyInfrastructureSite\b[^>]*\bid="([^"]+)"[\s\S]*?<\/egi:energyInfrastructureSite>/g;
const REFILL_RE = /<egi:refillPoint\b[\s\S]*?<\/egi:refillPoint>/g;
const CONNECTOR_RE = /<egi:connector>([\s\S]*?)<\/egi:connector>/g;

const tag = (block: string, name: string): string | null => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)<`));
  return m ? m[1].trim() : null;
};

/** Primer <com:value> dentro de un elemento (nombre de sitio, operador, líneas de dirección). */
const firstValue = (block: string): string | null => {
  const m = block.match(/<com:value[^>]*>([^<]*)<\/com:value>/);
  return m ? decodeXml(m[1].trim()) : null;
};

function decodeXml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();
}

/** Tipos DATEX2 → identificadores cortos de la app. */
const CONNECTOR_MAP: Record<string, EvConnectorId> = {
  iec62196T2COMBO: 'ccs2',
  iec62196T1COMBO: 'ccs1',
  chademo: 'chademo',
  iec62196T2: 'type2',
  iec62196T1: 'type1',
  iec62196T3A: 'type3',
  iec62196T3C: 'type3',
  chaoji: 'chaoji',
  tesla: 'tesla',
};

export function mapConnector(datexType: string): EvConnectorId {
  if (CONNECTOR_MAP[datexType]) return CONNECTOR_MAP[datexType];
  if (/^domestic/i.test(datexType)) return 'schuko';
  if (/^iec60309/i.test(datexType)) return 'cee';
  return 'other';
}

function addressPart(block: string, label: string): string | null {
  const re = new RegExp(`<com:value lang="es">${label}:\\s*([^<]*)<`);
  const m = block.match(re);
  return m ? decodeXml(m[1]) : null;
}

export function parseSite(block: string, id: string): EvSite | null {
  const lat = Number(tag(block, 'loc:latitude'));
  const lng = Number(tag(block, 'loc:longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0) return null;

  const nameBlock = block.match(/<fac:name>[\s\S]*?<\/fac:name>/);
  const name = nameBlock ? firstValue(nameBlock[0]) : null;
  const opBlock = block.match(/<fac:operator\b[\s\S]*?<\/fac:operator>/);
  const operator = opBlock ? firstValue(opBlock[0]) : null;
  const operatorId = opBlock ? (opBlock[0].match(/\bid="([^"]*)"/)?.[1] ?? null) : null;

  const hoursId = block.match(/OperatingHoursSpecification"\s+id="([^"]*)"/)?.[1] ?? null;
  const open24h = hoursId === '24/7';

  const auth = new Set<string>();
  for (const m of block.matchAll(/<egi:authenticationAndIdentificationMethods>([^<]+)</g)) auth.add(m[1].trim());

  const connectors: EvSite['connectors'] = [];
  let points = 0;
  let maxKw = 0;
  for (const rp of block.matchAll(REFILL_RE)) {
    points++;
    for (const c of rp[0].matchAll(CONNECTOR_RE)) {
      const body = c[1];
      const type = mapConnector(tag(body, 'egi:connectorType') ?? '');
      const watts = Number(tag(body, 'egi:maxPowerAtSocket'));
      const kw = Number.isFinite(watts) && watts > 0 ? Math.round(watts / 100) / 10 : 0;
      if (kw > maxKw) maxKw = kw;
      const existing = connectors.find((x) => x.type === type && x.kw === kw);
      if (existing) existing.n++;
      else connectors.push({ type, kw, n: 1 });
    }
  }
  if (points === 0) return null;
  connectors.sort((a, b) => b.kw - a.kw || b.n - a.n);

  const address = addressPart(block, 'Dirección');
  const municipality = addressPart(block, 'Municipio');
  const province = addressPart(block, 'Provincia');
  const postcode = tag(block, 'locx:postcode');
  const siteType = tag(block, 'egi:typeOfSite');

  return {
    id,
    name: name || operator || 'Punto de recarga',
    operator: operator ?? 'Operador desconocido',
    operatorId,
    lat: Math.round(lat * 1e5) / 1e5,
    lng: Math.round(lng * 1e5) / 1e5,
    address,
    municipality,
    province,
    postcode,
    siteType,
    open24h,
    hours: hoursId,
    auth: [...auth],
    points,
    maxKw,
    connectors,
  };
}

export function parseDatex2(xml: string): EvSite[] {
  const sites: EvSite[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(SITE_RE)) {
    const id = m[1];
    if (seen.has(id)) continue;
    const site = parseSite(m[0], id);
    if (site) {
      seen.add(id);
      sites.push(site);
    }
  }
  return sites;
}

export async function fetchEvSites(): Promise<{ sites: EvSite[]; publishedAt: string }> {
  const res = await fetch(DATEX2_URL, {
    headers: { 'User-Agent': 'RepostarPipeline/1.0 (+https://github.com/dismagest/repostar-data)' },
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`DATEX2 HTTP ${res.status}`);
  const xml = await res.text();
  const publishedAt = xml.match(/<com:publicationTime>([^<]+)</)?.[1] ?? new Date().toISOString();
  return { sites: parseDatex2(xml), publishedAt: new Date(publishedAt).toISOString() };
}

/** Potencia máxima → tramo de velocidad de carga (para colorear el mapa). */
export function speedTier(maxKw: number): 0 | 1 | 2 | 3 {
  if (maxKw >= 150) return 3; // ultrarrápida
  if (maxKw >= 50) return 2; // rápida
  if (maxKw >= 22) return 1; // semirrápida
  return 0; // lenta
}

export const EV_CONNECTOR_IDS = EV_CONNECTORS.map((c) => c.id);
