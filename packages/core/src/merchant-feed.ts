/**
 * Reading the Merchant Center feed a `merchantFeed` input points at. The
 * parser in `inputs.ts` stays pure and only checks the path is text; this is
 * where the file becomes items, so a detector reads `items` and never a file.
 *
 * Strict, as `parseInputs` is: an item missing a required field, a price that
 * is not `<number> <ISO 4217>`, a link that is not an absolute http(s) URL, or
 * a repeated id refuses the whole file, every problem listed by item. A feed
 * with a silent gap would read as a product the site does not sell.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AuditInputs, MerchantFeedItem } from './inputs.js';

const REQUIRED = ['id', 'link', 'price', 'availability'] as const;
const FIELDS = ['id', 'link', 'price', 'availability', 'gtin', 'brand'] as const;

type Raw = Partial<Record<(typeof FIELDS)[number], string>>;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function text(source: string): string {
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(source.trim());
  if (cdata !== null) return cdata[1]!.trim();
  return source
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec: string, hex: string, name: string) => {
      if (dec !== undefined) return String.fromCodePoint(Number(dec));
      if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .trim();
}

/** Items of an RSS feed with the `g:` namespace, as raw text per field. */
function rssItems(xml: string): Raw[] {
  const items: Raw[] = [];
  for (const block of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const raw: Raw = {};
    for (const field of FIELDS) {
      // g:id, g:price… ; `link` is the plain RSS element.
      const tag = field === 'link' ? 'link' : `g:${field}`;
      const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block[1]!);
      if (m !== null) raw[field] = text(m[1]!);
    }
    items.push(raw);
  }
  return items;
}

/** Items of a tab-separated feed: a header row names the columns, `g:` prefix optional. */
function tsvItems(source: string): Raw[] {
  const rows = source.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (rows.length === 0) return [];
  const header = rows[0]!.split('\t').map((h) => h.trim().toLowerCase().replace(/^g:/, ''));
  const missing = REQUIRED.filter((f) => !header.includes(f));
  if (missing.length > 0) throw new Error(`TSV header is missing ${missing.join(', ')}`);
  return rows.slice(1).map((row) => {
    const cells = row.split('\t');
    const raw: Raw = {};
    for (const field of FIELDS) {
      const at = header.indexOf(field);
      const cell = at < 0 ? undefined : cells[at]?.trim();
      if (cell !== undefined && cell !== '') raw[field] = cell;
    }
    return raw;
  });
}

/** The typed items, or a thrown error listing every problem with the raw ones. */
export function parseMerchantFeedItems(raws: readonly Raw[]): MerchantFeedItem[] {
  const problems: string[] = [];
  const items: MerchantFeedItem[] = [];
  const seen = new Set<string>();
  raws.forEach((raw, index) => {
    const label = `item ${index + 1}${raw.id === undefined ? '' : ` (${raw.id})`}`;
    const before = problems.length;
    for (const field of REQUIRED) {
      if (raw[field] === undefined || raw[field] === '') problems.push(`${label}: ${field} is required`);
    }
    let price = Number.NaN;
    let currency = '';
    if (raw.price !== undefined && raw.price !== '') {
      const m = /^(\d+(?:\.\d+)?)\s+([A-Z]{3})$/.exec(raw.price);
      if (m === null) problems.push(`${label}: price "${raw.price}" is not "<number> <ISO 4217 code>"`);
      else {
        price = Number(m[1]);
        currency = m[2]!;
      }
    }
    if (raw.link !== undefined && raw.link !== '') {
      try {
        if (!/^https?:$/.test(new URL(raw.link).protocol)) throw new Error('scheme');
      } catch {
        problems.push(`${label}: link "${raw.link}" is not an absolute http(s) URL`);
      }
    }
    if (raw.id !== undefined && raw.id !== '') {
      if (seen.has(raw.id)) problems.push(`${label}: id is repeated`);
      seen.add(raw.id);
    }
    if (problems.length > before) return;
    items.push({
      id: raw.id!,
      link: raw.link!,
      price,
      currency,
      availability: raw.availability!.toLowerCase().replace(/_/g, ' '),
      ...(raw.gtin !== undefined ? { gtin: raw.gtin } : {}),
      ...(raw.brand !== undefined ? { brand: raw.brand } : {}),
    });
  });
  if (problems.length > 0) throw new Error(problems.join('; '));
  return items;
}

/** Read a whole feed file: RSS when it opens with XML, TSV otherwise. */
export function readMerchantFeed(file: string): MerchantFeedItem[] {
  const source = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const xml = /^\s*<(?:\?xml|rss|feed)\b/i.test(source);
  return parseMerchantFeedItems(xml ? rssItems(source) : tsvItems(source));
}

/**
 * Read the feed a `merchantFeed` section points at and return the inputs with
 * `items` filled in. The path resolves against `baseDir`. A file that cannot be
 * read, or is not a valid feed, throws with its path: a feed the person named
 * and we cannot read is an error, not a gap.
 */
export function loadMerchantFeed(inputs: AuditInputs, baseDir: string): AuditInputs {
  const section = inputs.merchantFeed;
  if (section === undefined) return inputs;
  const file = resolve(baseDir, section.path);
  try {
    return { ...inputs, merchantFeed: { ...section, items: readMerchantFeed(file) } };
  } catch (error) {
    throw new Error(`merchant feed (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `loadMerchantFeed` for an inputs file: the path is relative to where that file lives. */
export function loadMerchantFeedFor(inputs: AuditInputs, inputsFile: string): AuditInputs {
  return loadMerchantFeed(inputs, dirname(resolve(inputsFile)));
}
