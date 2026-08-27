/**
 * The probe registry and runner.
 *
 * Registration is a claim: "this detector id is implemented". The matrix in
 * matrix.ts checks that claim against the corpus, so a probe whose id no
 * corpus check declares is caught in a test rather than silently producing
 * observations nothing will ever read.
 */

import type { CrawledPage } from '@seo/crawler';
import { deliveryProbes } from './probes/delivery.js';
import { indexabilityProbes } from './probes/indexability.js';
import { markupProbes } from './probes/markup.js';
import { mediaProbes } from './probes/media.js';
import { metadataProbes } from './probes/metadata.js';
import { siteProbes } from './probes/site.js';
import type { PageProbe, Probe, ProbeRun, SiteContext, SiteProbe } from './types.js';

export const PROBES: readonly Probe[] = [
  ...deliveryProbes,
  ...indexabilityProbes,
  ...markupProbes,
  ...mediaProbes,
  ...metadataProbes,
  ...siteProbes,
];

export const pageProbes: readonly PageProbe[] = PROBES.filter(
  (probe): probe is PageProbe => probe.scope === 'page',
);

export const sitewideProbes: readonly SiteProbe[] = PROBES.filter(
  (probe): probe is SiteProbe => probe.scope === 'site',
);

export function probeById(id: string): Probe | undefined {
  return PROBES.find((probe) => probe.id === id);
}

const isHtml = (page: CrawledPage): boolean => page.extracted !== null;

/**
 * Run every probe over one crawl.
 *
 * A probe that throws produces an `error` observation rather than aborting the
 * run: one broken detector must not cost the customer the other ninety.
 */
export function runProbes(site: SiteContext, probes: readonly Probe[] = PROBES): ProbeRun[] {
  const runs: ProbeRun[] = [];

  for (const probe of probes) {
    if (probe.scope === 'site') {
      runs.push({ probeId: probe.id, scope: 'site', observation: guard(() => probe.run(site)) });
      continue;
    }
    for (const page of site.crawl.pages) {
      if (probe.htmlOnly === true && !isHtml(page)) continue;
      runs.push({
        probeId: probe.id,
        scope: 'page',
        pageUrl: page.normalizedUrl,
        observation: guard(() => probe.run({ page, site })),
      });
    }
  }
  return runs;
}

function guard(run: () => ProbeRun['observation']): ProbeRun['observation'] {
  try {
    return run();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      outcome: 'error',
      summary: `Probe failed to run: ${message}`,
      data: { error: message },
    };
  }
}
