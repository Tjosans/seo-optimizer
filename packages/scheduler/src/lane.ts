/**
 * Which audits may not crawl at the same time.
 *
 * The queue serializes jobs that share a lane, and politeness is owed to a
 * host, so the lane has to name the host an audit's requests reach — not the
 * string a person typed into the site record. Those differ in two ways that
 * matter.
 *
 *   **The scheme.** `http://example.com` and `https://example.com` are two
 *   origins and one server. Two site records spelled those ways, laned apart,
 *   would be crawled together.
 *
 *   **A leading `www.`.** Every crawl tests all four scheme/host spellings of
 *   its seed (`hostVariants` in @seo/crawler) and follows redirects wherever
 *   they lead, so an audit of `example.com` requests `www.example.com` and the
 *   reverse. Laned apart, the two would reach both hosts at once.
 *
 * A port other than the scheme's default stays in the key, because a service on
 * its own port — a staging build, a fixture site in a test — is usually its own
 * process, and serializing it behind the production site would slow audits
 * without sparing anyone load.
 *
 * Other subdomains stay apart: `blog.example.com` is often another platform
 * entirely, and the crawl never leaves the host it started on.
 */
export function auditLane(origin: string): string {
  const url = new URL(origin);
  // `URL` has already lowercased the host and dropped a default port.
  const host = url.hostname.replace(/^www\./, '');
  return url.port === '' ? host : `${host}:${url.port}`;
}
