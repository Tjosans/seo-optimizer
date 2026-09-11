/**
 * Which HTTP version a host will speak, asked the way a browser asks.
 *
 * `fetch` in Node speaks HTTP/1.1 whatever the server offers, so no page the
 * crawl fetched says anything about HTTP/2. The version a browser gets is
 * settled before any request is sent, during the TLS handshake: the client
 * lists the protocols it speaks (ALPN), and the server picks one. So the
 * question is answered by making that handshake and nothing more — no request,
 * no bytes of content — which makes it the cheapest thing the crawl ever does
 * to a site. It is still made by the crawl loop and paced like every other
 * visit, for the reason `AuxiliaryFetch` gives.
 *
 * HTTP/3 is not asked here. It runs over QUIC, which a browser only tries after
 * an ordinary response has advertised it with `Alt-Svc`, and that header is
 * already on every page the crawl fetched.
 */

import { isIP } from 'node:net';
import { connect } from 'node:tls';

export interface ProtocolCheck {
  /** The origin the handshake was made with. */
  readonly origin: string;
  /**
   * What the server chose from `h2` and `http/1.1`, offered in that order as a
   * browser offers them. Null when the handshake completed and the server
   * chose nothing — a server without ALPN, which every client then speaks
   * HTTP/1.1 to.
   */
  readonly alpn: string | null;
  /** `TLSv1.3`, `TLSv1.2`, … as negotiated. Null when no handshake completed. */
  readonly tlsVersion: string | null;
  /** Set when no handshake completed. Never a verdict about the site. */
  readonly error: string | null;
}

export interface NegotiateOptions {
  readonly timeoutMs?: number;
  /**
   * Accept a certificate that does not validate. On by default here, and only
   * here: the question is which protocol the server picks, and a certificate
   * problem has already failed every page fetch, which is where it is
   * reported. Tests use it for their self-signed localhost certificate.
   */
  readonly rejectUnauthorized?: boolean;
}

/** Offered in a browser's order: HTTP/2 first, HTTP/1.1 as the fallback. */
const OFFER = ['h2', 'http/1.1'];

export function negotiateProtocol(
  url: string,
  options: NegotiateOptions = {},
): Promise<ProtocolCheck> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve({ origin: url, alpn: null, tlsVersion: null, error: 'not a URL' });
  }
  const origin = target.origin;
  if (target.protocol !== 'https:') {
    return Promise.resolve({ origin, alpn: null, tlsVersion: null, error: 'not an https URL' });
  }

  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port || 443);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Omit<ProtocolCheck, 'origin'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ origin, ...result });
    };

    const socket = connect({
      host,
      port,
      // SNI names a host; an address is not one, and sending it is an error.
      ...(isIP(host) === 0 ? { servername: host } : {}),
      ALPNProtocols: OFFER,
      rejectUnauthorized: options.rejectUnauthorized ?? false,
    });

    const timer = setTimeout(
      () => finish({ alpn: null, tlsVersion: null, error: 'handshake timed out' }),
      options.timeoutMs ?? 15_000,
    );

    socket.once('secureConnect', () => {
      const chosen = socket.alpnProtocol;
      finish({
        alpn: typeof chosen === 'string' && chosen !== '' ? chosen : null,
        tlsVersion: socket.getProtocol() ?? null,
        error: null,
      });
    });
    socket.once('error', (cause) =>
      finish({ alpn: null, tlsVersion: null, error: cause.message }),
    );
  });
}
