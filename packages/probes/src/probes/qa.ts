/**
 * Pre-launch QA (corpus v5.0 4.1): the staging crawl's own findings.
 *
 * 4.1 asks that "priority URLs have no broken links, missing metadata or
 * indexation conflicts", and declares a detector for each half a raw crawl can
 * see. The third, `raw-rendered-crawl-diff`, needs a rendered crawl (Phase 5),
 * so 4.1 stays ungraded until it exists; these two still report today.
 *
 * Both are site-scoped because both findings live between pages. A 404 is a
 * fact about one response, and `http-status` (1.4) already judges it; a broken
 * link is a fact about the page that sends a visitor there, and one dead URL
 * linked from forty templates is forty things to fix. A noindex is a fact about
 * one page; a noindex on a URL the sitemap asks to have indexed is two parts of
 * the site disagreeing, and neither page shows it on its own.
 */

import { normalizeUrl } from '@seo/crawler';
import type { CrawledPage, CrawlResult, FetchResult } from '@seo/crawler';
import type { SiteProbe } from '../types.js';
import { errored, fail, notApplicable, pass, warn } from '../types.js';

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

export const qaProbes = [brokenLinks, metadataCompleteness];
