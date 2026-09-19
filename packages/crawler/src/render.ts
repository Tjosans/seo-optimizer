/**
 * A page as a browser builds it, not as the server sent it.
 *
 * `fetchPage` reads exactly the bytes a server sends; a script that fetches
 * data, hydrates a framework, or injects its own markup is invisible to it.
 * `renderPage` runs a real (headless) browser against the URL instead and
 * hands back the DOM after scripts have run, as HTML — so `extract()` reads a
 * render exactly the way it reads a raw response, and every existing
 * detector already knows how to look at one.
 *
 * Deliberately separate from `fetchPage` and the crawl walk: a render costs a
 * browser process running a page's scripts to completion, not a socket and a
 * few hundred KB, so nothing here happens unless something asks for it.
 * Cancellation follows the same rule as `crawl()` — a signal aborted mid-page
 * lets the request in flight finish rather than tearing the browser down
 * under it.
 */

import { chromium } from 'playwright';
import type { Browser, Page, Request } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

export interface AxeViolation {
  readonly id: string;
  /** axe's own grading: minor, moderate, serious or critical. Null when axe gave none. */
  readonly impact: string | null;
  /** How many elements the rule flagged. */
  readonly nodes: number;
}

/**
 * What axe-core found on the settled DOM. `error` is set when axe itself could
 * not run; `violations` is then empty, which says nothing about the page.
 */
export interface AccessibilityResult {
  readonly violations: readonly AxeViolation[];
  readonly error: string | null;
}

/** One request the browser made while building a page, the document itself included. */
export interface RenderedRequest {
  readonly url: string;
  readonly method: string;
  /** Playwright's resource type: `document`, `script`, `image`, `fetch`, … */
  readonly resourceType: string;
  /** Null when no response arrived, which is what `failed` says why. */
  readonly status: number | null;
  /** True when the request errored before a response (blocked, refused, aborted). */
  readonly failed: boolean;
}

/** A page's requests are recorded up to this many; the rest are counted out, not kept. */
export const MAX_RENDERED_REQUESTS = 500;

export interface RenderResult {
  readonly requestedUrl: string;
  /** Where the browser ended up, after any redirect or client-side navigation. */
  readonly finalUrl: string;
  readonly status: number | null;
  /** `document.documentElement.outerHTML` after the page settled. Empty on error. */
  readonly html: string;
  readonly totalMs: number | null;
  /** Set when no render was obtained at all. Never a verdict about the site. */
  readonly error: string | null;
  /** Every request the page made up to `MAX_RENDERED_REQUESTS`. Present whenever a render was obtained. */
  readonly requests?: readonly RenderedRequest[];
  /** True when the page made more requests than `requests` holds. */
  readonly requestsTruncated?: boolean;
  /** Present only when `RenderOptions.accessibility` asked for axe and a render was obtained. */
  readonly accessibility?: AccessibilityResult;
}

export interface RenderOptions {
  readonly userAgent: string;
  /** Ceiling on navigation itself. Default 20s: a browser is slower to fail than a socket. */
  readonly timeoutMs?: number;
  /** How long to wait after the load event for post-load scripts to settle. Default 500ms. */
  readonly settleMs?: number;
  /** Run axe-core on the settled page and put the result on `RenderResult.accessibility`. */
  readonly accessibility?: boolean;
  readonly signal?: AbortSignal;
}

const DEFAULTS = {
  timeoutMs: 20_000,
  settleMs: 500,
};

/**
 * One browser process for every render this package makes, launched on first
 * use and left running — starting Chromium costs far more than one page load,
 * so a fresh process per render would make rendering unusable at crawl scale.
 */
let sharedBrowser: Promise<Browser> | null = null;

function launch(): Promise<Browser> {
  sharedBrowser ??= chromium.launch({ headless: true });
  return sharedBrowser;
}

/** Release the shared browser process. Tests and short-lived scripts should call this when done. */
export async function closeBrowser(): Promise<void> {
  if (sharedBrowser === null) return;
  const instance = sharedBrowser;
  sharedBrowser = null;
  await (await instance).close().catch(() => {});
}

async function runAxe(page: Page): Promise<AccessibilityResult> {
  try {
    const { violations } = await new AxeBuilder({ page }).analyze();
    return {
      violations: violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length })),
      error: null,
    };
  } catch (cause) {
    return { violations: [], error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function renderPage(url: string, options: RenderOptions): Promise<RenderResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const settleMs = options.settleMs ?? DEFAULTS.settleMs;
  const started = performance.now();

  const failure = (error: string): RenderResult => ({
    requestedUrl: url,
    finalUrl: url,
    status: null,
    html: '',
    totalMs: null,
    error,
  });
  const signal = options.signal;
  const aborted = (): boolean => signal?.aborted === true;

  if (aborted()) return failure('cancelled');

  let instance: Browser;
  try {
    instance = await launch();
  } catch (cause) {
    return failure(cause instanceof Error ? cause.message : String(cause));
  }

  const context = await instance.newContext({ userAgent: options.userAgent });
  try {
    const page = await context.newPage();
    const onAbort = (): void => {
      page.close().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const requests: { -readonly [K in keyof RenderedRequest]: RenderedRequest[K] }[] = [];
    const byRequest = new Map<Request, (typeof requests)[number]>();
    let requestsTruncated = false;
    page.on('request', (request) => {
      if (requests.length >= MAX_RENDERED_REQUESTS) {
        requestsTruncated = true;
        return;
      }
      const entry = {
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: null,
        failed: false,
      };
      requests.push(entry);
      byRequest.set(request, entry);
    });
    page.on('response', (response) => {
      const entry = byRequest.get(response.request());
      if (entry !== undefined) entry.status = response.status();
    });
    page.on('requestfailed', (request) => {
      const entry = byRequest.get(request);
      if (entry !== undefined) entry.failed = true;
    });
    try {
      const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      if (aborted()) return failure('cancelled');
      await page.waitForTimeout(settleMs);
      const html = await page.content();
      const accessibility = options.accessibility === true ? await runAxe(page) : undefined;
      return {
        requestedUrl: url,
        finalUrl: page.url(),
        status: response?.status() ?? null,
        html,
        totalMs: Math.round(performance.now() - started),
        error: null,
        requests: requests.map((r) => ({ ...r })),
        requestsTruncated,
        ...(accessibility === undefined ? {} : { accessibility }),
      };
    } catch (cause) {
      return failure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    await context.close().catch(() => {});
  }
}
