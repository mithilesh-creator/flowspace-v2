import http from 'node:http';

import cors from 'cors';
import express from 'express';

import { env } from './config/env.js';
import { HttpError } from './lib/errors.js';
import { attachRealtime } from './realtime/index.js';
import { boardsRouter } from './routes/boards.js';
import { healthRouter } from './routes/health.js';
import {
  invitationRedemptionRouter,
  invitationsRouter,
} from './routes/invitations.js';
import { orgsRouter } from './routes/orgs.js';

const app = express();

// Railway terminates TLS in front of us; without this req.protocol and
// rate-limit keys see the proxy instead of the client.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  cors({
    origin: env.corsOrigins,
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Org-Id', 'X-Socket-Id'],
  })
);
app.use(express.json({ limit: '100kb' }));

app.use(healthRouter);

// Boards first. Both routers mount under /api/orgs, and a Router's
// .use() middleware runs for every path beneath its mount point — so the
// other order makes orgsRouter run requireAuth on board requests before
// failing to match and falling through, verifying the token twice.
app.use('/api/orgs/:orgId/boards', boardsRouter);
app.use('/api/orgs/:orgId/invitations', invitationsRouter);
app.use('/api/invitations', invitationRedemptionRouter);
app.use('/api/orgs', orgsRouter);

app.use((_req, _res, next) => {
  next(new HttpError(404, 'Not found'));
});

// eslint-disable-next-line no-unused-vars -- Express identifies the error
// handler by arity; dropping `next` silently turns it into normal
// middleware and every error becomes an unhandled rejection.
app.use((error, _req, res, next) => {
  const status = error instanceof HttpError ? error.status : 500;

  // Anything that is not a deliberate HttpError is a bug. Log it in full,
  // return nothing: internal messages can carry table names, constraint
  // names and query fragments.
  if (status >= 500) {
    console.error('[error]', error);
  }

  res.status(status).json({
    error: {
      message: status >= 500 ? 'Internal server error' : error.message,
      code: error.code ?? null,
    },
  });
});

const server = http.createServer(app);
attachRealtime(server);

server.listen(env.port, () => {
  console.log(
    `[flowspace] api + realtime listening on :${env.port} (${env.nodeEnv})`
  );
  console.log(`[flowspace] cors origins: ${env.corsOrigins.join(', ')}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[flowspace] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Railway sends SIGTERM on redeploy; do not let a hung socket hold
    // the old container open indefinitely.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
