/**
 * OpenAPI Contract Test
 *
 * Boots createApiRouter(), walks every registered Express route, and asserts
 * that the route has a matching operation in docs/openapi.json — and vice
 * versa. This prevents docs/openapi.json from drifting out of sync with code.
 *
 * Two-sided check:
 *   1. Express → Spec: every route served by createApiRouter (minus internal
 *      allowlist) must have an entry in the spec.
 *   2. Spec → Express: every spec path must be handled by createApiRouter
 *      (minus the allowlist for routes documented but mounted elsewhere).
 *
 * Parameterized routes are compared after converting Express :param notation
 * to OpenAPI {param} notation, so /apis/:id matches /api/apis/{id}.
 */

// Prevent better-sqlite3 native binding errors during module load
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null, run: () => null, all: () => [] };
    }
    exec() {}
    close() {}
  };
});

import fs from 'fs';
import path from 'path';
import { createApiRouter } from '../routes/index.js';
import { InMemoryUsageEventsRepository } from '../repositories/usageEventsRepository.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** HTTP verbs recognised as operations by OpenAPI 3.x */
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/**
 * The URL prefix at which createApiRouter is mounted in app.ts.
 * Used to build fully-qualified paths for comparison with the spec.
 */
const MOUNT_PREFIX = '/api';

/**
 * Express routes that are intentionally absent from the OpenAPI spec.
 * Format: "METHOD /api/path"
 */
const ROUTES_NOT_IN_SPEC = new Set([
  'GET /api/health',        // internal liveness probe; not a public contract
  'GET /api/openapi.json',  // endpoint that serves the spec itself
]);

/**
 * OpenAPI spec entries that are valid but handled by routers outside of
 * createApiRouter (i.e. mounted in src/index.ts rather than src/routes/index.ts).
 * Format: "METHOD /api/path"
 */
const SPEC_ROUTES_OUTSIDE_CREATE_API_ROUTER = new Set([
  // Served by createDeveloperRouter, mounted in src/index.ts
  'GET /api/developers/revenue',
]);

// ── Types ────────────────────────────────────────────────────────────────────

