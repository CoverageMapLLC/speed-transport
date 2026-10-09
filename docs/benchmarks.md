# Benchmarks

How much throughput this library delivers per CPU core, on every transport, against the `ws` based server the CoverageMap speed test servers ran before it, and why that matters.

---

## Table of Contents

- [Summary](#summary)
- [Why it matters](#why-it-matters)
- [Setup](#setup)
- [Upload](#upload)
- [Download](#download)
- [End to end with the client library](#end-to-end-with-the-client-library)
- [Where the time goes](#where-the-time-goes)
- [Reproducing](#reproducing)

---

## Summary

| | Before (`ws`) | After (this library) |
|---|---|---|
| Upload, 1 worker, best transport | 6.75 Gbps (ws) | 9.66 Gbps (tcp), **+43%** |
| Upload, 4 workers, best transport | 12.84 Gbps (ws) | 19.67 Gbps (tcp), **+53%** |
| Upload, 4 workers, secure WebSocket | 10.79 Gbps at 39.3% CPU/Gbps | 11.65 Gbps at 35.6% CPU/Gbps |
| Upload, 4 workers, client CPU | 347% for 12.84 Gbps (ws) | 94% for 19.67 Gbps (tcp), **5.6x less per Gbps** |
| Download, 1 worker, best transport | 15.90 Gbps (ws) | 26.00 Gbps (tcp), **+64%** |
| Download, server CPU per Gbps, plain | 2.7% (ws) | 1.5% (tcp), 2.0% (ws) |
| Download, secure WebSocket | 8.56 Gbps (1 worker) | 8.73 Gbps (1 worker), same |
| Full speed test over TLS, client library | 4.41 / 3.40 Gbps | 16.75 / 14.83 Gbps |

Upload, where the server must read every byte, improves on every transport. Download over secure WebSocket is bound by TLS encryption, which costs the same in both. Raw TCP gives the largest gains, mostly on the client.

## Why it matters

**A speed test must measure the network, not the CPU.** When the client or the server runs out of CPU, the result is the speed of a processor, and a 10 Gbps customer is told they have 5. Every cycle spent per byte lowers the speed a given machine can measure. Before this library, a single server process topped out at 3.4 Gbps of TLS upload; the client library over WebSocket topped out near 5 Gbps per thread.

**Clients are often the weaker side.** Phones, laptops, and small routers run the CoverageMap client. Over WebSocket a client masks every upload byte (RFC 6455 requires it) and copies every download frame. Raw TCP removes both: in the upload benchmark the client needs 94% CPU for 19.67 Gbps instead of 347% for 12.84 Gbps over `ws`, which leaves headroom for the network on machines that have little to spare.

**Servers cost money per core.** The CoverageMap fleet mostly runs 2 to 4 vCPU servers. Server CPU per Gbps decides how many cores a server needs to saturate its port: at 4 workers, `ws` used 33% CPU per Gbps of plain upload and this library 26% (21% over raw TCP). At 10 Gbps that saves about 0.7 of a core over WebSocket and 1.2 cores over raw TCP, on every server.

**One port, no infrastructure changes.** Raw TCP, WebSocket, and secure WebSocket share the existing port, detected from the first bytes. Old clients keep using WebSocket, new clients use raw TCP where the server offers it, and servers only need a normal deploy.

## Setup

- **Machine**: Intel Core i7-14700K (8 performance and 12 efficiency cores), Windows Server 2022, Node.js 22.21.1. Client and server share the machine and talk over loopback, so neither has the whole CPU.
- **Server**: `bench/server.mjs`. *speed-transport* is this library's clustered `createSpeedTestServer` with every default, all four transports on one port. *ws* is the baseline the CoverageMap servers ran: `ws` 8 with `bufferutil`, Node's cluster module, `bufferedAmount` polled every millisecond against a 10 MB limit, one plain and one TLS port.
- **Client**: `bench/client.mjs`, 6 worker threads with 2 sockets each, driven like the client library's throughput lanes: download sockets keep two `START 1024 500` requests outstanding; upload sockets keep two 1 MiB messages queued and at most 64 unacknowledged. WebSocket uses Node's built-in `WebSocket`; raw TCP uses `SpeedTransportSocket` with `binaryPayloads: 'discard'`. The client is the same for both servers.
- **Measurement**: sockets warm up for 1.5 s, then bytes and the CPU time of the client and of every server process are sampled over 6 s. Each row is the median of 3 runs. CPU is percent of one core; *CPU/Gbps* is server CPU divided by throughput.
- **Noise**: the hybrid CPU makes runs vary by up to 10%. Differences smaller than that are not meaningful.

## Upload

The client sends, the server reads, counts, and acknowledges. The server does the most work per byte in this direction.

| Workers | Transport | Server | Gbps | Server CPU | CPU/Gbps | Client CPU |
|---|---|---|---|---|---|---|
| 1 | ws | ws | 6.75 | 119% | 17.6% | 123% |
| 1 | ws | speed-transport | **8.46** | 105% | **12.4%** | 156% |
| 1 | tcp | speed-transport | **9.66** | 103% | **10.7%** | **30%** |
| 1 | wss | ws | 5.44 | 113% | 20.8% | 121% |
| 1 | wss | speed-transport | 5.30 | 103% | 19.4% | 110% |
| 1 | tcps | speed-transport | 5.36 | 102% | 19.0% | **57%** |
| 2 | ws | ws | 10.37 | 214% | 20.6% | 207% |
| 2 | ws | speed-transport | **12.16** | 205% | **16.9%** | 254% |
| 2 | tcp | speed-transport | **14.74** | 206% | **14.0%** | **52%** |
| 2 | wss | ws | 8.11 | 213% | 26.3% | 196% |
| 2 | wss | speed-transport | **8.83** | 205% | **23.2%** | 210% |
| 2 | tcps | speed-transport | **9.15** | 205% | **22.4%** | **116%** |
| 4 | ws | ws | 12.84 | 424% | 33.0% | 347% |
| 4 | ws | speed-transport | **15.58** | 409% | **26.3%** | 401% |
| 4 | tcp | speed-transport | **19.67** | 415% | **21.1%** | **94%** |
| 4 | wss | ws | 10.79 | 424% | 39.3% | 338% |
| 4 | wss | speed-transport | **11.65** | 415% | **35.6%** | 375% |
| 4 | tcps | speed-transport | **12.89** | 412% | **32.0%** | **222%** |

- Upload messages are counted from their frame headers and never unmasked, copied, or buffered, so the server's cost per byte falls by 15 to 30% on every plaintext transport. `ws` unmasks every byte (natively, with `bufferutil`) and allocates a buffer per message.
- Over TLS, decryption dominates and both servers sit near 100% CPU per worker; the savings show from 2 workers up.
- Raw TCP's biggest win is on the client: no masking means a quarter of the client CPU of WebSocket at a higher speed.

## Download

The server sends zero filled 1 MiB messages, the client counts them.

| Workers | Transport | Server | Gbps | Server CPU | CPU/Gbps | Client CPU |
|---|---|---|---|---|---|---|
| 1 | ws | ws | 15.90 | 43% | 2.7% | 647% |
| 1 | ws | speed-transport | 15.93 | 32% | **2.0%** | 647% |
| 1 | tcp | speed-transport | **26.00** | 40% | **1.5%** | 592% |
| 1 | wss | ws | 8.56 | 100% | 11.7% | 238% |
| 1 | wss | speed-transport | 8.73 | 100% | 11.5% | 248% |
| 1 | tcps | speed-transport | **10.25** | 100% | **9.8%** | 158% |
| 2 | ws | ws | 15.56 | 46% | 3.0% | 646% |
| 2 | ws | speed-transport | 15.79 | 34% | **2.2%** | 650% |
| 2 | tcp | speed-transport | **26.57** | 50% | **1.9%** | 594% |
| 2 | wss | ws | 11.57 | 197% | 17.0% | 602% |
| 2 | wss | speed-transport | 11.37 | 196% | 17.2% | 604% |
| 2 | tcps | speed-transport | **14.39** | 201% | **14.0%** | 322% |
| 4 | ws | ws | 15.34 | 53% | 3.5% | 641% |
| 4 | ws | speed-transport | 15.38 | 40% | **2.6%** | 645% |
| 4 | tcp | speed-transport | **25.62** | 58% | **2.3%** | 589% |
| 4 | wss | ws | 11.06 | 215% | 19.4% | 618% |
| 4 | wss | speed-transport | 11.16 | 210% | 18.8% | 620% |
| 4 | tcps | speed-transport | **15.94** | 288% | 18.1% | 567% |

- Plain WebSocket download is limited by the client (about 650% CPU receiving and copying frames), so both servers deliver the same speed; this library does it with 25% less server CPU.
- Raw TCP lifts that client limit: the client counts frames without copying them, and plain download reaches 26 Gbps.
- Secure WebSocket download is limited by TLS encryption on the server, which is identical for both. Raw TCP over TLS is faster because the client, freed from WebSocket's per-frame copy, keeps the server's TLS pipeline full.
- The send queue limit (`sendHighWaterBytes`) matters here: at 4 MiB, one worker served 7.88 Gbps of secure WebSocket; at the 10 MiB default it serves 8.73.

## End to end with the client library

The full CoverageMap speed test (latency, estimation, 10 second download and upload stages) with `@coveragemap/speed-test` against `@coveragemap/speed-test-server` with 6 workers over TLS, from that server's [performance timeline](https://github.com/CoverageMapLLC/coveragemap-speed-test-server/blob/main/docs/performance/timeline.md):

| | Download | Upload |
|---|---|---|
| Original server and client | 4.41 Gbps | 3.40 Gbps |
| Multi-process `ws` server, multi-threaded client | 11.25 Gbps | 10.73 Gbps |
| Server on this library, client on WebSocket | 11.53 Gbps | 13.85 Gbps |
| Server on this library, client on raw TCP | **16.75 Gbps** | **14.83 Gbps** |

On the production CoverageMap server (`speed-testing/node`) the same test went from 8.86 / 3.72 Gbps (single process `ws`) to 16.82 / 15.22 Gbps.

## Where the time goes

- **TLS** dominates every secure transport. On this machine one Node.js thread encrypts or decrypts about 6.4 Gbps; profiles of the secure WebSocket server show the frame parser at about 0.2% of the time. Use more workers, not a faster parser, for more TLS throughput.
- **Plain upload** is bound by reading from the socket: the parser touches only frame headers.
- **Loopback** shares one CPU between client and server, so no number here is the ceiling of a dedicated machine.

## Reproducing

```bash
npm run bench                              # every transport, 1/2/4 workers, 3 runs
npm run bench -- --quick                   # 1 worker, 1 run, 3 seconds
npm run bench -- --transports tcp,wss --workers 2 --directions up --json results.json
BENCH_SEND_HIGH_WATER=16777216 npm run bench -- --transports wss --directions down
```

Results vary with the CPU, the operating system, and what else is running. Compare implementations within one run.
