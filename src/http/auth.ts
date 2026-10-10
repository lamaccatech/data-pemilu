import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../errors';
import type { AppEnv } from './context';

let parsed: { raw: string; keys: Map<string, string> } | null = null;

/** API_KEYS is a JSON object mapping key to client label. Parsed once per isolate. */
function readKeys(raw: string | undefined): Map<string, string> {
    if (parsed !== null && parsed.raw === raw) {
        return parsed.keys;
    }
    let keys: Map<string, string> | null = null;
    try {
        const value: unknown = JSON.parse(raw ?? '');
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            keys = new Map(Object.entries(value).map(([key, label]) => [key, String(label)]));
        }
    } catch {
        // Reported below.
    }
    if (keys === null || raw === undefined) {
        console.error('API_KEYS is missing or is not a JSON object');
        throw new ApiError(500, 'konfigurasi-server', 'Kunci API belum dikonfigurasi di server.');
    }
    parsed = { raw, keys };
    return keys;
}

/**
 * `Authorization: Bearer <key>`. The key says which application is calling; it does not limit which party
 * can be asked about.
 */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
    const keys = readKeys(c.env.API_KEYS);
    const token = /^Bearer (\S+)$/.exec(c.req.header('Authorization') ?? '')?.[1];
    const client = token === undefined ? undefined : keys.get(token);
    if (client === undefined) {
        throw new ApiError(401, 'tidak-berwenang', 'Kunci API tidak ada atau tidak dikenal.');
    }
    c.set('client', client);
    await next();
};
