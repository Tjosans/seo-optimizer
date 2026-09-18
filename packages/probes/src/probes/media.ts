/**
 * Images: the accessibility, layout-stability and loading-order signals that
 * can be read from markup alone. Anything needing real layout — actual LCP
 * timing, rendered dimensions — belongs to a rendering probe, not these.
 */

import { isAllowed, isSameSite, resolveUrl } from '@seo/crawler';
import type { PageProbe, SiteProbe } from '../types.js';
import { fail, notApplicable, pass, warn } from '../types.js';
import { declaresArticle } from './content.js';

const NO_HTML = 'No HTML was parsed for this response.';

/** The agent Google fetches images with; falls back to `*` like every other. */
const IMAGE_AGENT = 'Googlebot-Image';

/** Filenames masquerading as alt text: "IMG_2043.jpg", "hero-banner-2.png". */
const FILENAME_ALT = /^[\w\-. ]+\.(jpe?g|png|gif|webp|avif|svg)$/i;

export const imageAltQuality: PageProbe = {
  id: 'image-alt-quality',
  scope: 'page',
  htmlOnly: true,
  title: 'Meaningful images carry useful alt text',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);
    const images = extracted.images;
    if (images.length === 0) return notApplicable('The page has no <img> elements.');

    // alt="" is a valid, deliberate statement that an image is decorative.
    const missing = images.filter((image) => image.alt === null);
    const filenames = images.filter((image) => image.alt !== null && FILENAME_ALT.test(image.alt));

    if (missing.length > 0) {
      return fail(`${missing.length} of ${images.length} image(s) have no alt attribute.`, {
        samples: missing.slice(0, 5).map((image) => image.src),
      });
    }
    if (filenames.length > 0) {
      return warn(`${filenames.length} image(s) use a filename as alt text.`, {
        samples: filenames.slice(0, 5).map((image) => image.alt),
      });
    }
    return pass(`All ${images.length} image(s) declare alt text.`);
  },
};

export const imageDimensions: PageProbe = {
  id: 'image-dimensions',
  scope: 'page',
  htmlOnly: true,
  title: 'Images reserve their space before they load',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);
    const images = extracted.images;
    if (images.length === 0) return notApplicable('The page has no <img> elements.');

    const unsized = images.filter((image) => image.width === null || image.height === null);
    return unsized.length === 0
      ? pass(`All ${images.length} image(s) declare width and height.`)
      : fail(`${unsized.length} of ${images.length} image(s) declare no width/height.`, {
          samples: unsized.slice(0, 5).map((image) => image.src),
        });
  },
};

export const responsiveMedia: PageProbe = {
  id: 'responsive-media',
  scope: 'page',
  htmlOnly: true,
  title: 'Images are served responsively',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);
    if (!extracted.hasViewportMeta) {
      return fail('No viewport meta tag; the page cannot adapt to a phone at all.');
    }
    const images = extracted.images;
    if (images.length === 0) return pass('Viewport meta is set; the page has no images.');

    const fixed = images.filter((image) => !image.hasSrcset);
    return fixed.length === 0
      ? pass(`Viewport meta is set and all ${images.length} image(s) declare a srcset.`)
      : warn(`${fixed.length} of ${images.length} image(s) ship one fixed source.`, {
          samples: fixed.slice(0, 5).map((image) => image.src),
        });
  },
};

export const lcpNotLazy: PageProbe = {
  id: 'lcp-not-lazy',
  scope: 'page',
  htmlOnly: true,
  title: 'The likely LCP image is not lazy-loaded',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);
    const first = extracted.images[0];
    if (first === undefined) return notApplicable('The page has no <img> elements.');

    // Document order is a proxy for "above the fold". A rendering probe can
    // identify the real LCP element; this catches the common regression early.
    if (first.loading?.toLowerCase() === 'lazy') {
      return fail('The first image on the page is lazy-loaded, delaying the likely LCP.', {
        src: first.src,
      });
    }
    const lazyCount = extracted.images.filter((i) => i.loading?.toLowerCase() === 'lazy').length;
    return pass('The first image loads eagerly.', {
      src: first.src,
      lazyImages: lazyCount,
      totalImages: extracted.images.length,
    });
  },
};

/**
 * Media that carries meaning has a way to reach it without playing.
 *
 * The corpus asks for accessibility alternatives to be "present" and
 * "accurate". Present is a markup fact and is answered here; accurate is a
 * person watching the video and reading the captions, and no probe should
 * pretend otherwise — so a page with captions passes this detector on the
 * question it can actually settle, and 1.9 still needs the rest of its
 * detectors before the check clears.
 *
 * Images are not this probe's business: their alternative is alt text, which
 * `image-alt-quality` already reads.
 */
