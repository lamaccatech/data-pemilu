import { exports } from 'cloudflare:workers';

export const KEY = 'kunci-uji';

/** Calls the Worker with the test API key unless `key` is null. */
export function call(path: string, key: string | null = KEY, host = 'https://api.example.com'): Promise<Response> {
    const headers: Record<string, string> = key === null ? {} : { Authorization: `Bearer ${key}` };
    return exports.default.fetch(new Request(`${host}${path}`, { headers }));
}

// biome-ignore lint/suspicious/noExplicitAny: test bodies are checked field by field
type Body = any;

export async function json(
    path: string,
    key: string | null = KEY,
    host?: string,
): Promise<{ status: number; body: Body }> {
    const response = await call(path, key, host);
    return { status: response.status, body: await response.json() };
}
