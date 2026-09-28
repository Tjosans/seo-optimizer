// Line icons on a 24px grid, drawn with the current text colour.
import { s } from './dom.js';

const CIRCLE = 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18';

const PATHS = {
  home: ['M3 10.5 12 3l9 7.5', 'M5 9.5V21h14V9.5', 'M10 21v-6h4v6'],
  globe: [CIRCLE, 'M3 12h18', 'M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.4-4 9c-2.8-2.6-4-5.6-4-9s1.2-6.4 4-9'],
  audits: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14', 'm20 20-4-4'],
  results: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2', 'm8 12 3 3 5-6'],
  checks: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01'],
  compare: ['M8 3v14', 'm4 13 4 4 4-4', 'M16 21V7', 'm12 11 4-4 4 4'],
  settings: ['M4 6h9', 'M17 6h3', 'M4 12h3', 'M11 12h9', 'M4 18h11', 'M19 18h1', 'M15 4v4', 'M9 10v4', 'M17 16v4'],
  plus: ['M12 5v14', 'M5 12h14'],
  play: ['M7 4.5v15l12.5-7.5z'],
  external: ['M14 4h6v6', 'M20 4 11 13', 'M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5'],
  arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  stop: ['M7 7h10v10H7z'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'm13 7 4 4'],
  fail: [CIRCLE, 'M12 7.5v5.5', 'M12 16.2v.3'],
  warn: ['M12 3.5 2.5 20h19z', 'M12 10v4.5', 'M12 17.2v.3'],
  pass: [CIRCLE, 'm8 12 3 3 5-6'],
  clock: [CIRCLE, 'M12 7v5l3 2'],
  minus: [CIRCLE, 'M8 12h8'],
  help: [CIRCLE, 'M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.3', 'M12 16.5v.3'],
  dashed: [CIRCLE],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  shield: ['M12 3 4.5 6v6c0 4.6 3.1 7.7 7.5 9 4.4-1.3 7.5-4.4 7.5-9V6z'],
  person: ['M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8', 'M4 21c1-4 4.2-6 8-6s7 2 8 6'],
  info: [CIRCLE, 'M12 11v5.5', 'M12 7.8v.3'],
  database: ['M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3', 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
  logo: ['M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13', 'm20 20-4.8-4.8', 'm7.8 10.6 2 2 3.6-4'],
};

export function icon(name, size = 18, extra = {}) {
  const paths = PATHS[name] ?? PATHS.info;
  return s(
    'svg',
    {
      class: 'icon',
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      ...extra,
    },
    paths.map((d) => s('path', { d, ...(name === 'dashed' ? { 'stroke-dasharray': '3.2 3.2' } : {}) })),
  );
}
