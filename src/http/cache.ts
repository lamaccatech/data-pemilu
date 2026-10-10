import type { MiddlewareHandler } from 'hono';
import { type AppEnv, CACHE_CONTROL } from './context';

/**
 * Keeps successful answers in the Cache API, keyed by the full URL. Runs after authentication, so a cached
 * answer is only ever given to a caller with a valid key.
 */
export const cacheResponses: MiddlewareHandler<AppEnv> = async (c, next) => {
    // Absent outside the Workers runtime, for example when the app runs in Node for the data tests.
    const cache = (globalThis as { caches?: CacheStorage }).caches?.default;
    if (cache === undefined || c.req.method !== 'GET') {
        return next();
    }
    const key = new Request(c.req.url);
    const hit = await cache.match(key);
    if (hit !== undefined) {
        const response = new Response(hit.body, hit);
        response.headers.set('Cache-Control', CACHE_CONTROL);
        response.headers.set('X-Cache', 'HIT');
        return response;
    }
    await next();
    if (c.res.status !== 200) {
        return;
    }
    // The Cache API will not keep a `private` response, so the stored copy is marked public. It never leaves
    // the Worker with that header.
    const stored = new Response(c.res.clone().body, c.res);
    stored.headers.set('Cache-Control', 'public, max-age=86400');
    c.executionCtx.waitUntil(cache.put(key, stored));
    c.res.headers.set('X-Cache', 'MISS');
};
