# repostar-data

Pipeline de datos abiertos de precios de carburantes en España para la app **Repostar**.

- Fuente: [Geoportal de Gasolineras](https://geoportalgasolineras.es/) del Ministerio para la Transición Ecológica y el Reto Demográfico (API REST pública).
- Se ejecuta cada hora en GitHub Actions y publica ficheros JSON estáticos en GitHub Pages.
- Mantiene histórico de 30 días por gasolinera y estadísticas diarias por provincia (semáforo de precios, subidas/bajadas, tendencias).
- Añade contexto: cotización del Brent (Yahoo Finance) y titulares de prensa (RSS de medios españoles, con enlace a la fuente).

## Ficheros publicados

Ver `src/contract.ts` (tipos y rutas). Resumen: `meta.json`, `layers/{fuel}.json`, `stations/{shard}.json`,
`history/{shard}.json`, `changes/{provinciaId}.json`, `trends/{fuel}.json`, `brent.json`, `news.json`, `places.json`.

## Ejecución local

```bash
# primera vez, con 30 días de histórico
ALLOW_EMPTY_STATE=1 node src/cli.ts run --backfill 30 --out out
# siguientes ejecuciones, reutilizando el estado publicado
node src/cli.ts run --state https://dismagest.github.io/repostar-data/state.json --out out
```

Requiere Node ≥ 24 (ejecuta TypeScript sin compilar). Sin dependencias.
