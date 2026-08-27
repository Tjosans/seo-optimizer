/**
 * A deliberately imperfect website, served from memory.
 *
 * Every defect here is one a probe is expected to find: a duplicate title, a
 * redirect chain, a soft 404, an orphan, a page missing its canonical. Tests
 * assert against this rather than the live web, so a probe's behaviour is
 * pinned to markup a reader can inspect instead of to whatever example.com
 * happens to serve today.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureSite {
  readonly origin: string;
  /** URLs requested so far, in order. Lets a test assert on politeness. */
  readonly requests: readonly string[];
  close(): Promise<void>;
}

interface Route {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

const page = (options: {
  title: string;
  h1?: string | null;
  canonical?: string | null;
  description?: string | null;
  body?: string;
  images?: string;
  extra?: string;
  landmarks?: boolean;
}): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title}</title>
${options.description === null ? '' : `<meta name="description" content="${options.description ?? 'A description of this page that is comfortably long enough to be useful to a reader.'}">`}
${options.canonical === null ? '' : `<link rel="canonical" href="${options.canonical ?? ''}">`}
<meta property="og:title" content="${options.title}">
<meta property="og:description" content="Social description.">
<meta property="og:image" content="/img/card.png">
<meta property="og:url" content="${options.canonical ?? '/'}">
<script src="https://cdn.example.com/analytics.js"></script>
</head>
<body>
${options.landmarks === false ? '' : '<header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>'}
<main>
${options.h1 === null ? '' : `<h1>${options.h1 ?? options.title}</h1>`}
${options.images ?? ''}
${options.extra ?? ''}
<p>${options.body ?? 'Body copy that runs long enough to look like a real page rather than a stub, so the soft-404 heuristic has something to measure. '.repeat(3)}</p>
<a href="/about">About us</a>
<a href="/deep/one">Deeper</a>
</main>
${options.landmarks === false ? '' : '<footer><a href="/about-us">About us, again</a></footer>'}
</body>
</html>`;

export async function startFixtureSite(): Promise<FixtureSite> {
  const requests: string[] = [];
  let origin = '';

  const routes = (): Record<string, Route> => ({
    '/robots.txt': {
      headers: { 'content-type': 'text/plain' },
      body: `User-agent: *\nDisallow: /private/\n\nSitemap: ${origin}/sitemap.xml\n`,
    },
    '/sitemap.xml': {
      headers: { 'content-type': 'application/xml' },
      body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc></url>
  <url><loc>${origin}/about</loc></url>
  <url><loc>${origin}/orphan</loc></url>
</urlset>`,
    },
    '/': {
      body: page({
        title: 'Home | Fixture',
        canonical: `${origin}/`,
        images:
          '<img src="/img/hero.png" alt="A hero image" width="800" height="400" srcset="/img/hero.png 1x">',
        // Linked but disallowed, so a crawl has to decide not to fetch it.
        extra: '<a href="/private/secret">Members area</a>',
      }),
    },
    // No canonical, no h1: two findings on one page.
    '/about': {
      body: page({
        title: 'Shared title',
        h1: null,
        canonical: null,
        images: '<img src="/img/team.png" loading="lazy">',
        extra:
          '<a href="/gone">A link that 404s</a> <a href="/search?q=shoes">Search for shoes</a>',
      }),
    },
    // Indexable search results: a crawl trap that belongs out of the index.
    '/search': {
      body: page({ title: 'Search results | Fixture', canonical: null }),
    },
    // Same title as /about, which only a site-scoped probe can notice.
    '/about-us': {
      body: page({ title: 'Shared title', canonical: `${origin}/about-us` }),
    },
    '/deep/one': {
      body: page({ title: 'Deep one | Fixture', canonical: `${origin}/deep/one` }),
    },
    '/orphan': {
      body: page({ title: 'Orphan | Fixture', canonical: `${origin}/orphan` }),
    },
    '/old': { status: 301, headers: { location: `${origin}/older` }, body: '' },
    '/older': { status: 301, headers: { location: `${origin}/new` }, body: '' },
    '/new': { body: page({ title: 'New | Fixture', canonical: `${origin}/new` }) },
    '/soft-404': {
      body: page({ title: 'Page not found', h1: 'Page not found', body: 'Sorry.' }),
    },
    '/private/secret': { body: page({ title: 'Secret | Fixture' }) },
  });

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    requests.push(path);

    const route = routes()[path];
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end(page({ title: 'Not found', h1: 'Not found', body: 'No such page.' }));
      return;
    }
    response.writeHead(route.status ?? 200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'max-age=60',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      ...route.headers,
    });
    response.end(route.body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
