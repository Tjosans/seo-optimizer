/**
 * The dashboard's entry point.
 *
 *     npm run dashboard
 *
 * Listens on PORT (default 3001) and proxies `/api/*` onto API_URL (default
 * http://localhost:3000, @seo/api's own default). Serves `public/` as-is —
 * no bundler, since the dashboard is plain HTML/CSS/JS with no framework
 * dependency to bundle.
 */

import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const apiUrl = (process.env['API_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');

const server = createServer({ apiUrl, publicDir });
const port = Number(process.env['PORT'] ?? 3001);
server.listen(port, () => {
  console.log(`@seo/dashboard listening on :${port}, proxying ${apiUrl}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
