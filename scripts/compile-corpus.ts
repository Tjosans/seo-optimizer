/**
 * Compile the preserved v4.4 TSV export into the structured YAML corpus.
 *
 * The TSV under corpus/source/ is an immutable provenance record of the original
 * workbook. This script enriches it with the fields the engine needs but the
 * spreadsheet does not carry: applicability predicates, normalized owner roles,
 * structured cadence, automation tier, remediation class, detector bindings and
 * resolved citations.
 *
 * After the first compile the YAML is the authoritative, hand-editable corpus.
 * Re-running this regenerates it from source and discards manual YAML edits.
 *
 * Build-time tool: run directly on Node's TypeScript support, never bundled.
 *
 *     npm run corpus:compile
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AutomationTier, RemediationClass, Role, SourceRef } from '../packages/core/src/check.ts';
import { TRIAGE } from './triage.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus', 'source');
const OUT = join(ROOT, 'corpus', 'v4.4');

const CORPUS_VERSION = '4.4';
const CORPUS_REVIEWED = '2026-08-27';

// --- applicability: "Applies to" text -> site-profile flags ------------------
// Universal checks apply to every site. Everything else is in scope only when
// the site profile carries at least one of the listed flags.
type Applicability = readonly [universal: boolean, anyFlags: readonly string[]];

const APPLICABILITY: Readonly<Record<string, Applicability>> = {
  'All sites': [true, []],
  'All sites; obligations vary': [true, []],
  'All sites; conformance target follows the 0.9 scope': [true, []],
  'Multilingual / multi-country': [false, ['multilingual']],
  'Migration / redesign / domain or URL change': [false, ['migration']],
  'E-commerce / product catalogue': [false, ['ecommerce']],
  'E-commerce or multilingual / multi-country sites': [false, ['ecommerce', 'multilingual']],
  'Large catalogues / faceted navigation': [false, ['faceted-nav']],
  'Long listings / pagination / infinite scroll': [false, ['pagination']],
  'Large / JS-heavy / marketplace': [false, ['large-site', 'js-heavy', 'marketplace']],
  'Local businesses': [false, ['local-business']],
  'Sites using analytics or conversion measurement': [false, ['analytics']],
  'Sites using analytics, conversion tags or consent controls': [false, ['analytics', 'consent']],
  'Sites where consent is required and/or Google tags use Consent Mode': [false, ['consent']],
  'Sites with meaningful images or video': [false, ['media']],
  'Sites where image search, Discover or image-rich search appearance matters': [false, ['image-search']],
  'Sites where indexable video is a primary content asset': [false, ['video']],
  'Sites publishing indexable PDFs or other non-HTML files': [false, ['non-html-files']],
  'Sites running A/B tests, personalization or experiments': [false, ['experiments']],
  'Sites deciding how their content is used by AI search and training systems': [false, ['ai-policy']],
  'Sites with an approved AI crawler policy': [false, ['ai-policy']],
  'Sites with available AI-search reporting or meaningful AI referrals': [false, ['ai-reporting']],
  'Sites prioritizing IndexNow search engines': [false, ['indexnow']],
  'Sites prioritizing Bing': [false, ['bing']],
  'Templates eligible for useful structured data': [false, ['structured-data']],
  'Sites implementing structured data': [false, ['structured-data']],
  'Sites using structured data, internationalization or merchant feeds': [false, ['structured-data', 'multilingual', 'merchant-feed']],
  'Sites with paywalled or registration-gated indexable content': [false, ['paywall']],
  'News, publisher or editorial sites targeting Discover / Preferred Sources': [false, ['publisher']],
  'Sites with hierarchical content or category structures': [false, ['hierarchical']],
  'YMYL, regulated, product or consequential factual claims': [false, ['ymyl']],
  'Sites allowing public UGC, marketplace listings, partner pages or other third-party content': [false, ['ugc']],
};

// --- owners: free text -> normalized roles ----------------------------------
// Ordered longest-first so "business owner" is not shadowed by "business".
const ROLE_TOKENS: ReadonlyArray<readonly [token: string, role: Role]> = [
  ['trust & safety', 'trust-safety'], ['trust and safety', 'trust-safety'],
  ['subject expert', 'subject-expert'], ['business owner', 'business'],
  ['infrastructure', 'infrastructure'], ['merchandising', 'merchandising'],
  ['accessibility', 'accessibility'], ['localization', 'localization'],
  ['operations', 'operations'], ['analytics', 'analytics'],
  ['marketing', 'marketing'], ['developer', 'developer'],
  ['designer', 'designer'], ['security', 'security'],
  ['audience', 'audience'], ['business', 'business'],
  ['content', 'content'], ['product', 'product'],
  ['privacy', 'privacy'], ['legal', 'legal'], ['seo', 'seo'],
];

function parseRoles(text: string): Role[] {
  const low = text.toLowerCase();
  const roles: Role[] = [];
  for (const [token, role] of ROLE_TOKENS) {
    if (low.includes(token) && !roles.includes(role)) roles.push(role);
  }
  return roles.length > 0 ? roles : ['seo'];
}

// --- cadence: free text -> structured triggers / interval / window ----------
type Interval = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

const INTERVALS: ReadonlyArray<readonly [RegExp, Interval]> = [
  [/quarterly/, 'quarterly'],
  [/monthly|every month/, 'monthly'],
  [/weekly/, 'weekly'],
  [/daily/, 'daily'],
  [/yearly|annual/, 'yearly'],
];

const TRIGGERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/every pr\b/, 'every-pr'],
  [/every new template|every template|new template/, 'every-template'],
  [/every content release|every publish|every page publish|every major/, 'every-publish'],
  [/major release/, 'every-release'],
  [/immediately before launch|before launch|before each locale|pre-?launch/, 'before-launch'],
  [/go-live checklist/, 'before-launch'],
  [/launch day/, 'launch-day'],
  [/launch window/, 'launch-window'],
  [/before build|before routes are coded|before design\/build|at strategy|before content|before gated|before publisher|before ugc|before file templates|before product templates|before each experiment/, 'before-build'],
  [/cutover/, 'cutover'],
  [/when .{0,40}(ship|built|coded|launch)/, 'on-feature-ship'],
  [/after .{0,40}(change|move|release|platform)/, 'on-change'],
  [/continuous/, 'continuous'],
  [/once/, 'once'],
];

interface ParsedCadence {
  triggers: string[];
  interval: Interval | null;
  windowDays: number | null;
}

function parseCadence(text: string): ParsedCadence {
  const low = text.toLowerCase();
  const triggers: string[] = [];
  for (const [pattern, name] of TRIGGERS) {
    if (pattern.test(low) && !triggers.includes(name)) triggers.push(name);
  }
  let interval: Interval | null = null;
  for (const [pattern, name] of INTERVALS) {
    if (pattern.test(low)) { interval = name; break; }
  }
  const match = /(\d+)\s*days/.exec(low);
  return { triggers, interval, windowDays: match ? Number(match[1]) : null };
}

// --- citations: fuzzy-match Notes references onto the Sources sheet ---------
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'to', 'google', 'see', 'sources']);
const ALIASES: Readonly<Record<string, string>> = {
  eaa: 'European Accessibility Act',
  cwv: 'Core Web Vitals tools',
};

function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== '' && !STOP.has(t)),
  );
}

/** Resolve "See Sources: X and Y." in Notes to Sources-sheet rows. */
function matchSources(notes: string, sources: readonly SourceRef[]): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set<string>();

  for (const reference of notes.matchAll(/See Sources:\s*([^.]+)/g)) {
    for (const raw of (reference[1] ?? '').split(/,| and /)) {
      const fragment = raw.trim();
      if (fragment === '') continue;
      const alias = ALIASES[fragment.toLowerCase()];
      const want = tokens(alias ?? fragment);
      if (want.size === 0) continue;

      let best: SourceRef | null = null;
      let bestScore = 0;
      for (const source of sources) {
        const have = tokens(source.topic);
        if (have.size === 0) continue;
        let overlap = 0;
        for (const token of want) if (have.has(token)) overlap += 1;
        const score = overlap / want.size;
        if (score > bestScore) { best = source; bestScore = score; }
      }
      if (best && bestScore >= 0.6 && !seen.has(best.url)) {
        seen.add(best.url);
        out.push(best);
      }
    }
  }
  return out;
}

