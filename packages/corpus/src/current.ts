/**
 * The methodology the engine currently follows.
 *
 * Detectors are not versioned: each one implements what this corpus version
 * asks, and changes when a new version is adopted. Older versions stay on disk
 * so an audit pinned to one can still be re-graded from its stored evidence,
 * but a new crawl is judged by the detectors as they are now.
 *
 * The tools that report on coverage and analyze live sites read this rather
 * than naming a version, so adopting a new methodology is one line here.
 */
export const CURRENT_CORPUS_VERSION = '5.0';
