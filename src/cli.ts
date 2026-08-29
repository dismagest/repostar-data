/**
 * CLI del pipeline.
 *
 *   node src/cli.ts run      --state <url|fichero> --out <dir> [--backfill N] [--skip-context]
 *   node src/cli.ts backfill --days N --state <fichero> --out <dir>
 *
 * Variables de entorno:
 *   ALLOW_EMPTY_STATE=1  permite arrancar sin estado previo (primera ejecución / backfill).
 */
import { join } from 'node:path';
import { applySnapshot } from './apply.ts';
import { fetchBrent } from './brent.ts';
import { fetchEvSites } from './ev.ts';
import { DATA_FILES } from './contract.ts';
import { fetchCurrent, fetchHistoric, madridOffsetMinutes } from './ministry.ts';
import { fetchNews } from './news.ts';
import { buildOutputs, validateOutputs, writeOutputs } from './outputs.ts';
import { isEmptyState, loadState, saveState, StateLoadError } from './state.ts';

const NEWS_MAX_AGE_H = 3;
const BRENT_MAX_AGE_H = 12;
/** El DATEX2 de la DGT se publica a diario; 20 h evita perder un día por desfase horario. */
const EV_MAX_AGE_H = 20;

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const has = (name: string) => process.argv.includes(`--${name}`);
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function main() {
  const cmd = process.argv[2] ?? 'run';
  const stateSource = arg('state');
  const outDir = arg('out', 'out')!;
  const backfillDays = Number(arg('backfill', cmd === 'backfill' ? arg('days', '30') : '0')) || 0;
  const allowEmpty = process.env.ALLOW_EMPTY_STATE === '1' || has('allow-empty');

  log(`modo=${cmd} estado=${stateSource ?? '(vacío)'} salida=${outDir} backfill=${backfillDays}`);

  let state;
  try {
    state = await loadState(stateSource);
  } catch (e) {
    if (e instanceof StateLoadError) {
      console.error(`ERROR cargando el estado: ${e.message}. Abortamos para no perder el histórico.`);
      process.exit(2);
    }
    throw e;
  }
  const wasEmpty = isEmptyState(state);
  if (wasEmpty && !allowEmpty) {
    console.error('ERROR: el estado está vacío y ALLOW_EMPTY_STATE no está activo. Abortamos.');
    process.exit(3);
  }
  log(`estado cargado: ${Object.keys(state.stations).length} estaciones, ${Object.keys(state.current).length} precios, ${state.runs.length} ejecuciones previas`);

  // Backfill diario (solo días anteriores a los ya aplicados).
  if (backfillDays > 0) {
    const today = new Date();
    for (let d = backfillDays; d >= 1; d--) {
      const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - d));
      // Atribuimos el snapshot a las 06:00 hora de Madrid de ese día.
      const naive = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 6, 0, 0);
      const ts = Math.floor((naive - madridOffsetMinutes(new Date(naive)) * 60_000) / 1000);
      if (ts <= state.lastSnapshotTs) {
        log(`backfill: ${day.toISOString().slice(0, 10)} ya aplicado, se omite`);
        continue;
      }
      const snap = await fetchHistoric(day);
      const r = applySnapshot(state, snap, ts, 'backfill');
      log(`backfill ${day.toISOString().slice(0, 10)}: ${r.seen} estaciones, ${r.changed} cambios, ${r.added} nuevos`);
    }
  }

  // Snapshot actual.
  const snap = await fetchCurrent();
  const nowTs = Math.floor(Date.now() / 1000);
  const r = applySnapshot(state, snap, nowTs, 'run');
  log(`actual (${snap.sourceDate}): ${r.seen} estaciones, ${r.changed} cambios, ${r.added} nuevos`);

  // Contexto: noticias y Brent (best effort).
  if (!has('skip-context')) {
    const ageH = (iso: string | undefined) => (iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : Infinity);
    if (ageH(state.news?.updatedAt) >= NEWS_MAX_AGE_H) {
      try {
        state.news = await fetchNews(state.news, log);
        log(`noticias: ${state.news.items.length} titulares`);
      } catch (e) {
        log(`noticias: fallo ignorado: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (ageH(state.ev?.fetchedAt) >= EV_MAX_AGE_H) {
      try {
        const { sites, publishedAt } = await fetchEvSites();
        if (sites.length >= 5000) {
          state.ev = { fetchedAt: new Date().toISOString(), publishedAt, sites };
          log(`electrolineras: ${sites.length} emplazamientos (publicado ${publishedAt})`);
        } else {
          log(`electrolineras: solo ${sites.length} emplazamientos, se conserva el anterior`);
        }
      } catch (e) {
        log(`electrolineras: fallo ignorado: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (ageH(state.brent?.updatedAt) >= BRENT_MAX_AGE_H) {
      try {
        state.brent = await fetchBrent(state.brent);
        log(`brent: ${state.brent.series.length} sesiones, última ${state.brent.series.at(-1)?.join(' = ')}`);
      } catch (e) {
        log(`brent: fallo ignorado: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // Salidas.
  const out = buildOutputs(state);
  const v = validateOutputs(out);
  if (!v.ok) {
    console.error(`ERROR validación: ${v.problems.join('; ')}. No se publica.`);
    process.exit(4);
  }
  const bytes = await writeOutputs(outDir, out);
  await saveState(join(outDir, DATA_FILES.state), state);
  log(`escritos ${out.size} ficheros (${(bytes / 1e6).toFixed(1)} MB) + state.json en ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
