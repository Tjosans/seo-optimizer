/**
 * TLS servers on localhost.
 *
 * `startTlsServer` speaks whichever protocols a test says, for the handshake
 * the crawler makes to learn a host's HTTP version. It only completes the
 * handshake — nothing there answers a request — because the question is
 * settled before any request is sent. `startHttpsServer` does answer, for the
 * fetches whose behaviour depends on the transport being TLS.
 *
 * The certificate is self-signed for `localhost` and 127.0.0.1, good for a
 * hundred years, and guards nothing: it exists only so a test can finish a TLS
 * handshake without a network. Never trust it anywhere else.
 */

import type { RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { createServer } from 'node:tls';
import type { TLSSocket } from 'node:tls';

const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgWBNMYFjr0YYevmJx
LUGWLC2BpLnGSD4nJZQ3aIWranOhRANCAAR5dwk2lYXTzkPIDd16ExZrFuoVKAm6
6BMvUE5plF/GOT0X/ZugppMz+25s0x60G1AD98zXMmyf/JUn/MYET02q
-----END PRIVATE KEY-----
`;

const CERT = `-----BEGIN CERTIFICATE-----
MIIBmjCCAUGgAwIBAgIUHFJ+PKpYTMvXt8KI1ARS+dk0CB4wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkxMTE4MTEwN1oYDzIxMjYwODE4
MTgxMTA3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAR5dwk2lYXTzkPIDd16ExZrFuoVKAm66BMvUE5plF/GOT0X/ZugppMz
+25s0x60G1AD98zXMmyf/JUn/MYET02qo28wbTAdBgNVHQ4EFgQUuhRUyYNnPAFF
zDmLeXkDl2q3iIYwHwYDVR0jBBgwFoAUuhRUyYNnPAFFzDmLeXkDl2q3iIYwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDRwAwRAIgSdX2VmjupmZI19vXCanlQ5bw98EEJV4gtCSlFmz81R4CICRQ
c8tVVp9bcKknckLpnMTItHkZmOIBixcvBBrXD/D6
-----END CERTIFICATE-----
`;

export interface TlsServer {
  /** `https://127.0.0.1:<port>`. */
  readonly origin: string;
  readonly close: () => Promise<void>;
}

/**
 * An HTTPS server on localhost that answers with `listener`.
 *
 * For what only happens over TLS: records arrive at most 16 KB at a time and
 * the end of the stream is delivered with the last of them, which is the
 * timing a plain-HTTP server on loopback never reproduces. The certificate is
 * the same self-signed one, so a client has to be told not to verify it.
 */
export async function startHttpsServer(listener: RequestListener): Promise<TlsServer> {
  const sockets = new Set<Socket>();
  const server = createHttpsServer({ key: KEY, cert: CERT }, listener);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `https://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * Start a server offering `protocols` over ALPN, or no ALPN at all when the
 * list is empty — the shape of a server old enough to predate HTTP/2.
 */
export async function startTlsServer(protocols: readonly string[]): Promise<TlsServer> {
  const sockets = new Set<TLSSocket>();
  const server = createServer({
    key: KEY,
    cert: CERT,
    ...(protocols.length > 0 ? { ALPNProtocols: [...protocols] } : {}),
  });
  server.on('secureConnection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `https://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
