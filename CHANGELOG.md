# Changelog

## 0.1.1

### Bug Fixes

- `SpeedTransportSocket`: an `error` handler that called `close()` while the connection was failing (refused, not answered in time, or answered by a server without raw TCP) made the socket dispatch `error` again, recursing until the stack overflowed. The socket now moves to `CLOSING` before it dispatches `error`, so the handler sees one `error` and then one `close`, as with WebSocket.

## 0.1.0

First release.

### Server

- `createSpeedTransportServer` serves raw TCP, WebSocket, and HTTP on one port, each with and without TLS, by reading the first bytes of every connection. `listen` binds a port; `handle` serves sockets accepted elsewhere.
- Raw TCP transport: the client sends `STCP/1\n`, the server echoes it, then both exchange RFC 6455 frames without masking.
- WebSocket per RFC 6455 without extensions or subprotocols. Passes the Autobahn conformance suite (301 cases).
- Messages above `maxBufferedMessageBytes` are counted from their headers without being copied, unmasked, or validated (`bulk` event).
- `Connection.sendMessages` streams one payload many times with a cached header and drain-based backpressure. `Connection.reset` ends a session with a TCP reset, also under TLS.
- `authorize`, per-client `limiter` and `clientKey`, `onTlsClientHello` (for ACME TLS-ALPN-01), and `setSecureContext` for certificate reloads.

### Speed test protocol

- `createSpeedTestServer` and `createSpeedTestProtocol` speak the CoverageMap speed test protocol (`PING`, `START <kb> <count>`, `ACK`, `CLOSE`) on every transport, with frame size and count limits and an `onEvent` hook for metrics.

### Cluster

- `createClusterPrimary` and `runClusterWorker` spread sessions across worker processes: the primary hands over unread sockets round robin, counts per-client limits across workers, distributes certificates and broadcasts, answers worker requests, and restarts workers that exit.

### Client

- `@coveragemap/speed-transport/client` exports `SpeedTransportSocket`, a raw TCP client with the WebSocket API and a `discard` mode that never copies large binary messages, and `probeTcpTransport` to check whether a server offers raw TCP.
