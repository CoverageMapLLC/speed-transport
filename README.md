# @coveragemap/speed-transport

Raw TCP, WebSocket, and secure WebSocket on one port, built for moving bytes with as little CPU as possible. It powers the CoverageMap speed test servers and the raw TCP transport of [`@coveragemap/speed-test`](https://github.com/CoverageMapLLC/coveragemap-speed-test).

```
tcp://host:port        raw TCP
tcps://host:port       raw TCP over TLS
ws://host:port/v1/ws   WebSocket
wss://host:port/v1/ws  secure WebSocket
https://host:port/...  your HTTP routes
```

All of them share one listening port. The server reads the first bytes of each connection to decide what it is. A TLS ClientHello is decrypted and looked at again, the 7 byte preamble `STCP/1\n` starts a raw TCP session, and anything else is HTTP. No VM, kernel, or proxy changes are needed: deploying the app is enough.

## Why

A speed test server mostly receives bytes it ignores and sends zeros. General purpose WebSocket servers unmask, copy, and buffer every upload byte and build an object per message, so at multi-gigabit speeds they spend most of their CPU on work the test throws away. This library:

- **Counts upload messages without reading them.** Messages above a threshold (64 KiB by default, 128 bytes in the speed test server) are never unmasked, copied, or buffered: the parser reads the frame header and skips the payload.
- **Sends from shared buffers.** Download frames reuse one zero buffer and a cached header, written with `cork`/`uncork`, and pause on the socket's `drain` event.
- **Offers raw TCP.** The same frames without masking or an HTTP handshake. A Node.js client then never masks uploads and never copies downloads either.
- **Spreads across cores.** A primary process accepts connections without reading them and hands each one to a worker process, with per-client connection limits, certificate updates, and broadcasts shared across workers.

On loopback one worker process serves 26 Gbps of raw TCP download, and upload needs 10 to 30% less server CPU per Gbps than the `ws` server it replaced, with raw TCP needing a quarter of the client CPU. Secure WebSocket download is bound by TLS and costs the same. See [benchmarks](./docs/benchmarks.md) for the numbers and why they matter.

It has no runtime dependencies and needs Node.js 20 or later. It passes the [Autobahn](https://github.com/crossbario/autobahn-testsuite) WebSocket conformance suite (301 cases; compression is never negotiated, so 12.* and 13.* do not apply).

## Install

```bash
npm install @coveragemap/speed-transport
```

## Quick start

### A speed test server

```js
import { createSpeedTestServer } from '@coveragemap/speed-transport';
import { readFileSync } from 'node:fs';

const server = createSpeedTestServer({
  tls: { cert: readFileSync('cert.pem'), key: readFileSync('key.pem') },
  websocket: { path: '/v1/ws' },
  requestListener: (req, res) => res.end('ok'), // or an Express app
});

await server.listen(443);
```

This answers the CoverageMap speed test protocol on all four transports: `PING` → `PONG`, `START <kb> <count>` → `count` zero frames, an `ACK` for every upload message over 128 bytes, and `CLOSE` → connection reset.

### Your own protocol

```js
import { createSpeedTransportServer } from '@coveragemap/speed-transport';

const server = createSpeedTransportServer({
  onConnection(connection) {
    connection.on('message', (data, binary) => {
      if (!binary && data.toString() === 'hello') connection.sendText('world');
    });
    connection.on('bulk', (length) => {
      // A large message, counted but never copied.
    });
  },
});

await server.listen(8080);
```

### A raw TCP client

```js
import { SpeedTransportSocket, probeTcpTransport } from '@coveragemap/speed-transport/client';

if (await probeTcpTransport('speed.example.com', 443, { secure: true })) {
  const socket = new SpeedTransportSocket('tcps://speed.example.com:443', { binaryPayloads: 'discard' });
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => socket.send('PING');
  socket.onmessage = (event) => console.log(event.data); // 'PONG'
}
```

`SpeedTransportSocket` has the WebSocket API (`send`, `close`, `readyState`, `bufferedAmount`, `binaryType`, `on*` handlers, and `EventTarget`), so code written for WebSocket runs on it unchanged.

### Several processes

```js
// primary.js
import { createClusterPrimary } from '@coveragemap/speed-transport';

const primary = createClusterPrimary({
  workers: 4,
  workerModule: new URL('./worker.js', import.meta.url),
  port: 443,
  maxConnectionsPerClient: 32,
  secureContext: { cert, key },
});
await primary.start();

// worker.js
import { createSpeedTestServer, runClusterWorker } from '@coveragemap/speed-transport';

runClusterWorker((context) =>
  createSpeedTestServer({ tls: {}, limiter: context.limiter, websocket: { path: '/v1/ws' } })
);
```

See [cluster](./docs/cluster.md).

## Documentation

| Document | Contents |
|---|---|
| [Wire protocol](./docs/protocol.md) | Protocol detection, the raw TCP transport, framing rules, close behavior, and the speed test commands |
| [API](./docs/api.md) | Every export of `@coveragemap/speed-transport` and `@coveragemap/speed-transport/client` |
| [Cluster](./docs/cluster.md) | The primary and worker processes, limits across workers, certificates, and IPC |
| [Benchmarks](./docs/benchmarks.md) | Throughput and CPU against `ws`, on every transport, and why it matters |

## Cloudflare Workers and browsers

Browsers can only open WebSocket connections, and Cloudflare Workers only accept HTTP. Both keep working against this server over `wss://`, and clients choose raw TCP only where it exists: the CoverageMap client library probes for it in Node.js and falls back to WebSocket otherwise. Behind a reverse proxy, pass `tcp: false` (a proxy only forwards HTTP) and `tls: null`.

## Development

```bash
npm install
npm run lint            # ESLint
npm run typecheck       # TypeScript, no emit
npm test                # Vitest: unit, integration, robustness, and cluster tests
npm run test:coverage   # The same with coverage thresholds
npm run autobahn        # Autobahn conformance suite in Docker
npm run bench           # Loopback benchmark against the ws baseline
```

The tests run real servers and clients over loopback: every transport, TLS, the cluster with real processes, malformed and hostile input, backpressure, and limits. CI runs them on Linux, Windows, and macOS with Node.js 20, 22, and 24, plus coverage, Autobahn, and a packaging check.

Releases are published to npm from the `main` branch by the manual **Publish Package to npm** workflow, with provenance, through npm trusted publishing (the package's trusted publisher must name this repository, `publish-npm.yml`, and the `Production` environment). Bump `version` and the [changelog](./CHANGELOG.md) first.

## License

Apache-2.0
