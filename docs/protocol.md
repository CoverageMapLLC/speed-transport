# Wire Protocol

What a `SpeedTransportServer` accepts on its port, byte for byte, and what the speed test protocol on top of it sends.

---

## Table of Contents

- [Protocol detection](#protocol-detection)
- [Raw TCP](#raw-tcp)
- [WebSocket](#websocket)
- [Frames](#frames)
- [Messages and bulk messages](#messages-and-bulk-messages)
- [Closing](#closing)
- [Admission: authorize and limits](#admission-authorize-and-limits)
- [Speed test protocol](#speed-test-protocol)
- [Choosing a transport in a client](#choosing-a-transport-in-a-client)

---

## Protocol detection

The server reads from each new connection until the first bytes identify it:

| First bytes | Meaning | Then |
|---|---|---|
| `0x16` | TLS handshake record | The TLS layer completes the handshake, and detection runs again on the decrypted stream |
| `STCP/1\n` (7 bytes) | Raw TCP | A raw TCP session (see below) |
| `A` to `Z` | HTTP request | Node's HTTP parser: routes go to `requestListener`, `Upgrade: websocket` requests become WebSocket sessions |
| anything else | Unknown | The connection is destroyed |

Detection waits for more bytes while they are still a prefix of the preamble, so a preamble split across packets works. A connection that has not identified itself within `detectTimeoutMs` (10 s) is destroyed. TLS inside TLS is refused.

That gives six endpoints on one port:

| Transport | Without TLS | With TLS |
|---|---|---|
| Raw TCP | `tcp://host:port` | `tcps://host:port` |
| WebSocket | `ws://host:port/path` | `wss://host:port/path` |
| HTTP | `http://host:port/...` | `https://host:port/...` |

`plaintext: false` refuses everything without TLS (HTTP gets `400 TLS required`). `tcp: false` refuses raw TCP. `websocket: false` refuses upgrades, and `websocket: { path }` limits them to one path (others get `404`).

When the server is given `onTlsClientHello`, it sees the parsed SNI and ALPN of every ClientHello before the handshake and may take the socket over, which is how the CoverageMap server answers ACME TLS-ALPN-01 challenges on its public port.

## Raw TCP

```
client                                server
  | ---- TCP (+ TLS) handshake ------> |
  | ---- "STCP/1\n" -----------------> |
  |                                    |  authorize, limiter
  | <--- "STCP/1\n" ------------------ |
  | <=== frames, both directions ====> |
```

1. The client connects (and completes TLS for `tcps://`) and sends the 7 ASCII bytes `STCP/1\n` (`53 54 43 50 2F 31 0A`). It may send frames right behind the preamble.
2. The server admits the session (see [admission](#admission-authorize-and-limits)) and echoes the same 7 bytes. A refused session is closed without the echo.
3. From then on both sides send [frames](#frames). Neither side masks.

The echo tells a client that the server speaks raw TCP. A server that does not answers an HTTP error to what looks like a malformed request, or closes the connection, and a client should then use WebSocket. `probeTcpTransport` does exactly this check. Applications that can learn a server's transports some other way, as CoverageMap servers report theirs in a `protocols` field, do not need a separate check: connect over raw TCP and fall back to WebSocket if that first connection fails.

The `1` is the transport version. A future incompatible version would use a different preamble, which older servers refuse.

## WebSocket

Standard RFC 6455 over HTTP/1.1: `GET` with `Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-Version: 13`, and a 16 byte base64 `Sec-WebSocket-Key`. Errors are answered before the upgrade:

| Problem | Response |
|---|---|
| Path not accepted | `404` |
| Not `GET` | `405` |
| Missing or invalid key, missing `Connection: Upgrade` | `400` |
| Version other than 13 | `426` with `Sec-WebSocket-Version: 13` |
| `authorize` refused | its status, `403` by default |
| Limit reached | `429` |

Extensions (including `permessage-deflate`) and subprotocols are never negotiated: compression costs CPU on both sides and would distort throughput measurements, and a subprotocol the server does not echo makes browsers fail the handshake.

## Frames

Both transports use the frame layout of RFC 6455 section 5.2: FIN, RSV1 to 3, opcode, mask bit, 7/16/64 bit payload length, optional 4 byte mask key, payload. Opcodes are text `0x1`, binary `0x2`, continuation `0x0`, close `0x8`, ping `0x9`, and pong `0xA`.

| Rule | WebSocket | Raw TCP |
|---|---|---|
| Client frames masked | Required (`1002` otherwise) | Optional, normally not |
| Server frames masked | Never | Never |
| RSV bits | Must be 0 (`1002`) | Must be 0 (`1002`) |
| Unknown opcodes | `1002` | `1002` |
| Control frames | At most 125 bytes, never fragmented (`1002`) | Same |
| Fragmentation | Supported for data messages | Same |
| Text messages | Must be valid UTF-8 when buffered (`1007`) | Same |
| Ping | Answered with a pong carrying the same payload | Same |

The server cannot be told to mask, and never sends fragments.

## Messages and bulk messages

Each connection has two size limits:

- **`maxBufferedMessageBytes`** (64 KiB by default; 128 bytes for the speed test protocol). Messages up to this size are assembled, unmasked, validated, and delivered as a `message` event with the payload.
- **`maxMessageBytes`** (16 MiB by default; the CoverageMap servers use 10 MB). Larger messages fail the connection with `1009`.

A message between the two is a **bulk message**: the parser reads the frame headers and skips over the payload without copying, unmasking, or validating it, then emits `bulk` with the total length. This is the fast path for upload data. A text message delivered as bulk is not UTF-8 validated.

## Closing

| Who | How | Result |
|---|---|---|
| Peer sends close | The server echoes the code (RFC 6455 section 5.5.1), ends the socket, and destroys it after `closeTimeoutMs` (1 s) | `close` event with the peer's code and reason |
| `connection.close(code, reason)` | Close handshake, then destroy after `closeTimeoutMs` | |
| Protocol error | Close frame with the error code (`1002`, `1007`, `1009`), then as above | `close` event with that code |
| `connection.reset()` | TCP reset (RST), even under TLS. Everything still queued is dropped | `close` with `1006` |
| `connection.terminate()`, idle timeout, socket error | Socket destroyed | `close` with `1006` |

Close codes the peer sends must be valid (1000 to 1003, 1007 to 1014, 3000 to 4999), and a close reason must be valid UTF-8, or the connection fails with `1002`/`1007`.

The reset matters for speed tests: a graceful close lets the kernel deliver everything already queued, which on a slow link keeps it busy for seconds after the client is done.

## Admission: authorize and limits

Every session, on every transport, passes the same checks after its handshake or preamble and before it opens:

1. `authorize(context)`, if given. `context` has `kind` (`tcp` or `websocket`), `secure`, `remoteAddress`, and the upgrade `request` (null for raw TCP). `true` admits. `false` or `{ status, reason }` refuses (the status is used for WebSocket). A thrown error refuses with `500`.
2. The `limiter`, if given, under the key from `clientKey(context)` (the remote address by default). A refused acquire answers `429`; a limiter that throws answers `503`. The slot is released when the session closes.

Raw TCP sessions that are refused are closed without the preamble echo.

## Speed test protocol

`createSpeedTestServer` (or `createSpeedTestProtocol` as an `onConnection` handler) speaks the CoverageMap speed test protocol on every transport:

| Client sends | Server answers |
|---|---|
| Text `PING` | Text `PONG` |
| Text `START <kb> <count>` | `count` binary messages of `kb` × 1024 zero bytes |
| Any message over 128 bytes, text or binary | Text `ACK`, one per message |
| Text `CLOSE` | Connection reset |
| Anything else | Ignored |

- `START` arguments must be positive decimal integers within `maxFrameSizeKb` (10240) and `maxFrameCount` (1000), or the connection is closed with `1008`.
- Download messages reuse one zero buffer per size and a cached frame header. Sending pauses while more than `sendHighWaterBytes` (10 MiB by default) is queued on the socket and resumes on `drain`. Several `START`s on one socket are served at the same time; each frame is written whole, so their frames interleave but never split.
- Upload messages over 128 bytes are bulk messages: counted and acknowledged, never read.

## Choosing a transport in a client

| Client | Use |
|---|---|
| Browser | `wss://` (or `ws://` on pages served over HTTP) |
| Node.js | `tcps://` when the server is known to offer it (for CoverageMap servers, `TCPSv1` in `protocols`; otherwise `probeTcpTransport(host, port, { secure: true })`), else `wss://`. Fall back to `wss://` if the first raw TCP connection fails |
| Behind a corporate proxy or a CDN | `wss://`; proxies and CDNs only forward HTTP |

The raw TCP client, `SpeedTransportSocket`, has the WebSocket API, so the same code can drive either. With `binaryPayloads: 'discard'` it does not copy large binary messages: they arrive as a shared zero-filled `ArrayBuffer` of the right length, which is all a throughput test needs.
