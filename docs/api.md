# API

Two entry points:

- `@coveragemap/speed-transport`: servers, connections, the speed test protocol, the cluster, and the frame, handshake, and detection helpers.
- `@coveragemap/speed-transport/client`: the raw TCP client. It only loads `node:net` and `node:tls`, so applications that bundle it pull in no server code.

Everything is ESM and typed.

---

## Table of Contents

- [Servers](#servers)
  - [createSpeedTransportServer](#createspeedtransportserveroptions)
  - [SpeedTransportServer](#speedtransportserver)
  - [Server options](#server-options)
  - [Limits](#limits)
- [Connection](#connection)
- [Speed test protocol](#speed-test-protocol)
- [Limiting connections](#limiting-connections)
- [Cluster](#cluster)
- [Client](#client)
  - [SpeedTransportSocket](#speedtransportsocket)
  - [probeTcpTransport](#probetcptransporthost-port-options)
- [Low level helpers](#low-level-helpers)

---

## Servers

### `createSpeedTransportServer(options)`

Returns a [`SpeedTransportServer`](#speedtransportserver). `options.onConnection` receives a [`Connection`](#connection) for every session on every transport, after it was admitted. Attach listeners synchronously inside it: buffered bytes are parsed right after it returns.

```js
const server = createSpeedTransportServer({
  tls: { cert, key },
  onConnection(connection) {
    connection.on('message', (data, binary) => {});
  },
});
await server.listen(443);
```

### `SpeedTransportServer`

| Member | Description |
|---|---|
| `listen(port, host?)` | Binds a TCP listener and serves it. Resolves with the bound `AddressInfo`. |
| `handle(socket)` | Serves a socket accepted elsewhere (a cluster worker, a custom listener). Nothing may have been read from it. Paused sockets are fine. |
| `setSecureContext(options)` | Replaces the TLS certificate for new connections. Throws if the server was created without `tls`. |
| `close()` | Stops listening, terminates every session, and destroys connections still being detected. |
| `address()` | The listener's `AddressInfo`, or null. |
| `connectionCount` | Open sessions on every transport. |
| `limits` | The resolved [limits](#limits). |
| `httpServer` | The internal `http.Server`. HTTP requests are emitted into it; use it to read `requestListener` errors or add `upgrade` handling for other paths. |
| `tlsServer` | The internal `tls.Server`, or null without `tls`. |

### Server options

| Option | Default | Description |
|---|---|---|
| `onConnection(connection)` | required | Called for every admitted session. |
| `tls` | none | Node `TlsOptions`. When set, TLS connections are accepted and their decrypted stream is detected again, which gives `wss://` and `tcps://`. Pass `{}` to enable TLS and supply the certificate later with `setSecureContext`, as cluster workers do. `ALPNProtocols` defaults to `['http/1.1']`. |
| `plaintext` | `true` | Accept connections without TLS. `false` refuses them; HTTP gets `400 TLS required`. |
| `tcp` | `true` | Accept the raw TCP transport. |
| `websocket` | `true` | `false` refuses upgrades. `{ path: '/v1/ws' }` or `{ path: (pathname) => boolean }` limits them to some paths; others get `404`. |
| `requestListener(req, res)` | 404 for everything | Handles HTTP requests on the same port. An Express app works. |
| `authorize(context)` | admit all | Returns `true`, `false`, or `{ status, reason }`, or a promise of one. See [admission](./protocol.md#admission-authorize-and-limits). |
| `limiter` | none | A [`ConnectionLimiter`](#limiting-connections). |
| `clientKey(context)` | remote address | The key `limiter` counts under, for example the client IP from `X-Forwarded-For` behind a proxy. |
| `onTlsClientHello(hello, socket)` | none | Sees `{ servername, alpnProtocols }` of every ClientHello before the handshake. Returning `true` takes the socket over (the bytes read so far were pushed back onto it). |
| `limits` | see below | Partial [`ServerLimits`](#limits). |

`context` (a `SessionContext`) is `{ kind: 'tcp' | 'websocket', secure, remoteAddress, request }`, where `request` is the upgrade `IncomingMessage` for WebSocket and null for raw TCP.

### Limits

`DEFAULT_SERVER_LIMITS`:

| Limit | Default | Description |
|---|---|---|
| `maxMessageBytes` | 16 MiB | Larger messages close the connection with `1009`. |
| `maxBufferedMessageBytes` | 64 KiB | Larger messages are [bulk messages](./protocol.md#messages-and-bulk-messages): counted, never copied. |
| `idleTimeoutMs` | 60 000 | Sessions that receive nothing for this long are destroyed. `0` disables it. |
| `closeTimeoutMs` | 1 000 | How long a close handshake may take before the socket is destroyed. |
| `sendHighWaterBytes` | 10 MiB | `sendMessages` pauses while this much is queued. |
| `detectTimeoutMs` | 10 000 | Connections that do not identify their protocol in time are destroyed. |
| `maxHeaderBytes` | 16 KiB | Largest HTTP request head. |

## Connection

One session over raw TCP or WebSocket, plain or TLS. An `EventEmitter`.

| Event | Arguments | When |
|---|---|---|
| `message` | `data: Buffer, binary: boolean` | A message up to `maxBufferedMessageBytes`. Text is valid UTF-8. |
| `bulk` | `length: number, binary: boolean` | A larger message. Its payload was skipped. |
| `ping` | `payload: Buffer` | After the pong was sent. |
| `pong` | `payload: Buffer` | |
| `close` | `code: number, reason: string` | The session is gone. `1006` when it ended without a close handshake. Listeners are removed afterwards. |

| Member | Description |
|---|---|
| `kind` | `'tcp'` or `'websocket'` |
| `secure` | Whether the session runs over TLS. |
| `request` | The upgrade request for WebSocket, null for raw TCP. |
| `remoteAddress` | The socket's remote address. |
| `socket` | The underlying `net.Socket` or `tls.TLSSocket`. |
| `isOpen` | True until a close starts. |
| `bufferedAmount` | Bytes queued in the socket. |
| `sendText(text)`, `sendBinary(data)` | Send one message. Return `false` when the socket's buffer is full (like `socket.write`). |
| `sendFrame(frame)` | Write an already encoded frame, for example a precomputed reply from `encodeFrame`. |
| `sendMessages(payload, count)` | Send `payload` as `count` binary messages with one cached header, pausing on `drain` above `sendHighWaterBytes`. Resolves with the number queued. |
| `ping(payload?)` | Send a ping. |
| `close(code?, reason?)` | Start the close handshake. |
| `reset()` | End at once with a TCP reset, dropping everything queued. |
| `terminate()` | Destroy the socket. |

## Speed test protocol

The CoverageMap speed test protocol, described in [protocol](./protocol.md#speed-test-protocol).

| Export | Description |
|---|---|
| `createSpeedTestServer(options)` | `createSpeedTransportServer` with `onConnection` set to the protocol and `maxBufferedMessageBytes` set to 128. Takes every server option except `onConnection`, plus `speedTest`. |
| `createSpeedTestProtocol({ limits?, pool?, onEvent? })` | The `onConnection` handler on its own. |
| `DEFAULT_SPEED_TEST_LIMITS` | `{ maxFrameSizeKb: 10240, maxFrameCount: 1000 }` |
| `parseStartCommand(text)` | `{ sizeKb, count }` for a well formed `START <kb> <count>`, else null. |
| `ZeroBufferPool` | Zero buffers per size in KiB, shared by every connection that uses the pool. `get(sizeKb)`, `size`. |
| `COMMAND_MAX_BYTES` | 128. Messages above it are upload data. |

`onEvent` receives `{ type: 'start', connection, command }`, `{ type: 'upload', connection, bytes }`, and `{ type: 'rejected', connection, reason }`, for metrics.

## Limiting connections

```ts
interface ConnectionLimiter {
  acquire(key: string): boolean | Promise<boolean>;
  release(key: string): void;
}
```

`ConnectionCounter(maxPerKey)` is the in-process implementation, with `count(key)` and `total`. In a cluster, `context.limiter` counts across every worker in the primary.

## Cluster

| Export | Description |
|---|---|
| `createClusterPrimary(options)` | Runs worker processes and hands them connections. See [cluster](./cluster.md). |
| `runClusterWorker(setup, channel?, onStop?)` | The worker side. `setup(context)` returns the worker's server. |
| `resolveWorkerCount(configured, maxAuto = 6, cores?)` | `configured` when positive, else one per core up to `maxAuto`. |

## Client

From `@coveragemap/speed-transport/client`. Node.js only.

### `SpeedTransportSocket`

```ts
new SpeedTransportSocket(url: string, options?: SpeedTransportSocketOptions)
```

A raw TCP client with the WebSocket API. `url` is `tcp://host:port` or `tcps://host:port` with an explicit port (IPv6 hosts in brackets).

| Option | Default | Description |
|---|---|---|
| `rejectUnauthorized` | Node's default | Verify the server certificate. Node's default is true unless `NODE_TLS_REJECT_UNAUTHORIZED=0`, the same as its built-in WebSocket. |
| `ca` | system | Extra certificate authorities. |
| `servername` | URL host | TLS server name. Not sent for IP addresses. |
| `connectTimeoutMs` | 10 000 | Fail if the preamble has not been echoed by then. |
| `maxMessageBytes` | 64 MiB | Larger messages fail the connection with `1009`. |
| `binaryPayloads` | `'copy'` | `'discard'` does not copy binary messages above `bulkThresholdBytes`: they arrive as a zero-filled `ArrayBuffer` of the right length that is shared between messages. |
| `bulkThresholdBytes` | 64 KiB | Threshold for `'discard'`. |

It has `readyState` with the `CONNECTING`, `OPEN`, `CLOSING`, and `CLOSED` constants, `url`, `protocol` (`''`), `extensions` (`''`), `binaryType` (`'arraybuffer'` or `'nodebuffer'`), `bufferedAmount`, `send(string | ArrayBuffer | ArrayBufferView)`, `close(code?, reason?)`, and the `open`, `message`, `error`, and `close` events through both `addEventListener` and `on*` properties. `close` events are `SpeedTransportCloseEvent`s with `code`, `reason`, and `wasClean`.

Differences from WebSocket: there is no HTTP handshake, frames are not masked, and `send` before `open` throws like WebSocket does.

### `probeTcpTransport(host, port, options?)`

Resolves true when the server answers the raw TCP preamble, false otherwise (including timeouts, refused connections, and TLS errors). Options: `secure` (use TLS, default false), `timeoutMs` (3000), `rejectUnauthorized`, `servername`. The probe connection is closed before it resolves and does not hold a connection slot.

`parseTransportUrl(url)` returns `{ secure, host, port }`. `TCP_PREAMBLE` is also exported from the client.

## Low level helpers

For tests, tools, and custom transports.

| Export | Description |
|---|---|
| `FrameParser` | Incremental RFC 6455 frame parser with the bulk message fast path. `new FrameParser({ requireMask, maxMessageBytes, maxBufferedMessageBytes }, handler)`, then `push(chunk)`. The handler has `onMessage`, `onBulkMessage`, `onPing`, `onPong`, `onClose`, and `onError`. |
| `encodeFrame(opcode, payload?, fin?)` | A complete unmasked frame. |
| `encodeFrameHeader(opcode, length, fin?)` | Just the header. |
| `encodeMaskedFrame(opcode, payload, mask?)` | A masked frame, as WebSocket clients send. |
| `encodeClosePayload(code, reason?)` | A close frame payload. |
| `Opcode`, `CloseCode`, `isValidCloseCode(code)` | Constants and the close code check. |
| `detectProtocol(bytes, allowTls?)` | `'tls'`, `'tcp'`, `'http'`, `'unknown'`, or `'incomplete'`. |
| `parseClientHello(bytes)` | `{ servername, alpnProtocols }` from a ClientHello record, or null. |
| `TCP_PREAMBLE` | `Buffer` of `STCP/1\n`. |
| `computeAcceptKey(key)`, `validateUpgradeRequest(req)`, `buildUpgradeResponse(key)`, `buildHttpErrorResponse(status, reason, headers?)`, `WEBSOCKET_GUID` | The WebSocket handshake. |
| `resetSocket(socket)` | Reset a TCP connection, reaching through TLS to the TCP socket. |
| `DEFAULT_CONNECTION_LIMITS` | The connection part of the limits. |