export const mediaAlternatives: PageProbe = {
  id: 'media-alternatives',
  scope: 'page',
  htmlOnly: true,
  title: 'Video and audio carry captions or a text alternative',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const media = extracted.media;
    if (media.length === 0) {
      return notApplicable('The page embeds no <video> or <audio> element.');
    }

    // A caption track is the alternative; fallback text between the tags is a
    // weaker one, and no track plus no text is content only some people get.
    const silent = media.filter((item) => !item.hasCaptions && !item.hasFallbackText);
    if (silent.length > 0) {
      return fail(
        `${silent.length} of ${media.length} media element(s) offer no captions and no text alternative.`,
        { samples: silent.slice(0, 5).map((item) => item.src ?? `<${item.kind}>`) },
      );
    }

    const textOnly = media.filter((item) => !item.hasCaptions);
    if (textOnly.length > 0) {
      return warn(
        `${textOnly.length} media element(s) have fallback text but no caption track.`,
        { samples: textOnly.slice(0, 5).map((item) => item.src ?? `<${item.kind}>`) },
      );
    }

    return pass(`All ${media.length} media element(s) declare a caption or subtitle track.`);
  },
};

/**
 * 2.3 asks that a site's important images be crawlable and discoverable, with
 * a representative image on selected pages. Google's own size and aspect
 * recommendations are recorded decisions, not a universal requirement the
 * corpus's own wording asks a probe to enforce — the one defect this can name
 * outright is a representative image robots.txt turns a crawler away from.
 */
export const imageDiscoverability: PageProbe = {
  id: 'image-discoverability',
  scope: 'page',
  htmlOnly: true,
  title: "A page's representative image is crawlable",
  run({ page, site }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const declared = extracted.openGraph['og:image'] ?? extracted.twitter['twitter:image'];
    if (declared === undefined) {
      return notApplicable('The page declares no og:image or twitter:image.');
    }
    const resolved = resolveUrl(declared, page.url);
    if (resolved === null) {
      return notApplicable('The declared representative image URL could not be resolved.');
    }
    if (!isSameSite(resolved, site.origin)) {
      return pass('The representative image is hosted off-site; this site\'s robots.txt has nothing to say about it.', {
        image: resolved,
      });
    }
    if (!isAllowed(site.crawl.robots, IMAGE_AGENT, resolved)) {
      return fail("robots.txt keeps Googlebot-Image from the page's representative image.", {
        image: resolved,
      });
    }
    return pass('The representative image is crawlable.', { image: resolved });
  },
};

/** Discover's minimum representative-image width, per Google's own guidance. */
const DISCOVER_MIN_WIDTH = 1200;

/**
 * 2.16 scopes itself to sites electing Discover presentation or Preferred
 * Sources (`site.flags` names `discover`), and its own `doneWhen` defers
 * almost everything to a person: accurate previews, documented policy
 * decisions, actual indexed evidence, Preferred Sources adoption. The one
 * requirement stated as a requirement rather than a record is the
 * representative image large-preview eligibility needs — declared at
 * Discover's minimum width, and not opted out of by `max-image-preview`. A
 * page the crawl does not type as an article is outside 2.16's subject
 * entirely, the same reading `author-date-signals` already gives "articles".
 */
export const publisherDiscoverReadiness: SiteProbe = {
  id: 'publisher-discover-readiness',
  scope: 'site',
  title: 'Article pages carry a Discover-eligible representative image',
  run({ crawl }) {
    const ineligible: { url: string; reason: string }[] = [];
    const missing: string[] = [];
    let articles = 0;

    for (const page of crawl.pages) {
      const extracted = page.extracted;
      if (extracted === null || page.fetch.status !== 200) continue;
      if (!declaresArticle(extracted)) continue;
      articles += 1;
      const url = page.normalizedUrl;

      const image = extracted.openGraph['og:image'];
      if (image === undefined) {
        missing.push(url);
        continue;
      }

      const width = Number.parseInt(extracted.openGraph['og:image:width'] ?? '', 10);
      if (Number.isFinite(width) && width < DISCOVER_MIN_WIDTH) {
        ineligible.push({ url, reason: `og:image:width is ${width}px, under Discover's ${DISCOVER_MIN_WIDTH}px` });
      }

      const directives = `${extracted.metaRobots ?? ''} ${page.fetch.headers['x-robots-tag'] ?? ''}`;
      const preview = /max-image-preview:\s*(\S+)/i.exec(directives)?.[1];
      if (preview !== undefined && preview.toLowerCase() !== 'large') {
        ineligible.push({ url, reason: `max-image-preview is "${preview}", not "large"` });
      }
    }

    if (articles === 0) return notApplicable('The site has no pages typed as articles.');

    if (ineligible.length > 0) {
      return fail(
        `${ineligible.length} article page(s) opt out of Discover's large-preview image eligibility.`,
        { samples: ineligible.slice(0, 5) },
      );
    }
    if (missing.length > 0) {
      return warn(`${missing.length} of ${articles} article page(s) declare no og:image.`, {
        samples: missing.slice(0, 5),
      });
    }
    return pass(`All ${articles} article page(s) declare a Discover-eligible representative image.`);
  },
};

export const mediaProbes = [
  imageAltQuality,
  imageDimensions,
  responsiveMedia,
  lcpNotLazy,
  mediaAlternatives,
  imageDiscoverability,
  publisherDiscoverReadiness,
];
