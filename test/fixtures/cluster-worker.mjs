// Real worker process for the multi-process cluster tests.
import { createSpeedTestServer, runClusterWorker } from '../../dist/index.js';

runClusterWorker((context) => {
  context.onBroadcast((message) => {
    if (message?.type === 'crash' && message.pid === process.pid) process.exit(3);
  });
  return createSpeedTestServer({
    tls: {},
    limiter: context.workerData?.limited ? context.limiter : undefined,
    requestListener: async (req, res) => {
      if (req.url === '/pid') {
        res.end(String(process.pid));
      } else if (req.url === '/ask') {
        res.end(JSON.stringify(await context.request({ from: process.pid })));
      } else {
        res.statusCode = 404;
        res.end();
      }
    },
  });
});
