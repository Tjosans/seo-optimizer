/**
 * robots.txt parsing and matching.
 *
 * Implements the rules search engines actually apply (RFC 9309): group
 * selection by the most specific matching user-agent, `*` wildcards and `$`
 * end-anchors in paths, and — the rule most naive implementations get wrong —
 * the longest matching rule wins, with Allow beating Disallow on a tie.
 *
 * Getting this wrong in either direction is a real cost: too permissive and
 * the crawler misbehaves against a customer's site, too strict and the audit
 * silently reports fewer pages than exist.
 */

export interface RobotsRule {
  readonly allow: boolean;
  /** Path pattern as written, `*` and `$` included. */
  readonly path: string;
}

export interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  readonly crawlDelay?: number;
}

export interface Robots {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
  /** True when no robots.txt was served, in which case everything is allowed. */
  readonly absent: boolean;
}

export const ALLOW_ALL: Robots = { groups: [], sitemaps: [], absent: true };

export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  let crawlDelay: number | undefined;
  // A blank line does not end a group; a User-agent line after rules does.
  let collectingAgents = false;

  const flush = (): void => {
    if (agents.length > 0) {
      groups.push(crawlDelay === undefined
        ? { agents, rules }
        : { agents, rules, crawlDelay });
    }
    agents = [];
    rules = [];
    crawlDelay = undefined;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    switch (field) {
      case 'user-agent':
        if (!collectingAgents) { flush(); collectingAgents = true; }
        agents.push(value.toLowerCase());
        break;
      case 'allow':
      case 'disallow':
        collectingAgents = false;
        // An empty Disallow means "allow everything" and carries no path.
        if (value !== '') rules.push({ allow: field === 'allow', path: value });
        break;
      case 'crawl-delay': {
        collectingAgents = false;
        const seconds = Number.parseFloat(value);
        if (Number.isFinite(seconds)) crawlDelay = seconds;
        break;
      }
      case 'sitemap':
        sitemaps.push(value);
        break;
      default:
        break;
    }
  }
  flush();

  return { groups, sitemaps, absent: false };
}

/**
 * The group that applies to a user agent: the longest matching agent token,
 * falling back to `*`. Matching is a case-insensitive substring test, which is
 * what the specification calls for.
 */
export function groupFor(robots: Robots, userAgent: string): RobotsGroup | null {
  const agent = userAgent.toLowerCase();
  let best: RobotsGroup | null = null;
  let bestLength = -1;
  let wildcard: RobotsGroup | null = null;

  for (const group of robots.groups) {
    for (const candidate of group.agents) {
      if (candidate === '*') {
        wildcard ??= group;
        continue;
      }
      if (agent.includes(candidate) && candidate.length > bestLength) {
        best = group;
        bestLength = candidate.length;
      }
    }
  }
  return best ?? wildcard;
}

/** Does a robots path pattern match this path? Supports `*` and a `$` anchor. */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source =
    body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

/**
 * Whether a URL may be fetched. Ties go to Allow, and an unmatched URL is
 * allowed — robots.txt is a deny list, not an allow list.
 */
export function isAllowed(robots: Robots, userAgent: string, url: string): boolean {
  if (robots.absent) return true;
  const group = groupFor(robots, userAgent);
  if (!group) return true;

  let path: string;
  try {
    const parsed = new URL(url);
    path = parsed.pathname + parsed.search;
  } catch {
    return true;
  }

  let decision = true;
  let winning = -1;
  for (const rule of group.rules) {
    if (!matches(rule.path, path)) continue;
    // Longest rule wins; on equal length, Allow wins.
    if (rule.path.length > winning || (rule.path.length === winning && rule.allow)) {
      decision = rule.allow;
      winning = rule.path.length;
    }
  }
  return decision;
}

/** Crawl-delay in milliseconds for this agent, or 0 when unspecified. */
export function crawlDelayMs(robots: Robots, userAgent: string): number {
  const group = groupFor(robots, userAgent);
  return group?.crawlDelay === undefined ? 0 : Math.round(group.crawlDelay * 1000);
}
