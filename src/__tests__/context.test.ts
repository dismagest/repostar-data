import { describe, expect, it } from 'vitest';
import { mergeBrent, parseYahoo } from '../brent.ts';
import { decode, isRelevant, mergeNews, parseFeed } from '../news.ts';

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[El precio de la gasolina sube un 2 % esta semana]]></title><link>https://ex.com/a</link><pubDate>Thu, 27 Aug 2026 10:00:00 GMT</pubDate><description>texto</description></item>
<item><title>Resultados trimestrales de una empresa</title><link>https://ex.com/b</link><pubDate>Thu, 27 Aug 2026 09:00:00 GMT</pubDate><description>nada</description></item>
<item><title>Sin fecha</title><link>https://ex.com/c</link></item>
<item><title>Los &quot;chollos&quot; del di&#233;sel</title><link>https://ex.com/d</link><pubDate>Wed, 26 Aug 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`;

describe('news', () => {
  it('parsea items y filtra por relevancia', () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(3);
    expect(items[0].title).toBe('El precio de la gasolina sube un 2 % esta semana');
    const relevant = items.filter(isRelevant);
    expect(relevant.map((i) => i.url)).toEqual(['https://ex.com/a', 'https://ex.com/d']);
    expect(relevant[1].title).toBe('Los "chollos" del diésel');
  });
  it('decode maneja entidades', () => {
    expect(decode('&lt; &#x41; &nbsp;x')).toBe('< A x');
    expect(decode('&amp;lt;')).toBe('&lt;');
  });
  it('mergeNews deduplica, ordena, filtra por antigüedad y limita', () => {
    const now = new Date('2026-08-27T12:00:00Z');
    const merged = mergeNews(
      { updatedAt: '', items: [{ title: 'vieja', url: 'https://ex.com/old', source: 'X', publishedAt: '2026-07-01T00:00:00Z' }, { title: 'dup', url: 'https://ex.com/a', source: 'X', publishedAt: '2026-08-26T00:00:00Z' }] },
      [{ title: 'nueva', url: 'https://ex.com/a', source: 'Y', publishedAt: '2026-08-27T10:00:00Z' }],
      now,
    );
    expect(merged.items).toEqual([{ title: 'nueva', url: 'https://ex.com/a', source: 'Y', publishedAt: '2026-08-27T10:00:00Z' }]);
  });
});

describe('brent', () => {
  it('parseYahoo omite nulos y redondea', () => {
    const s = parseYahoo({ chart: { result: [{ timestamp: [Date.UTC(2026, 7, 18) / 1000, Date.UTC(2026, 7, 19) / 1000, Date.UTC(2026, 7, 20) / 1000], indicators: { quote: [{ close: [87.123, null, 88.456] }] } }] } });
    expect(s).toEqual([['2026-08-18', 87.12], ['2026-08-20', 88.46]]);
  });
  it('mergeBrent combina y ordena', () => {
    const m = mergeBrent({ updatedAt: '', series: [['2026-08-18', 80]] }, [['2026-08-19', 81], ['2026-08-18', 80.5]], new Date('2026-08-27T00:00:00Z'));
    expect(m.series).toEqual([['2026-08-18', 80.5], ['2026-08-19', 81]]);
  });
});
