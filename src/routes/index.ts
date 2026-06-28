import { Router } from 'express';
import type { RequestHandler } from 'express';
import { readFileSync } from 'fs';
import path from 'path';

import billingRouter from './billing.js';
import healthRouter from './health.js';
import { createApisRouter, type ApisRouterDeps } from './apis.js';
import { createUsageRouter, type UsageRouterDeps } from './usage.js';
import { createLimitsRouter } from './limits.js';
import { InMemoryRestRateLimiter } from '../middleware/restRateLimit.js';

const openApiPath = path.join(process.cwd(), 'docs/openapi.json');
const openApiSpec = JSON.parse(readFileSync(openApiPath, 'utf8'));

export interface ApiRouterDeps extends Partial<UsageRouterDeps>, Partial<ApisRouterDeps> {
  restRateLimit?: RequestHandler;
  restRateLimiter?: InMemoryRestRateLimiter;
}

export function createApiRouter(deps: ApiRouterDeps = {}): Router {
  const router = Router();

  router.use('/health', healthRouter);
  
  router.use('/apis', createApisRouter({
    apiRepository: deps.apiRepository,
    developerRepository: deps.developerRepository
  }));

  router.use('/usage', createUsageRouter({
    usageEventsRepository: deps.usageEventsRepository!
  }));

  if (deps.restRateLimit) {
    router.use('/billing', deps.restRateLimit, billingRouter);
  } else {
    router.use('/billing', billingRouter);
  }

  if (deps.restRateLimiter) {
    router.use('/limits', createLimitsRouter(deps.restRateLimiter).router);
  }

  // Serve OpenAPI 3.1 JSON contract
  router.get('/openapi.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(openApiSpec);
  });

  return router;
}

export default createApiRouter;