// --- minimal YAML emitter ---------------------------------------------------
/** Emit a string as a folded block scalar, or "" when empty. */
function yStr(value: string, indent: number): string {
  if (value === '') return '""';
  return '>-\n' + ' '.repeat(indent + 2) + value;
}

function yList(values: readonly string[]): string {
  if (values.length === 0) return '[]';
  return '[' + values.map((v) => `"${v}"`).join(', ') + ']';
}

interface CompiledCheck {
  id: string;
  phase: number;
  phaseLabel: string;
  priority: string;
  profile: string;
  launchGate: boolean;
  universal: boolean;
  anyFlags: readonly string[];
  appliesTo: string;
  task: string;
  whatToDo: string;
  doneWhen: string;
  owners: readonly Role[];
  ownerSource: string;
  tools: string;
  triggers: readonly string[];
  interval: Interval | null;
  windowDays: number | null;
  cadenceSource: string;
  notes: string;
  automation: AutomationTier;
  remediationClass: RemediationClass;
  detectors: readonly string[];
  sources: readonly SourceRef[];
}

function emitCheck(c: CompiledCheck): string {
  const i = 2;
  const p = ' '.repeat(i);
  const lines = [
    `- id: "${c.id}"`,
    `${p}phase: ${c.phase}`,
    `${p}phaseLabel: "${c.phaseLabel}"`,
    `${p}priority: ${c.priority}`,
    `${p}profile: ${c.profile}`,
    `${p}launchGate: ${c.launchGate}`,
    `${p}applicability:`,
    `${p}  universal: ${c.universal}`,
    `${p}  any: ${yList(c.anyFlags)}`,
    `${p}  source: ${yStr(c.appliesTo, i + 2)}`,
    `${p}task: ${yStr(c.task, i)}`,
    `${p}whatToDo: ${yStr(c.whatToDo, i)}`,
    `${p}doneWhen: ${yStr(c.doneWhen, i)}`,
    `${p}owners: ${yList(c.owners)}`,
    `${p}ownerSource: ${yStr(c.ownerSource, i)}`,
    `${p}tools: ${yStr(c.tools, i)}`,
    `${p}cadence:`,
    `${p}  triggers: ${yList(c.triggers)}`,
  ];
  if (c.interval) lines.push(`${p}  interval: ${c.interval}`);
  if (c.windowDays) lines.push(`${p}  windowDays: ${c.windowDays}`);
  lines.push(`${p}  source: ${yStr(c.cadenceSource, i + 2)}`);
  lines.push(
    `${p}notes: ${yStr(c.notes, i)}`,
    `${p}automation: ${c.automation}`,
    `${p}remediationClass: ${c.remediationClass}`,
    `${p}detectors: ${yList(c.detectors)}`,
  );
  if (c.sources.length > 0) {
    lines.push(`${p}sources:`);
    for (const s of c.sources) {
      lines.push(`${p}  - topic: "${s.topic}"`);
      lines.push(`${p}    url: "${s.url}"`);
      lines.push(`${p}    usedFor: ${yStr(s.usedFor, i + 4)}`);
      lines.push(`${p}    verified: "${s.verified}"`);
    }
  } else {
    lines.push(`${p}sources: []`);
  }
  return lines.join('\n');
}

