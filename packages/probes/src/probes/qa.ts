/**
 * Pre-launch QA (corpus v5.0 4.1): the staging crawl's own findings.
 *
 * 4.1 asks that "priority URLs have no broken links, missing metadata or
 * indexation conflicts", and declares a detector for each half a raw crawl can
 * see. The third, `raw-rendered-crawl-diff`, needs a rendered crawl and is
 * `not-applicable` without one.
 *
 * Both are site-scoped because both findings live between pages. A 404 is a
 * fact about one response, and `http-status` (1.4) already judges it; a broken
 * link is a fact about the page that sends a visitor there, and one dead URL
 * linked from forty templates is forty things to fix. A noindex is a fact about
 * one page; a noindex on a URL the sitemap asks to have indexed is two parts of
 * the site disagreeing, and neither page shows it on its own.
 */

import { CI_GUARD_DEFECTS, CI_RULE_MAX_FALSE_POSITIVE_RATE, environmentOrigins, inputRecordProblem } from '@seo/core';
import { isSameSite, normalizeUrl } from '@seo/crawler';
import type { CrawledPage, CrawlResult, FetchResult } from '@seo/crawler';
import type { SiteProbe } from '../types.js';
import { errored, fail, notApplicable, pass, warn } from '../types.js';
import { matrixMatcher, NOINDEX_DIRECTIVE } from './site.js';

/** How many examples of each finding an observation carries. */
const SAMPLES = 10;

/**
 * Whether a response says the link behind it is dead.
 *
 * A 429 is the site asking this crawler to slow down, which says nothing about
 * the URL, so it leaves the target unverified. So does a request that never
 * came back: a timeout may be ours as easily as theirs.
 */
type TargetState = 'ok' | 'broken' | 'unverified';

