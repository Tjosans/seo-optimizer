/**
 * A single HTTP fetch, recorded the way an audit needs it.
 *
 * Redirects are followed manually rather than by the platform, because the
 * chain itself is evidence: detector `redirect-chain` cannot be answered from
 * a final 200. Transport failures are returned as data rather than thrown —
 * a site that times out is a finding, not an exception.
 */

export interface RedirectHop {
  readonly url: string;
  readonly status: number;
  readonly location: string;
}

export interface FetchResult {
  /** The URL requested, before any redirect. */
  readonly requestedUrl: string;
  /** Where the chain ended. Equals requestedUrl when there was no redirect. */
  readonly finalUrl: string;
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly redirectChain: readonly RedirectHop[];
  readonly body: string;
  /**
   * Bytes of body read, after any decompression. When `truncated`, this is
   * how far the read got — a lower bound on the size, not the size.
   */
  readonly byteLength: number;
  /**
   * Whether the body was read to its end.
   *
   * A body cut at `maxBytes` parses cleanly and is wrong in a way nothing
   * downstream can see: the last element is severed mid-attribute, and a
   * detector reading it finds a page or a sitemap entry missing what it
   * needs. That is the engine's cut, not the site's defect, so it has to be
   * visible — a probe reading a truncated body must say it could not observe,
   * never that the site is broken. A gzip file that stops decompressing part
   * way is marked the same way: what came before the damage is real, and
   * nothing after it was observed.
   */
  readonly truncated: boolean;
  readonly contentType: string | null;
  /** Time to the response head, in ms. */
  readonly ttfbMs: number | null;
  /** Time to the last byte of the body, in ms. */
  readonly totalMs: number | null;
  /**
   * The raw body of a small non-textual response.
   *
   * Textual bodies live in `body`; this is for the handful of assets an audit
   * has to look inside rather than merely count — a favicon whose dimensions
   * decide whether it is usable, today. Absent for textual responses, for
   * anything larger than `maxAssetBytes`, and unless `keepBytes` asked for it,
   * because holding megabytes of images in a crawl that already holds every
   * page would trade a real memory budget for nothing.
   */
  readonly bytes?: Uint8Array;
  /** Set when no response was obtained at all. Never a verdict about the site. */
  readonly error: string | null;
}

export interface FetchOptions {
  readonly userAgent: string;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /**
   * Stop reading a body past this size, and cancel the rest of the response.
   *
   * The response is read a chunk at a time and abandoned at the limit, so a
   * tarpit — or a link to a two-gigabyte video the walk followed like any
   * other — costs this much and no more, in bandwidth and in memory.
   */
  readonly maxBytes?: number;
  readonly acceptLanguage?: string;
  /** Keep the raw body of a non-textual response, up to `maxAssetBytes`. */
  readonly keepBytes?: boolean;
  /** Ceiling on a kept binary body. Defaults to 512 KB. */
  readonly maxAssetBytes?: number;
  /**
   * Hand a textual body over as it arrives, instead of keeping it.
   *
   * For a document fetched only to be parsed into something far smaller — a
   * sitemap — the whole body held as one string is the expensive part. With
   * this set, each decoded chunk goes to the callback and `body` comes back
   * empty.
   */
  readonly onText?: (chunk: string) => void;
  /**
   * Read a body that is itself a gzip file as the text inside it.
   *
   * Sitemaps are routinely published as `sitemap.xml.gz`, and the protocol
   * allows it. That is a file, not transport compression: `fetch` already
   * undoes `Content-Encoding`, but a gzip file arrives still compressed and
   * labelled however the server likes — `application/gzip`, `x-gzip`,
   * `octet-stream`, now and then `text/xml`. So the file is recognised by its
   * first two bytes rather than by its label, and `maxBytes` applies to what
   * it expands to, which is also what stops a small file that inflates without
   * end from being read without end.
   */
  readonly gunzip?: boolean;
}

const DEFAULTS = {
  timeoutMs: 15_000,
  maxRedirects: 10,
  maxBytes: 5_000_000,
  /** A favicon is a few KB. Anything near this is not an icon. */
  maxAssetBytes: 512_000,
};

const headersToObject = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
};

/** Only these bodies are worth reading; anything else is measured, not parsed. */
const TEXTUAL = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml))/;

interface BodyRead {
  readonly byteLength: number;
  readonly truncated: boolean;
}

/**
 * Read a stream chunk by chunk into `sink`, stopping at `maxBytes`.
 *
 * The chunk that crosses the limit is delivered up to the limit and no
 * further, and the rest of the stream is cancelled rather than downloaded to
 * be thrown away. An error `unreadable` recognises ends the read as truncated
 * instead of failing it; anything else is rethrown.
 */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  sink: (chunk: Uint8Array) => void,
  unreadable: (cause: unknown) => boolean = () => false,
): Promise<BodyRead> {
  let byteLength = 0;
  const reader = stream.getReader();
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await reader.read();
    } catch (cause) {
      if (unreadable(cause)) return { byteLength, truncated: true };
      throw cause;
    }
    if (next.done) return { byteLength, truncated: false };
    const chunk = next.value;
    const room = maxBytes - byteLength;
    byteLength += chunk.byteLength;
    if (chunk.byteLength > room) {
      if (room > 0) sink(chunk.subarray(0, room));
      await reader.cancel();
      return { byteLength, truncated: true };
    }
    sink(chunk);
  }
}