/**
 * Read a TSV export as rows of raw cells.
 *
 * The export carries no quoted fields or embedded newlines — a lone double
 * quote appears mid-cell in one Notes row, where it is literal text — so a
 * split is exact and avoids pulling in a CSV dependency.
 */
function readTsv(path: string): string[][] {
  return readFileSync(path, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => line.split('\t'));
}

/** Write LF-terminated UTF-8, so the corpus is byte-stable across platforms. */
const write = (path: string, lines: readonly string[]): void =>
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');

/** Cell accessor: the export is ragged, and a missing trailing cell is empty. */
const cell = (row: readonly string[], index: number): string => (row[index] ?? '').trim();

function main(): number {
  const sources: SourceRef[] = readTsv(join(SRC, 'sources.tsv'))
    .slice(1)
    .filter((r) => r.length >= 4 && (r[0] ?? '').trim() !== '')
    .map((r) => ({
      topic: r[0] as string,
      url: r[1] as string,
      usedFor: r[2] as string,
      verified: r[3] as string,
    }));

  const data = readTsv(join(SRC, 'v4.4.tsv'))
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''));

  mkdirSync(OUT, { recursive: true });

  const checks: CompiledCheck[] = [];
  const unmapped: Array<[string, string]> = [];
  const untriaged: string[] = [];

  for (const row of data) {
    const id = cell(row, 0);
    const phaseLabel = cell(row, 1);
    const appliesTo = cell(row, 3);
    const phase = Number.parseInt(phaseLabel.split(' ')[0] ?? '', 10);

    const applicability = APPLICABILITY[appliesTo];
    if (!applicability) unmapped.push([id, appliesTo]);
    const [universal, anyFlags] = applicability ?? [false, ['UNMAPPED']];

    const triage = TRIAGE[id];
    if (!triage) untriaged.push(id);
    const [automation, remediationClass, detectors] = triage ?? ['assisted', 'config', []];

    const cadence = parseCadence(cell(row, 11));
    const notes = row[13] ?? '';

    checks.push({
      id, phase, phaseLabel,
      priority: cell(row, 2),
      profile: cell(row, 16).toLowerCase() || 'core',
      launchGate: cell(row, 5).toLowerCase() === 'yes',
      universal, anyFlags, appliesTo,
      task: cell(row, 6), whatToDo: cell(row, 7), doneWhen: cell(row, 8),
      owners: parseRoles(row[9] ?? ''), ownerSource: cell(row, 9),
      tools: cell(row, 10),
      triggers: cadence.triggers,
      interval: cadence.interval,
      windowDays: cadence.windowDays,
      cadenceSource: cell(row, 11),
      notes: notes.trim(),
      automation, remediationClass, detectors,
      sources: matchSources(notes, sources),
    });
  }

  const phases = [...new Set(checks.map((c) => c.phase))].sort((a, b) => a - b);

  for (const phase of phases) {
    const subset = checks.filter((c) => c.phase === phase);
    const label = subset[0]?.phaseLabel ?? '';
    const body = [
      `# Corpus v${CORPUS_VERSION} - phase ${phase}: ${label}`,
      '# Generated by scripts/compile-corpus.ts from corpus/source/v4.4.tsv.',
      '# Edit here; re-running the compiler will overwrite this file.',
      '',
      ...subset.map(emitCheck),
    ];
    write(join(OUT, `phase-${phase}.yaml`), body);
  }

  const sourceLines = [
    `# Corpus v${CORPUS_VERSION} citations, from the workbook Sources sheet.`,
    '',
  ];
  for (const s of sources) {
    sourceLines.push(
      `- topic: "${s.topic}"`,
      `  url: "${s.url}"`,
      `  usedFor: ${yStr(s.usedFor, 2)}`,
      `  verified: "${s.verified}"`,
    );
  }
  write(join(OUT, 'sources.yaml'), sourceLines);

  const manifest = [
    `version: "${CORPUS_VERSION}"`,
    `reviewed: "${CORPUS_REVIEWED}"`,
    `checkCount: ${checks.length}`,
    `sourceCount: ${sources.length}`,
    'files:',
    ...phases.map((p) => `  - phase-${p}.yaml`),
    '  - sources.yaml',
  ];
  write(join(OUT, 'manifest.yaml'), manifest);

  const cited = checks.filter((c) => c.sources.length > 0).length;
  console.log(`compiled ${checks.length} checks across ${phases.length} phases`);
  console.log(`sources: ${sources.length} | checks with citations: ${cited}`);
  if (unmapped.length > 0) {
    console.log('UNMAPPED applicability:');
    for (const [id, text] of unmapped) console.log(`   ${id}: ${text}`);
  }
  if (untriaged.length > 0) console.log(`UNTRIAGED: ${untriaged.join(', ')}`);

  return unmapped.length > 0 || untriaged.length > 0 ? 1 : 0;
}

// Non-zero when the compile found rows it could not map or triage.
process.exitCode = main();
