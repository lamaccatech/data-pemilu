import type { MiddlewareHandler } from 'hono';
import { type AppEnv, CACHE_CONTROL } from './context';
import { CALLER_VERSION_PARAMETER } from './params';

/**
 * Part of every cache key. Raise it whenever the shape or the figures of an answer change, so that answers
 * cached before the change are no longer given out.
 */
const RESPONSE_VERSION = '16';
const VERSION_PARAMETER = CALLER_VERSION_PARAMETER;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' };
// Edge copies of a KV read, an absent key included, are kept this long (60 is KV's minimum). Kept short so that a
// key written after a miss is not hidden for long; the data never changes, so a longer time would only spare reads.
const KV_EDGE_TTL_SECONDS = 60;

/** The Cache API key and the KV key are the same URL; KV keys are limited to 512 bytes, so a longer one is skipped. */
function kvKeyOf(url: URL): string | null {
    const key = `${url.pathname}?${url.searchParams.toString()}`;
    return key.length > 512 ? null : key;
}

/**
 * Keeps successful answers in the Cache API, keyed by the full URL and the response version. Runs after authentication, so a cached
 * answer is only ever given to a caller with a valid key.
 */
export const cacheResponses: MiddlewareHandler<AppEnv> = async (c, next) => {
    // Absent outside the Workers runtime, for example when the app runs in Node for the data tests.
    const cache = (globalThis as { caches?: CacheStorage }).caches?.default;
    if (cache === undefined || c.req.method !== 'GET') {
        return next();
    }
    const url = new URL(c.req.url);
    // A what-if is asked with whatever votes the caller tries: nothing to gain from keeping each one.
    if (url.pathname.endsWith('/simulasi')) {
        return next();
    }
    url.searchParams.set(VERSION_PARAMETER, RESPONSE_VERSION);
    const key = new Request(url);
    // KV is global and holds what `pnpm prewarm` computed ahead of time, so it is asked before the per-datacenter cache.
    const kvKey = c.env.CACHE_KV === undefined ? null : kvKeyOf(url);
    if (kvKey !== null) {
        const stored = await c.env.CACHE_KV?.get(kvKey, { cacheTtl: KV_EDGE_TTL_SECONDS });
        if (stored !== null && stored !== undefined) {
            return new Response(stored, {
                headers: { ...JSON_HEADERS, 'Cache-Control': CACHE_CONTROL, 'X-Cache': 'KV' },
            });
        }
    }
    const hit = await cache.match(key);
    if (hit !== undefined) {
        // Cloned first: building the response below takes the body.
        const copy = kvKey === null ? null : hit.clone();
        const response = new Response(hit.body, hit);
        response.headers.set('Cache-Control', CACHE_CONTROL);
        response.headers.set('X-Cache', 'HIT');
        if (kvKey !== null && copy !== null) {
            // KV missed above, so every other datacenter still has to compute this answer: give it to them.
            c.executionCtx.waitUntil(copy.text().then((text) => c.env.CACHE_KV?.put(kvKey, text)));
        }
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
    if (kvKey !== null) {
        // Written on a miss too, so what is not prewarmed is still computed once for every datacenter.
        const body = c.res.clone();
        c.executionCtx.waitUntil(body.text().then((text) => c.env.CACHE_KV?.put(kvKey, text)));
    }
    c.res.headers.set('X-Cache', 'MISS');
};
