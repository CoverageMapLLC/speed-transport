# Cluster

One Node.js process encrypts, decrypts, and frames a few Gbps at most: on the benchmark machine about 6 Gbps of raw TLS per thread. The cluster spreads sessions across worker processes so a server can use every core, without any change to the VM, the kernel, or the network: it is plain Node.js `child_process` and IPC.

---

## How it works

```
                     ┌─────────────┐  init, certificate, broadcasts, stop
 clients ──► :443 ──►│   primary   │─────────────────────────────────────┐
                     │  listener,  │  unread socket (round robin)        ▼
                     │  limits     │────────────────────────────► ┌──────────┐
                     └─────────────┘◄──────────────────────────── │ worker n │
                            ▲          acquire/release, requests  └──────────┘
```

- **The primary** owns the listening socket. It accepts each connection with `pauseOnConnect`, so not a single byte is read, and passes the socket handle to the next ready worker over IPC. It never touches TLS or frames.
- **Each worker** runs a full `SpeedTransportServer` and serves the socket with `server.handle(socket)`: protocol detection, TLS, HTTP routes, WebSocket, and raw TCP all happen in the worker.
- **Per-client limits** are counted in the primary. A worker's `context.limiter` asks the primary for a slot on every session and returns it when the session ends. If a worker dies, the primary releases every slot it held.
- **Certificates** are sent to every worker at start and whenever `setSecureContext` is called, and to workers that start later.
- **Workers that exit** are restarted after `restartDelayMs` (1 s).

## Primary

```js
import { createClusterPrimary, resolveWorkerCount } from '@coveragemap/speed-transport';

const primary = createClusterPrimary({
  workers: resolveWorkerCount(0),            // one per core, up to 6
  workerModule: new URL('./worker.js', import.meta.url),
  port: 443,
  host: '0.0.0.0',
  maxConnectionsPerClient: 32,
  secureContext: { cert, key, minVersion: 'TLSv1.2' },
  workerData: { config },                    // any serializable value
  onRequest: async (message) => {            // answers context.request in workers
    if (message.type === 'status') return getStatus();
    throw new Error('Unknown request');
  },
  logger: console,
});

const address = await primary.start();       // resolves once every worker is ready
primary.setSecureContext({ cert: newCert, key: newKey });
primary.broadcast({ type: 'reload' });       // to every worker's onBroadcast
await primary.stop();
```

| Option | Default | Description |
|---|---|---|
| `workers` | required | Worker processes, at least 1. |
| `workerModule` | required | File or URL each worker runs. It must call `runClusterWorker`. |
| `port`, `host` | required, all interfaces | Where the primary listens. |
| `maxConnectionsPerClient` | unlimited | Sessions per client key across all workers. |
| `secureContext` | none | `cert`, `key`, `ca`, `passphrase`, `ciphers`, `minVersion`, `maxVersion` as strings, since they cross IPC. |
| `workerData` | null | Passed to every worker's `setup`. |
| `onRequest(message)` | none | Answers `context.request`. May be async. A thrown error rejects the worker's promise with its message. |
| `logger` | silent | `info`, `warn`, and `error`. |
| `restartDelayMs` | 1 000 | Delay before replacing a worker that exited. |
| `stopTimeoutMs` | 5 000 | Workers still running this long after `stop` are killed. |
| `spawnWorker` | fork `workerModule` | Starts one worker; tests use it to run workers in process. |

The returned `ClusterPrimary` has `start()`, `stop()`, `broadcast(message)`, `setSecureContext(options)`, `address()`, and `readyWorkers`.

## Worker

```js
import { createSpeedTestServer, runClusterWorker } from '@coveragemap/speed-transport';

runClusterWorker((context) =>
  createSpeedTestServer({
    tls: {},                       // TLS on; the primary supplies the certificate
    limiter: context.limiter,      // counts in the primary
    websocket: { path: '/v1/ws' },
    requestListener: app,
  })
);
```

`setup(context)` may return the server or a promise of it. `context` has:

| Member | Description |
|---|---|
| `workerData` | The primary's `workerData`. |
| `limiter` | A `ConnectionLimiter` backed by the primary's counts. |
| `request(message, timeoutMs = 10000)` | Sends `message` to the primary's `onRequest` and resolves with its answer. Use it for state only the primary has, like a status that must be computed once. |
| `onBroadcast(listener)` | Receives `primary.broadcast` messages. |

Workers ignore `SIGINT` and `SIGTERM` (the terminal sends them to the whole process group, and the primary coordinates the shutdown) and exit when the IPC channel closes, so they never outlive the primary.

## IPC messages

All messages are prefixed `speed-transport:`, so an application can share the IPC channel with its own messages. Primary to worker: `init`, `secure-context`, `connection` (with the socket handle), `acquired`, `broadcast`, `reply`, and `stop`. Worker to primary: `ready`, `acquire`, `release`, and `request`. The types are exported as `PrimaryToWorkerMessage` and `WorkerToPrimaryMessage`.

## How many workers

Each worker is a full Node.js process (about 70 MB idle on Windows). On the benchmark machine:

| Link | Workers (vCPU) |
|---|---|
| Up to 1 Gbps | 1 to 2 |
| 2.5 to 5 Gbps | 4 |
| 10 Gbps | 6 to 8, on dedicated cores |

Upload over TLS is the most expensive direction, because every byte is decrypted. Raw TCP and WebSocket without TLS need half or less of the CPU per Gbps of their TLS versions. See [benchmarks](./benchmarks.md).
