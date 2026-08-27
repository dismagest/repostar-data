/**
 * Titulares de prensa española sobre carburantes: feeds RSS de medios + filtro por palabras clave.
 */
import type { NewsItem, NewsJson } from './contract.ts';

export const FEEDS: { source: string; url: string }[] = [
  { source: 'Expansión', url: 'https://e00-expansion.uecdn.es/rss/empresas/energia.xml' },
  { source: 'El Periódico de la Energía', url: 'https://elperiodicodelaenergia.com/feed/' },
  { source: '20minutos', url: 'https://www.20minutos.es/rss/motor/' },
  { source: 'Motorpasión', url: 'https://www.motorpasion.com/feedburner.xml' },
  { source: 'ABC', url: 'https://www.abc.es/rss/2.0/economia/' },
  { source: 'El Español', url: 'https://www.elespanol.com/rss/invertia/' },
  { source: 'La Vanguardia', url: 'https://www.lavanguardia.com/rss/economia.xml' },
];

export const KEYWORDS = /gasolin|di[eé]sel|carburant|combustible|gas[oó]leo|repost|glp\b|autogas|brent|petr[oó]leo|crudo|hidrocarburo|surtidor|opep|opec/i;

export const NEWS_RETENTION_DAYS = 30;
export const NEWS_MAX_ITEMS = 60;

export interface ParsedItem {
  title: string;
  url: string;
  publishedAt: string;
  description: string;
}

/** Parser RSS/Atom minimalista (suficiente para titulares). */
export function parseFeed(xml: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  for (const b of blocks) {
    const title = decode(tag(b, 'title'));
    let url = decode(tag(b, 'link'));
    if (!url) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      url = m ? decode(m[1]) : '';
    }
    const dateRaw = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const d = dateRaw ? new Date(dateRaw) : new Date(NaN);
    const description = decode(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded')).replace(/<[^>]+>/g, ' ');
    if (!title || !url || Number.isNaN(d.getTime())) continue;
    items.push({ title, url: url.trim(), publishedAt: d.toISOString(), description });
  }
  return items;
}

function tag(block: string, name: string): string {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

export function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isRelevant(item: ParsedItem): boolean {
  return KEYWORDS.test(item.title) || KEYWORDS.test(item.description.slice(0, 400));
}

export function mergeNews(existing: NewsJson | null, fresh: NewsItem[], now = new Date()): NewsJson {
  const byUrl = new Map<string, NewsItem>();
  for (const it of existing?.items ?? []) byUrl.set(it.url, it);
  for (const it of fresh) byUrl.set(it.url, it);
  const cutoff = now.getTime() - NEWS_RETENTION_DAYS * 86_400_000;
  const items = [...byUrl.values()]
    .filter((it) => new Date(it.publishedAt).getTime() >= cutoff && new Date(it.publishedAt).getTime() <= now.getTime() + 3_600_000)
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
    .slice(0, NEWS_MAX_ITEMS);
  return { updatedAt: now.toISOString(), items };
}

export async function fetchNews(existing: NewsJson | null, log: (m: string) => void = () => {}): Promise<NewsJson> {
  const fresh: NewsItem[] = [];
  await Promise.all(
    FEEDS.map(async (f) => {
      try {
        const res = await fetch(f.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RepostarBot/1.0; +https://github.com/dismagest/repostar-data)' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        const relevant = parseFeed(xml).filter(isRelevant);
        for (const it of relevant) fresh.push({ title: it.title, url: it.url, source: f.source, publishedAt: it.publishedAt });
        log(`news: ${f.source}: ${relevant.length} relevantes`);
      } catch (e) {
        log(`news: ${f.source} falló: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
  return mergeNews(existing, fresh);
}