/** Every gzip file begins with these two bytes. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

interface Unwrapped {
  readonly stream: ReadableStream<Uint8Array>;
  readonly gzip: boolean;
  /** Whether an error came from the network rather than from decompressing. */
  readonly sourceFailed: () => boolean;
}

/**
 * The body as a stream of what it contains, with a gzip file opened.
 *
 * Deciding means looking at the first two bytes, which means reading them;
 * they are replayed ahead of the rest, so the stream handed back is the whole
 * body either way. Errors from the network are noted as they pass, so a
 * connection that drops mid-file can still be told apart from a file that is
 * damaged — the first is a failed fetch, the second a body read as far as it
 * could be.
 */
async function unwrapGzip(body: ReadableStream<Uint8Array>): Promise<Unwrapped> {
  const reader = body.getReader();
  const head: Uint8Array[] = [];
  let headLength = 0;
  let ended = false;
  while (headLength < GZIP_MAGIC.length) {
    const next = await reader.read();
    if (next.done) {
      ended = true;
      break;
    }
    head.push(next.value);
    headLength += next.value.byteLength;
  }

  let sourceFailed = false;
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk);
      if (ended) controller.close();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (cause) {
        sourceFailed = true;
        throw cause;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const lead = Buffer.concat(head).subarray(0, GZIP_MAGIC.length);
  const gzip = lead.length === GZIP_MAGIC.length && GZIP_MAGIC.every((byte, i) => lead[i] === byte);
  return {
    stream: gzip ? replay.pipeThrough(new DecompressionStream('gzip')) : replay,
    gzip,
    sourceFailed: () => sourceFailed,
  };
}

export async function fetchPage(url: string, options: FetchOptions): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxAssetBytes = options.maxAssetBytes ?? DEFAULTS.maxAssetBytes;

  const redirectChain: RedirectHop[] = [];
  const started = performance.now();
  let current = url;

  const headers: Record<string, string> = {
    'user-agent': options.userAgent,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
  };
  if (options.acceptLanguage) headers['accept-language'] = options.acceptLanguage;

  const failure = (error: string): FetchResult => ({
    requestedUrl: url,
    finalUrl: current,
    status: null,
    headers: {},
    redirectChain,
    body: '',
    byteLength: 0,
    truncated: false,
    contentType: null,
    ttfbMs: null,
    totalMs: null,
    error,
  });

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      const reason = cause instanceof Error ? cause.message : String(cause);
      return failure(controller.signal.aborted ? `timeout after ${timeoutMs}ms` : reason);
    }
    const ttfbMs = Math.round(performance.now() - started);
    const responseHeaders = headersToObject(response.headers);

    const location = responseHeaders['location'];
    if (response.status >= 300 && response.status < 400 && location !== undefined) {
      clearTimeout(timer);
      await response.body?.cancel();
      redirectChain.push({ url: current, status: response.status, location });
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return failure(`unresolvable redirect target "${location}"`);
      }
      if (next === current) return failure('redirect loop: target is the current URL');
      current = next;
      continue;
    }

    const contentType = responseHeaders['content-type'] ?? null;
    let body = '';
    let byteLength = 0;
    let truncated = false;
    let bytes: Uint8Array | undefined;
    try {
      if (response.body !== null) {
        const source: Unwrapped = options.gunzip === true
          ? await unwrapGzip(response.body)
          : { stream: response.body, gzip: false, sourceFailed: () => false };

        if (source.gzip || contentType === null || TEXTUAL.test(contentType)) {
          const decoder = new TextDecoder();
          const parts: string[] = [];
          const emit = options.onText ?? ((text: string): void => { parts.push(text); });
          ({ byteLength, truncated } = await readBounded(
            source.stream,
            maxBytes,
            (chunk) => {
              const text = decoder.decode(chunk, { stream: true });
              if (text !== '') emit(text);
            },
            () => source.gzip && !source.sourceFailed(),
          ));
          // A multi-byte character severed by a cut is left undecoded: the body
          // is marked truncated either way, and a replacement character at the
          // end of it would be one more thing that looks like the site's.
          if (!truncated) {
            const tail = decoder.decode();
            if (tail !== '') emit(tail);
          }
          body = parts.join('');
        } else {
          const keep = options.keepBytes === true;
          const kept: Uint8Array[] = [];
          let keptLength = 0;
          ({ byteLength, truncated } = await readBounded(source.stream, maxBytes, (chunk) => {
            keptLength += chunk.byteLength;
            if (keep && keptLength <= maxAssetBytes) kept.push(chunk);
          }));
          if (keep && !truncated && byteLength <= maxAssetBytes) {
            bytes = new Uint8Array(Buffer.concat(kept));
          }
        }
      }
    } catch (cause) {
      clearTimeout(timer);
      return failure(cause instanceof Error ? cause.message : String(cause));
    }
    clearTimeout(timer);

    return {
      requestedUrl: url,
      finalUrl: current,
      status: response.status,
      headers: responseHeaders,
      redirectChain,
      body,
      byteLength,
      truncated,
      ...(bytes === undefined ? {} : { bytes }),
      contentType,
      ttfbMs,
      totalMs: Math.round(performance.now() - started),
      error: null,
    };
  }

  return failure(`exceeded ${maxRedirects} redirects`);
}