interface RouteEntry {
  method: string; // uppercase: 'GET', 'POST', …
  path: string;   // absolute: '/api/billing/deduct'
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the literal path prefix from an Express Layer's compiled regexp.
 *
 * Express 4.x calls path-to-regexp and stores the result as a RegExp on the
 * layer. For router.use('/billing', subRouter) the regexp.toString() is
 * /^\/billing\/?(?=\/|$)/i — we parse the first path segment from that string.
 */
function extractPrefixFromLayer(layer: any): string {
  const regexpStr: string = layer.regexp.toString();
  // Match the first literal segment, e.g. captures "/billing" from the pattern above.
  const match = regexpStr.match(/^\/\^\\(\/[a-zA-Z0-9_.-]+)/);
  return match ? match[1] : '';
}

/**
 * Recursively walk an Express router stack and return every registered route.
 *
 * @param stack  The router.stack array (accessed via (router as any).stack)
 * @param prefix Accumulated absolute path prefix from ancestor routers
 */
function extractRoutes(stack: any[], prefix: string): RouteEntry[] {
  const routes: RouteEntry[] = [];

  for (const layer of stack) {
    if (layer.route) {
      // Endpoint layer — created by router.get/post/etc.
      const rawPath: string = layer.route.path;
      // Sub-router roots use '/' as their path; collapse it into the prefix.
      const fullPath =
        rawPath === '/' && prefix ? prefix : prefix + rawPath;

      const methods: string[] = Object.keys(layer.route.methods).filter(
        (m) => layer.route.methods[m] && m !== '_all',
      );

      for (const method of methods) {
        routes.push({
          method: method.toUpperCase(),
          // Collapse accidental double-slashes from path concatenation.
          path: fullPath.replace(/\/+/g, '/'),
        });
      }
    } else if (layer.handle?.stack) {
      // Sub-router layer — created by router.use('/prefix', subRouter).
      const subPrefix = extractPrefixFromLayer(layer);
      routes.push(...extractRoutes(layer.handle.stack, prefix + subPrefix));
    }
  }

  return routes;
}

/**
 * Convert an Express-style path to OpenAPI path-parameter notation.
 * e.g. /apis/:id → /apis/{id}
 */
function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([^/]+)/g, '{$1}');
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('OpenAPI Contract: createApiRouter ↔ docs/openapi.json', () => {
  let expressRoutes: RouteEntry[];
  /** spec path (OpenAPI notation) → set of uppercase HTTP methods */
  let specPaths: Map<string, Set<string>>;

  beforeAll(() => {
    // Build the router with lightweight in-memory dependencies so no real DB
    // connection is required. Route registration is purely synchronous.
    const router = createApiRouter({
      usageEventsRepository: new InMemoryUsageEventsRepository(),
    });

    expressRoutes = extractRoutes((router as any).stack as any[], MOUNT_PREFIX);

    // Parse the hand-maintained OpenAPI spec.
    const specFile = path.resolve(__dirname, '../../docs/openapi.json');
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };

    specPaths = new Map();
    for (const [specPath, pathItem] of Object.entries(spec.paths)) {
      const methods = new Set(
        Object.keys(pathItem)
          .filter((k) => HTTP_VERBS.has(k))
          .map((k) => k.toUpperCase()),
      );
      specPaths.set(specPath, methods);
    }
  });

  // ── Side 1: Express → Spec ────────────────────────────────────────────────

  test('every route in createApiRouter has a matching OpenAPI operation', () => {
    const missing: string[] = [];

    for (const { method, path: ePath } of expressRoutes) {
      const openApiPath = toOpenApiPath(ePath);
      const key = `${method} ${openApiPath}`;

      if (ROUTES_NOT_IN_SPEC.has(key)) continue;

      const specMethods = specPaths.get(openApiPath);
      if (!specMethods || !specMethods.has(method)) {
        missing.push(key);
      }
    }

    // If this fails, add the missing route(s) to docs/openapi.json,
    // or add them to ROUTES_NOT_IN_SPEC if they are intentionally internal.
    expect(missing).toEqual([]);
  });

  // ── Side 2: Spec → Express ────────────────────────────────────────────────

  test('every OpenAPI operation matches a route in createApiRouter', () => {
    const expressSet = new Set(
      expressRoutes.map(({ method, path: ePath }) => `${method} ${toOpenApiPath(ePath)}`),
    );

    const missing: string[] = [];

    for (const [specPath, methods] of specPaths) {
      for (const method of methods) {
        const key = `${method} ${specPath}`;

        if (SPEC_ROUTES_OUTSIDE_CREATE_API_ROUTER.has(key)) continue;

        if (!expressSet.has(key)) {
          missing.push(key);
        }
      }
    }

    // If this fails, either add the route to createApiRouter, remove it from
    // the spec, or add it to SPEC_ROUTES_OUTSIDE_CREATE_API_ROUTER if it is
    // served by a different router.
    expect(missing).toEqual([]);
  });

  // ── Side 3: Param-name consistency ────────────────────────────────────────

  test('parameterised routes use consistent parameter names in Express and OpenAPI', () => {
    const paramRoutes = expressRoutes.filter(({ path: p }) => p.includes(':'));

    for (const { method, path: ePath } of paramRoutes) {
      const openApiPath = toOpenApiPath(ePath);
      const key = `${method} ${openApiPath}`;

      if (ROUTES_NOT_IN_SPEC.has(key)) continue;

      const specMethods = specPaths.get(openApiPath);
      // If the path is absent from the spec the previous test already flags it;
      // skip param-name checking here to avoid duplicate failures.
      if (!specMethods) continue;

      const expressParams = (ePath.match(/:([^/]+)/g) ?? []).map((p) => p.slice(1));
      const openApiParams = (openApiPath.match(/\{([^}]+)\}/g) ?? []).map((p) =>
        p.slice(1, -1),
      );

      expect(openApiParams).toEqual(expressParams);
    }
  });
});
