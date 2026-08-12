import { Router } from 'express';

export const healthRouter = Router();

/**
 * Unauthenticated on purpose — Railway's healthcheck has no session.
 * Returns nothing that is not already public.
 */
healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'flowspace-backend',
    uptimeSeconds: Math.round(process.uptime()),
  });
});
