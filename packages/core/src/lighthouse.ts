/**
 * Reading the Lighthouse JSON files a `lighthouse` input points at. The parser
 * in `inputs.ts` stays pure and only checks paths are text; this is where a
 * path becomes numbers, so a detector reads `metrics` and never a file.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { instant } from './review.js';
import type { AuditInputs, LighthouseLcpElement, LighthouseMetrics } from './inputs.js';

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function auditValue(audits: Node, id: string): number | undefined {
  const audit = audits[id];
  return isNode(audit) ? num(audit['numericValue']) : undefined;
}

/** An attribute's value from an opening tag's markup, or undefined when it is not written. */
function attribute(markup: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(markup);
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
}

function lcpElement(audits: Node): LighthouseLcpElement | undefined {
  const audit = audits['largest-contentful-paint-element'];
  if (!isNode(audit) || !isNode(audit['details'])) return undefined;
  const items = audit['details']['items'];
  if (!Array.isArray(items)) return undefined;
  // The first table lists the element itself; the second breaks down its phases.
  for (const item of items) {
    const node = isNode(item) && Array.isArray(item['items']) ? item['items'][0] : item;
    const target = isNode(node) && isNode(node['node']) ? node['node'] : null;
    if (target === null) continue;
    const snippet = typeof target['snippet'] === 'string' ? target['snippet'] : '';
    const tag = /^\s*<([a-z][a-z0-9-]*)/i.exec(snippet)?.[1]?.toLowerCase();
    if (tag === undefined) continue;
    const selector = typeof target['selector'] === 'string' ? target['selector'] : undefined;
    const src = attribute(snippet, 'src') ?? attribute(snippet, 'poster');
    const loading = attribute(snippet, 'loading');
    const fetchPriority = attribute(snippet, 'fetchpriority');
    return {
      tag,
      ...(selector !== undefined ? { selector } : {}),
      ...(src !== undefined ? { src } : {}),
      ...(loading !== undefined ? { loading } : {}),
      ...(fetchPriority !== undefined ? { fetchPriority } : {}),
    };
  }
  return undefined;
}

/** Reduce one parsed Lighthouse report to what grading reads. Anything the report lacks is left out. */
export function reduceLighthouseReport(report: unknown): LighthouseMetrics {
  if (!isNode(report)) return {};
  const audits = isNode(report['audits']) ? report['audits'] : {};
  const lcpMs = auditValue(audits, 'largest-contentful-paint');
  const cls = auditValue(audits, 'cumulative-layout-shift');
  const tbtMs = auditValue(audits, 'total-blocking-time');
  const element = lcpElement(audits);
  const fetchTime = typeof report['fetchTime'] === 'string' ? instant(report['fetchTime']) : null;
  const settings = isNode(report['configSettings']) ? report['configSettings'] : {};
  const testProfile = typeof settings['formFactor'] === 'string' ? settings['formFactor'] : undefined;
  return {
    ...(lcpMs !== undefined ? { lcpMs } : {}),
    ...(cls !== undefined ? { cls } : {}),
    ...(tbtMs !== undefined ? { tbtMs } : {}),
    ...(element !== undefined ? { lcpElement: element } : {}),
    ...(fetchTime !== null ? { fetchedAt: new Date(fetchTime).toISOString() } : {}),
    ...(testProfile !== undefined ? { testProfile } : {}),
  };
}

/**
 * Read every report a `lighthouse` section points at and return the inputs with
 * `metrics` filled in. Paths resolve against `baseDir` (the inputs file's
 * directory). A file that cannot be read or is not JSON throws with its path:
 * a report the person named and we cannot read is an error, not a gap.
 */
export function loadLighthouseMetrics(inputs: AuditInputs, baseDir: string): AuditInputs {
  const section = inputs.lighthouse;
  if (section === undefined) return inputs;
  const reports = section.reports.map((report) => {
    const file = resolve(baseDir, report.path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`lighthouse report for ${report.url} (${file}): ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ...report, metrics: reduceLighthouseReport(parsed) };
  });
  return { ...inputs, lighthouse: { ...section, reports } };
}

/** `loadLighthouseMetrics` for an inputs file: paths are relative to where that file lives. */
export function loadLighthouseMetricsFor(inputs: AuditInputs, inputsFile: string): AuditInputs {
  return loadLighthouseMetrics(inputs, dirname(resolve(inputsFile)));
}
