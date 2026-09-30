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

/** The phone viewport a mobile render uses. */
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

/** A mobile Chromium user agent, so a site that serves by device sees a phone. */
export const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

export interface RenderOptions {
  readonly userAgent: string;
  /**
   * Render as a phone: a `MOBILE_VIEWPORT` touch device under `MOBILE_USER_AGENT`,
   * followed by `userAgent` so the site can still see who is asking.
   */
  readonly mobile?: boolean;
  /** Ceiling on navigation itself. Default 20s: a browser is slower to fail than a socket. */
  readonly timeoutMs?: number;
  /** How long to wait after the load event for post-load scripts to settle. Default 500ms. */
  readonly settleMs?: number;
  /** Run axe-core on the settled page and put the result on `RenderResult.accessibility`. */
  readonly accessibility?: boolean;
  /**
   * Ceiling on the axe-core run. Default 60s. axe runs inside the page with no
   * limit of its own, and on iana.org's 5 MB, 3,865-link /domains/idn-tables
   * it ran for over half an hour at 4 GB and held the whole crawl with it.
   */
  readonly axeTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * The tallest a render's viewport is stretched to.
 *
 * Googlebot does not scroll: it renders with a viewport stretched to the
 * page's height, so content a site loads when it scrolls into view is
 * rendered. A render left at a screen's height never loads it, and kjell.com's
 * footer — twenty-odd links swapped for a placeholder until visible — read as
 * links rendering removed. Past this the page is cut, which is a browser's
 * texture limit rather than a site's length.
 */
export const MAX_RENDER_HEIGHT = 16_000;

const DEFAULTS = {
  timeoutMs: 20_000,
  settleMs: 500,
  axeTimeoutMs: 60_000,
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
  const browser = await instance;
  // A browser that will not shut down must not hold the caller: give it a
  // moment, then let it go (it is killed with its parent process).
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 20_000);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}

/**
 * axe-core on the settled page, bounded by `timeoutMs`.
 *
 * A run past the bound closes the page, which is the only way to stop a
 * script already evaluating inside it, and is reported as an `error`: axe
 * did not finish, so it says nothing about the page, never that it passed.
 */
async function runAxe(page: Page, timeoutMs: number): Promise<AccessibilityResult> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), timeoutMs);
  });
  const analysis = new AxeBuilder({ page }).analyze();
  // Once the page is closed the analysis rejects; nobody is waiting for it then.
  analysis.catch(() => {});
  try {
    const outcome = await Promise.race([analysis, expired]);
    if (outcome === 'expired') {
      await page.close().catch(() => {});
      return { violations: [], error: `axe-core did not finish within ${Math.round(timeoutMs / 1000)}s` };
    }
    return {
      violations: outcome.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length })),
      error: null,
    };
  } catch (cause) {
    return { violations: [], error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    clearTimeout(timer);
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

  const context = await instance.newContext(
    options.mobile === true
      ? {
        userAgent: `${MOBILE_USER_AGENT} ${options.userAgent}`,
        viewport: MOBILE_VIEWPORT,
        isMobile: true,
        hasTouch: true,
      }
      : { userAgent: options.userAgent },
  );
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
      const viewport = page.viewportSize();
      // A string, because this package is typed for Node and has no DOM.
      const height = Number(await page.evaluate('document.documentElement.scrollHeight').catch(() => 0));
      if (viewport !== null && height > viewport.height) {
        await page.setViewportSize({ width: viewport.width, height: Math.min(height, MAX_RENDER_HEIGHT) });
        await page.waitForTimeout(settleMs);
      }
      if (aborted()) return failure('cancelled');
      const html = await page.content();
      const accessibility = options.accessibility === true
        ? await runAxe(page, options.axeTimeoutMs ?? DEFAULTS.axeTimeoutMs)
        : undefined;
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
