import type { Context } from 'hono';
import type { Env } from '../env';

export type AppEnv = { Bindings: Env; Variables: { client: string } };
export type AppContext = Context<AppEnv>;

/** The data never changes, so a day is a floor rather than a guess. `private`: answers depend on the API key. */
export const CACHE_CONTROL = 'private, max-age=86400';

/** Every successful answer: `{ "data": ..., "meta": { ... } }`. */
export function ok(c: AppContext, data: unknown, meta: Record<string, unknown> = {}) {
    c.header('Cache-Control', CACHE_CONTROL);
    return c.json({ data, meta });
}
