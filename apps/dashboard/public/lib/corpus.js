// The methodology, fetched once per version from `GET /corpus[/:version]` and
// kept for the life of the page: a corpus version never changes on disk.

import { api } from './api.js';

const cache = new Map();

/** Resolves a corpus version (the current one when omitted), with lookups built in. */
export function getCorpus(version) {
  const key = version ?? '';
  if (!cache.has(key)) {
    const pending = api.get(version ? `/corpus/${encodeURIComponent(version)}` : '/corpus').then(index);
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return cache.get(key);
}

function index(raw) {
  // The workbook's labels carry their own number ("1 — Day 1 architecture");
  // the app always shows the number beside the label, so keep the words.
  const corpus = { ...raw, checks: raw.checks.map((c) => ({ ...c, phaseLabel: c.phaseLabel.replace(/^\d+\s*[—–-]\s*/, '') })) };
  const byId = new Map(corpus.checks.map((c) => [c.id, c]));
  const phases = [];
  for (const check of corpus.checks) {
    let phase = phases.find((p) => p.phase === check.phase);
    if (!phase) phases.push((phase = { phase: check.phase, label: check.phaseLabel, count: 0, gates: 0 }));
    phase.count += 1;
    if (check.launchGate) phase.gates += 1;
  }
  phases.sort((a, b) => a.phase - b.phase);
  const owners = [...new Set(corpus.checks.flatMap((c) => c.owners))].sort();
  const detectors = new Set(corpus.checks.flatMap((c) => c.detectors));
  return {
    ...corpus,
    byId,
    phases,
    owners,
    detectorCount: detectors.size,
    gateCount: corpus.checks.filter((c) => c.launchGate).length,
    phaseLabel: (n) => phases.find((p) => p.phase === n)?.label ?? `Phase ${n}`,
  };
}

/** Compare check ids numerically: 1.2 before 1.10. */
export function compareIds(a, b) {
  const [a1, a2] = a.split('.').map(Number);
  const [b1, b2] = b.split('.').map(Number);
  return a1 - b1 || a2 - b2 || a.localeCompare(b);
}