const stateOf = (fetch: FetchResult): TargetState => {
  const { status, error } = fetch;
  if (error !== null || status === null || status === 429) return 'unverified';
  return status >= 400 ? 'broken' : 'ok';
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/** Every page the crawl parsed as HTML, so every page whose links were read. */
const parsedPages = (crawl: CrawlResult): CrawledPage[] =>
  crawl.pages.filter((page) => page.extracted !== null);

interface BrokenLink {
  readonly target: string;
  readonly status: number | null;
  /** Whether the target is off the crawled site. */
  readonly external: boolean;
  /** Pages carrying a link to it, the first few. */
  readonly linkedFrom: readonly string[];
  /** How many links to it the crawl read, repeats on one page included once. */
  readonly sources: number;
}

/**
 * Links on crawled pages lead somewhere that answers, internal and external.
 *
 * Internal means a target the crawl could have fetched: on the crawled host.
 * External targets cannot be fetched by the walk — the crawl has one host's
 * permission — so they are checked by a separate, bounded auxiliary pass the
 * crawl loop runs once after the walk, one request per distinct target, paced
 * and capped per external host so a page citing one rival's site forty times
 * cannot spend the whole check confirming that one host is up. Only that pass
 * makes a request to another site; this probe only reads what it recorded.
 *
 * A target the crawl did not verify — the budget ran out, it was linked
 * `nofollow`, robots.txt kept the crawler out of an internal one, an external
 * one fell outside the auxiliary pass's own budget — is not known to work, so
 * the check is held with a `warn` rather than passed. A robots-blocked target
 * is not a broken one: visitors are not crawlers, and the page may be fine.
 */
export const brokenLinks: SiteProbe = {
  id: 'broken-links',
  scope: 'site',
  title: 'Links on crawled pages, internal and external, lead to pages that answer',
  run({ crawl }) {
    const sources = parsedPages(crawl);
    if (sources.length === 0) return notApplicable('No HTML pages were crawled, so no links were read.');

    const fetched = new Map(crawl.pages.map((page) => [page.normalizedUrl, page]));
    const blocked = new Set(crawl.blockedByRobots);
    // The crawled host, and any host the crawl ended up on: a seed that
    // redirects `example.com` to `www.example.com` links to pages on the second,
    // and they are no less the site's own for it.
    const hosts = new Set<string>();
    for (const url of [...crawl.seeds, ...crawl.pages.map((page) => page.fetch.finalUrl)]) {
      const host = hostOf(url);
      if (host !== null) hosts.add(host);
    }
    const externalChecks = new Map<string, FetchResult>();
    for (const item of crawl.auxiliary) {
      if (item.reason === 'external-link') externalChecks.set(item.url, item.fetch);
    }

    const broken = new Map<string, { status: number | null; external: boolean; from: Set<string> }>();
    const unchecked = new Set<string>();
    const externalUnchecked = new Set<string>();
    const robotsBlocked = new Set<string>();
    let internal = 0;
    let external = 0;

    for (const page of sources) {
      const targets = new Set<string>();
      for (const link of page.extracted?.links ?? []) {
        const target = normalizeUrl(link.url);
        if (target === null) continue;
        // The page itself: a skip link or a same-page anchor spelt out in full.
        if (target === page.normalizedUrl) continue;
        targets.add(target);
      }
      for (const target of targets) {
        const reached = fetched.get(target);
        if (reached === undefined && !hosts.has(hostOf(target) ?? '')) {
          external += 1;
          const checked = externalChecks.get(target);
          if (checked === undefined) {
            externalUnchecked.add(target);
            continue;
          }
          const state = stateOf(checked);
          if (state === 'unverified') externalUnchecked.add(target);
          if (state !== 'broken') continue;
          const entry = broken.get(target) ?? { status: checked.status, external: true, from: new Set<string>() };
          entry.from.add(page.normalizedUrl);
          broken.set(target, entry);
          continue;
        }
        internal += 1;
        if (reached === undefined) {
          if (blocked.has(target)) robotsBlocked.add(target);
          else unchecked.add(target);
          continue;
        }
        const state = stateOf(reached.fetch);
        if (state === 'unverified') unchecked.add(target);
        if (state !== 'broken') continue;
        const entry = broken.get(target) ?? { status: reached.fetch.status, external: false, from: new Set<string>() };
        entry.from.add(page.normalizedUrl);
        broken.set(target, entry);
      }
    }

    if (internal === 0 && external === 0) {
      return notApplicable(`No links were found on ${sources.length} crawled page(s).`);
    }

    const findings: BrokenLink[] = [...broken]
      .map(([target, { status, external: isExternal, from }]) => ({
        target,
        status,
        external: isExternal,
        linkedFrom: [...from].slice(0, 5),
        sources: from.size,
      }))
      .sort((a, b) => b.sources - a.sources);
    const data = {
      pagesRead: sources.length,
      internalLinks: internal,
      externalLinks: external,
      externalLinksChecked: externalChecks.size,
      externalLinksNotChecked: externalUnchecked.size,
      brokenTargets: findings.length,
      uncheckedTargets: unchecked.size,
      robotsBlockedTargets: robotsBlocked.size,
    };

    if (findings.length > 0) {
      const links = findings.reduce((sum, finding) => sum + finding.sources, 0);
      const externalFindings = findings.filter((finding) => finding.external).length;
      return fail(
        `${links} link(s) on crawled pages lead to ${findings.length} URL(s) that answer with an error` +
          (externalFindings > 0 ? ` (${externalFindings} of them external)` : '') + '.',
        { ...data, samples: findings.slice(0, SAMPLES) },
      );
    }
    if (unchecked.size > 0 || externalUnchecked.size > 0) {
      const parts = [
        ...(unchecked.size > 0 ? [`${unchecked.size} internal`] : []),
        ...(externalUnchecked.size > 0 ? [`${externalUnchecked.size} external`] : []),
      ];
      return warn(
        `No broken link among the targets the crawl checked, but ${parts.join(' and ')} link ` +
          'target(s) were not fetched or did not answer, so the check is unfinished.',
        {
          ...data,
          unchecked: [...unchecked].slice(0, SAMPLES),
          uncheckedExternal: [...externalUnchecked].slice(0, SAMPLES),
        },
      );
    }
    const parts = [
      ...(internal > 0 ? [`${internal} internal link(s)`] : []),
      ...(externalChecks.size > 0 ? [`${externalChecks.size} external link target(s)`] : []),
    ];
    return pass(
      `All ${parts.join(' and ')} on ${sources.length} crawled page(s) lead to pages that answer` +
        (robotsBlocked.size > 0 ? `; ${robotsBlocked.size} target(s) are kept from crawlers by robots.txt.` : '.'),
      robotsBlocked.size > 0 ? { ...data, robotsBlocked: [...robotsBlocked].slice(0, SAMPLES) } : data,
    );
  },
};

const NOINDEX = /\bnoindex\b|\bnone\b/i;
const INDEX = /(^|[\s,:])index\b/i;

/** The page's robots directives, meta and header apart. */
const directivesOf = (page: CrawledPage): { meta: string; header: string } => ({
  meta: page.extracted?.metaRobots ?? '',
  header: page.fetch.headers['x-robots-tag'] ?? '',
});

const isNoindex = (page: CrawledPage): boolean => {
  const { meta, header } = directivesOf(page);
  return NOINDEX.test(meta) || NOINDEX.test(header);
};

/** Where a page ended up, normalized. */
const landedAt = (page: CrawledPage): string | null => normalizeUrl(page.fetch.finalUrl);

interface Conflict {
  readonly url: string;
  readonly issue: string;
}

interface Missing {
  readonly url: string;
  readonly missing: readonly string[];
}

/**
 * Indexable pages carry their metadata, and no two signals about a URL
 * contradict each other.
 *
 * Missing metadata, on each page that answered 200 and is not noindex:
 * - no `<title>`, or an empty one — `fail`; nothing else names the page;
 * - no meta description, no `<h1>`, no canonical — `warn`, because each has a
 *   legitimate absence (Google writes its own snippets; v5.0 1.3 asks for a
 *   self-canonical only "where appropriate") and their own detectors already
 *   judge them one page at a time. Here they are counted, so the staging crawl
 *   shows the whole gap in one place.
 *
 * Indexation conflicts — `fail`, because each is two instructions that cannot
 * both be followed:
 * - a sitemap entry on a page marked noindex, or one robots.txt disallows;
 * - noindex together with a canonical onto another URL, which Google's own
 *   guidance says not to combine: one says drop this page, the other says
 *   merge it into that one;
 * - meta robots and `X-Robots-Tag` disagreeing, one `index`, the other
 *   `noindex`;
 * - a canonical onto a URL the crawl fetched and found redirecting, broken or
 *   noindex, so the page names as its preferred address one that cannot be
 *   indexed as itself. One exception, a `warn`: a canonical that redirects
 *   straight back to the page, which is what an edition front naming a
 *   home page that redirects by location looks like from one place
 *   (theguardian.com's `/europe`, from Europe).
 *
 * A page whose body was cut is not read for missing fields: the cut can fall
 * anywhere, and a field the engine did not read is not one the site left out.
 */
export const metadataCompleteness: SiteProbe = {
  id: 'metadata-completeness',
  scope: 'site',
  title: 'Indexable pages carry their metadata, and no two indexing signals disagree',
  run({ crawl }) {
    const html = crawl.pages.filter((page) => page.extracted !== null && page.fetch.status === 200);
    if (html.length === 0) return notApplicable('No HTML pages answered 200.');

    const fetched = new Map<string, CrawledPage>();
    for (const page of crawl.pages) {
      fetched.set(page.normalizedUrl, page);
    }
    const listed = new Set(crawl.sitemapUrls);

    const conflicts: Conflict[] = [];
    const varying: Conflict[] = [];
    const titleless: Missing[] = [];
    const gaps: Missing[] = [];
    const cut: string[] = [];
    let indexable = 0;

    for (const url of crawl.blockedByRobots) {
      if (listed.has(url)) {
        conflicts.push({ url, issue: 'is listed in the sitemap and disallowed by robots.txt' });
      }
    }

    for (const page of html) {
      const extracted = page.extracted;
      if (extracted === null) continue;
      const url = page.normalizedUrl;
      const self = landedAt(page);
      // A redirect's record holds its destination's document; the destination
      // is judged under its own address when the crawl fetched it.
      if (self !== null && self !== url && fetched.has(self)) continue;
      const noindex = isNoindex(page);
      const { meta, header } = directivesOf(page);
      const canonical = extracted.canonical === null ? null : normalizeUrl(extracted.canonical);

      if ((NOINDEX.test(meta) && INDEX.test(header)) || (NOINDEX.test(header) && INDEX.test(meta))) {
        conflicts.push({
          url,
          issue: `meta robots says "${meta}" and X-Robots-Tag says "${header}"`,
        });
      }
      if (noindex && listed.has(url)) {
        conflicts.push({ url, issue: 'is marked noindex and listed in the sitemap' });
      }
      if (noindex && canonical !== null && canonical !== self) {
        conflicts.push({ url, issue: `is marked noindex and names ${canonical} as its canonical` });
      }
      if (!noindex && canonical !== null && canonical !== self) {
        const target = fetched.get(canonical);
        const why = target === undefined ? null : unusableCanonical(target);
        if (why !== null && target !== undefined && landedAt(target) === self) {
          // A canonical onto a URL that sends this visitor straight back: an
          // edition front naming the home page, which redirects by location.
          // From here the page is its own canonical; from elsewhere it may not
          // be, and only a person can say which visitor the site meant.
          varying.push({ url, issue: `names ${canonical} as its canonical, which ${why}, back to this page` });
        } else if (why !== null) {
          conflicts.push({ url, issue: `names ${canonical} as its canonical, which ${why}` });
        }
      }

      if (noindex) continue;
      indexable += 1;
      if (page.fetch.truncated) {
        cut.push(url);
        continue;
      }
      if (extracted.title === null || extracted.title.trim() === '') {
        titleless.push({ url, missing: ['title'] });
      }
      const missing = [
        ...(extracted.metaDescription === null || extracted.metaDescription === '' ? ['meta description'] : []),
        ...(extracted.headings.some((heading) => heading.level === 1) ? [] : ['h1']),
        ...(extracted.canonical === null ? ['canonical'] : []),
      ];
      if (missing.length > 0) gaps.push({ url, missing });
    }

    const data = {
      pagesRead: html.length,
      indexable,
      conflicts: conflicts.length,
      canonicalsVaryingByVisitor: varying.length,
      withoutTitle: titleless.length,
      withGaps: gaps.length,
      notRead: cut.length,
      ...countMissing(gaps),
    };

    if (conflicts.length > 0 || titleless.length > 0) {
      const parts = [
        ...(conflicts.length > 0 ? [`${conflicts.length} indexation conflict(s)`] : []),
        ...(titleless.length > 0 ? [`${titleless.length} indexable page(s) with no title`] : []),
      ];
      return fail(`${parts.join(' and ')}.`, {
        ...data,
        samples: [...conflicts, ...titleless].slice(0, SAMPLES),
      });
    }
    if (indexable === 0) {
      return pass(`No conflicts among ${html.length} crawled page(s), all of them noindex.`, data);
    }
    if (cut.length === indexable) {
      return errored(
        `Every indexable page's body was cut at the crawler's size limit, so its metadata was not read.`,
        { ...data, samples: cut.slice(0, SAMPLES) },
      );
    }
    if (varying.length > 0) {
      return warn(
        `${varying.length} page(s) name a canonical that redirects back to them; confirm which ` +
          'address each visitor is meant to index.',
        { ...data, samples: [...varying, ...gaps].slice(0, SAMPLES) },
      );
    }
    if (gaps.length > 0) {
      return warn(
        `${gaps.length} of ${indexable} indexable page(s) lack a meta description, h1 or canonical.`,
        { ...data, samples: gaps.slice(0, SAMPLES) },
      );
    }
    if (cut.length > 0) {
      return warn(
        `No conflicts, and every page read carries its metadata, but ${cut.length} page(s) were ` +
          'cut at the crawler’s size limit and not read.',
        { ...data, samples: cut.slice(0, SAMPLES) },
      );
    }
    return pass(
      `All ${indexable} indexable page(s) carry a title, description, h1 and canonical, and no indexing signals disagree.`,
      data,
    );
  },
};

/** Why a fetched canonical target cannot be indexed as itself, or null when it can. */
function unusableCanonical(target: CrawledPage): string | null {
  const { status, error, redirectChain } = target.fetch;
  if (error !== null || status === null) return null;
  if (redirectChain.length > 0) return `redirects to ${target.fetch.finalUrl}`;
  if (status >= 400) return `answers ${status}`;
  if (isNoindex(target)) return 'is marked noindex';
  return null;
}

function countMissing(gaps: readonly Missing[]): Record<string, number> {
  const counts = { withoutDescription: 0, withoutH1: 0, withoutCanonical: 0 };
  for (const gap of gaps) {
    if (gap.missing.includes('meta description')) counts.withoutDescription += 1;
    if (gap.missing.includes('h1')) counts.withoutH1 += 1;
    if (gap.missing.includes('canonical')) counts.withoutCanonical += 1;
  }
  return counts;
}

interface RenderDiff {
  readonly url: string;
  readonly issue: string;
}

/**
 * A browser and a plain fetch land on the same page, with the same status, and
 * reach the same site through the same links.
 *
 * Rendering is opt-in per crawl, so this is `not-applicable` when no page was
 * rendered, and `error` when every render attempted failed. On each page with a
 * render, `fail`:
 * - the rendered `finalUrl` is not the raw one — a client-side redirect a
 *   crawler that does not run scripts never follows;
 * - the rendered status is not the raw one.
 *
 * `warn`: a same-site URL linked only from rendered DOM, anywhere in the
 * crawl, and never from any page's raw HTML — reachable only by rendering, so
 * a non-rendering crawler cannot discover it. `raw-rendered-parity` (1.1)
 * judges the same difference one page at a time; here it is judged across the
 * crawl, where a link one page adds may be one another carries in raw.
 */
export const rawRenderedCrawlDiff: SiteProbe = {
  id: 'raw-rendered-crawl-diff',
  scope: 'site',
  title: 'A rendered crawl lands where the raw one does and finds no page only scripts link to',
  run({ crawl, origin }) {
    const rendered = crawl.pages.filter((page) => page.rendered !== undefined && page.rendered !== null);
    if (rendered.length === 0) return notApplicable('No page was rendered; rendering was not requested.');

    const diffs: RenderDiff[] = [];
    const rawTargets = new Set<string>();
    const renderedTargets = new Set<string>();
    let compared = 0;
    let failedRenders = 0;

    const collect = (links: readonly { readonly url: string }[], into: Set<string>): void => {
      for (const link of links) {
        if (!isSameSite(link.url, origin)) continue;
        const target = normalizeUrl(link.url);
        if (target !== null) into.add(target);
      }
    };
    for (const page of parsedPages(crawl)) collect(page.extracted?.links ?? [], rawTargets);

    for (const page of rendered) {
      const capture = page.rendered;
      if (capture === undefined || capture === null) continue;
      if (capture.render.error !== null) {
        failedRenders += 1;
        continue;
      }
      compared += 1;
      const url = page.normalizedUrl;
      const rawFinal = normalizeUrl(page.fetch.finalUrl);
      const renderedFinal = normalizeUrl(capture.render.finalUrl);
      if (rawFinal !== null && renderedFinal !== null && rawFinal !== renderedFinal) {
        diffs.push({ url, issue: `the raw fetch ends at ${rawFinal} but the browser ends at ${renderedFinal}` });
      }
      const { status } = capture.render;
      if (status !== null && page.fetch.status !== null && status !== page.fetch.status) {
        diffs.push({ url, issue: `the raw status is ${page.fetch.status} and the rendered status is ${status}` });
      }
      collect(capture.extracted?.links ?? [], renderedTargets);
    }

    if (compared === 0) {
      return errored(`Every render attempted failed (${failedRenders} page(s)), so nothing was compared.`);
    }

    const onlyRendered = [...renderedTargets].filter((target) => !rawTargets.has(target));
    const data = {
      pagesRendered: rendered.length,
      pagesCompared: compared,
      renderFailures: failedRenders,
      differences: diffs.length,
      renderOnlyTargets: onlyRendered.length,
    };

    if (diffs.length > 0) {
      return fail(
        `${diffs.length} page(s) end somewhere else, or answer differently, once rendered.`,
        { ...data, samples: diffs.slice(0, SAMPLES) },
      );
    }
    if (onlyRendered.length > 0) {
      return warn(
        `${onlyRendered.length} same-site URL(s) are linked only from rendered DOM and never from raw HTML; ` +
          'a crawler that does not render cannot reach them.',
        { ...data, renderOnly: onlyRendered.slice(0, SAMPLES) },
      );
    }
    return pass(
      `${compared} rendered page(s) end where the raw fetch does, with the same status, and add no link target.`,
      data,
    );
  },
};

/**
 * Whether the site's CI guard has been shown to stop the regressions that cost
 * a launch (1.10). Nothing a crawl sees says whether a pipeline would have
 * caught a stray noindex, so this reads the `ciGuard` input and is
 * `not-applicable` without it. A guard that missed a seeded defect kind
 * (noindex, canonical, crawler access, critical link), or failed a clean
 * build, fails. Otherwise the check passes and the rules the guard is known to
 * enforce are recorded. A record nobody answers for or past review holds it.
 */
export const ciSeoGuards: SiteProbe = {
  id: 'ci-seo-guards',
  scope: 'site',
  title: 'CI guards catch noindex, canonical, crawler-access and critical-link regressions',
  run({ crawl, inputs }) {
    const record = inputs?.ciGuard;
    if (record === undefined) return notApplicable('No CI guard record was supplied.');

    const caught = new Set(record.seededDefectsCaught.map((kind) => kind.toLowerCase()));
    const missing = CI_GUARD_DEFECTS.filter((kind) => !caught.has(kind));
    const data = {
      build: record.build,
      ranAt: record.ranAt,
      rules: [...caught],
      missing,
      cleanRunPassed: record.cleanRunPassed,
    };

    if (missing.length > 0 || !record.cleanRunPassed) {
      const parts = [
        missing.length > 0 ? `the guard was not shown to catch a seeded ${missing.join(', ')} defect` : '',
        !record.cleanRunPassed ? 'a clean build did not pass it' : '',
      ].filter((part) => part !== '');
      return fail(`${parts.join('; ')} (build ${record.build}).`, data);
    }

    const at = crawl.crawledAt ?? null;
    const problem = at === null
      ? "the crawl's time is unknown, so the record's review date cannot be judged"
      : inputRecordProblem(record, new Date(at));
    if (problem !== null) return warn(`The CI guard record is held for review: ${problem}.`, data);

    return pass(
      `Build ${record.build} caught every seeded defect kind (${CI_GUARD_DEFECTS.join(', ')}) and a clean run passed.`,
      data,
    );
  },
};

/**
 * Whether the extended CI rules (1.11) are ones somebody answers for. Nothing a
 * crawl sees lists a pipeline's rules, so this reads the `ciRules` input and is
 * `not-applicable` without it. It only ever warns: a rule with no owner, no
 * severity, a false-positive rate over 10%, or a record past its review date
 * holds the check. A clean list is `pass`, which the check being `assisted`
 * keeps from settling it — a person judges whether the rules are the right ones.
 */
export const ciExtendedChecks: SiteProbe = {
  id: 'ci-extended-checks',
  scope: 'site',
  title: 'Extended CI rules each have an owner, a severity and a tolerable false-positive rate',
  run({ crawl, inputs }) {
    const rules = inputs?.ciRules;
    if (rules === undefined) return notApplicable('No CI rules were supplied.');
    if (rules.length === 0) return notApplicable('The CI rules section is empty.');

    const at = crawl.crawledAt ?? null;
    const held: { rule: string; issue: string }[] = [];
    for (const rule of rules) {
      const issues: string[] = [];
      if (rule.owner.trim() === '') issues.push('no owner');
      if (rule.severity === '') issues.push('no severity');
      if (rule.falsePositiveRate > CI_RULE_MAX_FALSE_POSITIVE_RATE) {
        issues.push(`a false-positive rate of ${Math.round(rule.falsePositiveRate * 1000) / 10}%`);
      }
      if (rule.owner.trim() !== '') {
        const problem = at === null ? null : inputRecordProblem(rule, new Date(at));
        if (problem !== null) issues.push(problem);
      }
      if (issues.length > 0) held.push({ rule: rule.rule, issue: issues.join(', ') });
    }
    const data = { rules: rules.map((rule) => rule.rule), held };

    if (held.length > 0) {
      return warn(
        `${held.length} of ${rules.length} CI rule(s) are held: ` +
          held.slice(0, SAMPLES).map((entry) => `${entry.rule} (${entry.issue})`).join('; ') + '.',
        data,
      );
    }
    return pass(`${rules.length} CI rule(s) each have an owner, a severity and a false-positive rate within 10%.`, data);
  },
};

/**
 * The post-cutover smoke test on the production hostname (5.1). It reads the
 * URL matrix, and applies only when the audit origin is the matrix's
 * `production` environment: the matrix names a `production` row and the origin
 * is not a staging or preview origin the `environments` input lists. Otherwise
 * it is `not-applicable`, since a smoke test of staging says nothing about launch.
 *
 * Fails: a priority URL not answering 200, a page the matrix says is indexable
 * that carries noindex, and a `private` pattern answering 200 to a crawl that
 * held no credentials. A priority pattern the crawl never reached holds the
 * check with a `warn`. Organic crawler traffic cannot be seen from a crawl, so
 * every result records it as `unavailable`; a passing smoke test does not say
 * that a real search crawler was observed.
 */
export const productionSmokeTest: SiteProbe = {
  id: 'production-smoke-test',
  scope: 'site',
  title: 'Priority URLs answer 200, are indexable and private URLs stay private on production',
  run({ crawl, inputs, origin }) {
    const matrix = inputs?.urlMatrix;
    if (matrix === undefined) return notApplicable('No URL matrix was supplied.');
    if (!matrix.some((row) => row.environment === 'production')) {
      return notApplicable('The URL matrix names no production environment, so the audit origin is not known to be production.');
    }
    const elsewhere = environmentOrigins(inputs?.environments).find((entry) => isSameSite(origin, entry.origin));
    if (elsewhere !== undefined) {
      return notApplicable(`The audit origin is the ${elsewhere.name} environment, not production.`);
    }

    const rows = matrix.filter((row) => row.environment === undefined || row.environment === 'production');
    const matchers = rows.map((row) => ({ row, ...matrixMatcher(row.pattern, origin) }));
    const specificity = (entry: (typeof matchers)[number]): number =>
      entry.exact ? Number.MAX_SAFE_INTEGER : entry.row.pattern.replace(/\*/g, '').length;

    const reached = new Set<(typeof matchers)[number]>();
    const failures: string[] = [];
    for (const page of crawl.pages) {
      if (page.fetch.status === null || !isSameSite(page.normalizedUrl, origin)) continue;
      const hits = matchers.filter((entry) => entry.test(page.normalizedUrl));
      if (hits.length === 0) continue;
      const best = hits.reduce((a, b) => (specificity(b) > specificity(a) ? b : a));
      reached.add(best);
      const { row } = best;
      const url = page.normalizedUrl;
      const { status } = page.fetch;
      if (row.priority === true && status !== 200) failures.push(`${url} answered ${status}, a priority URL must answer 200`);
      if (row.access === 'private' && status === 200) {
        failures.push(`${url} answered 200 without credentials, the matrix marks it private`);
      }
      if (row.indexable && page.extracted !== null && status === 200) {
        const noindex = NOINDEX_DIRECTIVE.test(page.extracted.metaRobots ?? '') ||
          NOINDEX_DIRECTIVE.test(page.fetch.headers['x-robots-tag'] ?? '');
        if (noindex) failures.push(`${url} is noindex, the matrix expects it indexable`);
      }
    }

    const unreached = matchers
      .filter((entry) => entry.row.priority === true && entry.row.access !== 'private' && !reached.has(entry))
      .map((entry) => entry.row.pattern);
    const data = {
      rows: rows.length,
      failures: failures.slice(0, SAMPLES),
      failureCount: failures.length,
      unreached: unreached.slice(0, SAMPLES),
      organicCrawling: 'unavailable',
    };

    if (failures.length > 0) {
      return fail(
        `${failures.length} production smoke-test failure(s): ${failures.slice(0, 3).join('; ')}.`,
        data,
      );
    }
    if (unreached.length > 0) {
      return warn(
        `${unreached.length} priority pattern(s) were not reached, so their production response is unverified: ${unreached.slice(0, 3).join(', ')}.`,
        data,
      );
    }
    return pass(
      'Priority URLs answer 200, no indexable URL is noindex and no private URL answered without credentials; ' +
        'organic crawler activity is unavailable to a crawl and is not verified.',
      data,
    );
  },
};

/**
 * The availability canary and the alert that watches it (5.5). Reads the
 * `canary` input and is `not-applicable` without it.
 *
 * Fails: a canary URL the crawl fetched and got a non-200 from, a test alert
 * delivered later than `targetMinutes` after it was raised, and an alert
 * raised that was never delivered. Holds with a `warn`: no test alert on
 * record, no recipient, a canary URL the crawl did not reach, and a record with
 * no owner or past review. Whether the canary keeps its URLs indexable belongs
 * to `indexability-canary`.
 */
export const availabilityCanary: SiteProbe = {
  id: 'availability-canary',
  scope: 'site',
  title: 'Canary URLs answer 200 and a test alert reaches its recipient within the target',
  run({ crawl, inputs }) {
    const record = inputs?.canary;
    if (record === undefined) return notApplicable('No canary record was supplied.');

    const failures: string[] = [];
    const held: string[] = [];

    const byUrl = new Map<string, CrawledPage>();
    for (const page of crawl.pages) byUrl.set(page.normalizedUrl, page);
    const unreached: string[] = [];
    for (const url of record.urls) {
      const page = byUrl.get(normalizeUrl(url) ?? url);
      const status = page?.fetch.status ?? null;
      if (page === undefined || status === null) unreached.push(url);
      else if (status !== 200) failures.push(`${url} answered ${status}, a canary URL must answer 200`);
    }
    if (unreached.length > 0) {
      held.push(`${unreached.length} canary URL(s) were not reached by the crawl: ${unreached.slice(0, 3).join(', ')}`);
    }

    const raised = record.lastTestAlertAt === undefined ? null : Date.parse(record.lastTestAlertAt);
    const delivered = record.deliveredAt === undefined ? null : Date.parse(record.deliveredAt);
    let minutes: number | null = null;
    if (raised === null) {
      held.push('no test alert is on record');
    } else if (delivered === null || delivered < raised) {
      failures.push(`the test alert raised ${record.lastTestAlertAt} was never delivered`);
    } else {
      minutes = Math.round(((delivered - raised) / 60_000) * 10) / 10;
      if (minutes > record.targetMinutes) {
        failures.push(`the test alert took ${minutes} minutes to arrive, the target is ${record.targetMinutes}`);
      }
    }
    if (record.recipient === '') held.push('no alert recipient is recorded');

    const at = crawl.crawledAt ?? null;
    const problem = at === null
      ? "the crawl's time is unknown, so the record's review date cannot be judged"
      : inputRecordProblem(record, new Date(at));
    if (problem !== null) held.push(problem);

    const data = {
      urls: record.urls,
      failures,
      held,
      targetMinutes: record.targetMinutes,
      deliveryMinutes: minutes,
    };
    if (failures.length > 0) {
      return fail(`${failures.length} canary failure(s): ${failures.slice(0, 3).join('; ')}.`, data);
    }
    if (held.length > 0) return warn(`The canary is held: ${held.slice(0, 3).join('; ')}.`, data);
    return pass(
      `${record.urls.length} canary URL(s) answered 200 and a test alert reached ${record.recipient} in ${minutes} minutes (target ${record.targetMinutes}).`,
      data,
    );
  },
};

export const qaProbes = [
  brokenLinks,
  metadataCompleteness,
  rawRenderedCrawlDiff,
  ciSeoGuards,
  ciExtendedChecks,
  productionSmokeTest,
  availabilityCanary,
];
