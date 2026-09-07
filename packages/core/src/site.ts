/**
 * What a person has decided about their site, as opposed to what a crawler can
 * observe about it.
 *
 * Site-profile flags were the first of these: a check applies to multilingual
 * sites, and only the people who built it know whether it is one. The AI
 * crawler policy is the second, and it is the sharper case, because there is no
 * observation that could stand in for it. A crawler can read that robots.txt
 * disallows GPTBot. It cannot read whether that is what anyone intended —
 * a site whose owner wanted to be in AI answers and a site whose owner wanted
 * to be out of them look identical from outside, and their robots.txt files
 * disagree with their intentions in opposite directions.
 *
 * So corpus check 2.9 asks for robots.txt, CDN behaviour and a user-agent test
 * to "agree with the policy", and until the policy is written down there is
 * nothing for them to agree with. This is that policy.
 */

/** What the site's owners decided about one crawler. */
export type AiCrawlerStance = 'allow' | 'disallow';

/**
 * The AI crawler policy a site's owners approved.
 *
 * Agent names are text keys, deliberately: new AI crawlers appear faster than
 * anything that needs a migration should change, and the ones that matter this
 * year are not the ones that mattered last year. Matching is
 * case-insensitive on the robots.txt product token — `GPTBot`,
 * `Google-Extended`, `CCBot`, `ClaudeBot`, `PerplexityBot` — because that is
 * the name the site will have written in its own file.
 */
export interface AiCrawlerPolicy {
  /**
   * Stance per crawler. An agent absent here has no decision recorded, and a
   * check must not invent one: silence is not consent, and it is not refusal.
   */
  readonly agents: Readonly<Record<string, AiCrawlerStance>>;
  /**
   * When this policy was approved, as YYYY-MM-DD.
   *
   * The corpus asks for a *dated* user-agent test, and a date on the test is
   * only meaningful against a date on the thing it tested. A policy approved
   * two years ago has probably not heard of half the crawlers now reading the
   * site.
   */
  readonly approvedAt: string;
  /** Who takes responsibility for it. Free text until identities are modelled. */
  readonly approvedBy: string;
  /** What the decision was for, in the approver's own words. */
  readonly notes?: string;
}

const STANCES = new Set<string>(['allow', 'disallow']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read a policy off a `sites` row, or `null` when none is recorded.
 *
 * Throws on a row that holds something policy-shaped but wrong, because the
 * alternative is a check quietly grading against half a policy. A site with no
 * policy at all is not an error — most sites have not made this decision, and
 * the checks that need one are conditional on the `ai-policy` flag.
 */
export function parseAiCrawlerPolicy(raw: unknown): AiCrawlerPolicy | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error('ai policy must be an object');

  const record = raw as Record<string, unknown>;
  const approvedAt = record['approvedAt'];
  if (typeof approvedAt !== 'string' || !DATE.test(approvedAt)) {
    throw new Error('ai policy needs an approvedAt date of the form YYYY-MM-DD');
  }
  const approvedBy = record['approvedBy'];
  if (typeof approvedBy !== 'string' || approvedBy.trim() === '') {
    throw new Error('ai policy needs an approvedBy');
  }

  const agents = record['agents'];
  if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) {
    throw new Error('ai policy needs an agents object');
  }
  const parsed: Record<string, AiCrawlerStance> = {};
  for (const [agent, stance] of Object.entries(agents as Record<string, unknown>)) {
    if (typeof stance !== 'string' || !STANCES.has(stance)) {
      throw new Error(`ai policy stance for "${agent}" must be "allow" or "disallow"`);
    }
    parsed[agent] = stance as AiCrawlerStance;
  }

  const notes = record['notes'];
  return {
    agents: parsed,
    approvedAt,
    approvedBy,
    ...(typeof notes === 'string' && notes !== '' ? { notes } : {}),
  };
}
