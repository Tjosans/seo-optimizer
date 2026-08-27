/**
 * Images: the accessibility, layout-stability and loading-order signals that
 * can be read from markup alone. Anything needing real layout — actual LCP
 * timing, rendered dimensions — belongs to a rendering probe, not these.
 */

import type { PageProbe } from '../types.js';
import { fail, notApplicable, pass, warn } from '../types.js';

const NO_HTML = 'No HTML was parsed for this response.';

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

export const mediaProbes = [imageAltQuality, imageDimensions, responsiveMedia, lcpNotLazy];
