import { app } from './app';
import type { Env } from './env';

/**
 * The election is always accepted in the path (/v1/2024/...). On the per-election hostnames
 * (pemilu2024.*, pemilu2019.*) it may be left out, and the hostname supplies it.
 */
export function withYearFromHost(request: Request): Request {
    const url = new URL(request.url);
    const year = /^pemilu(\d{4})\./.exec(url.hostname)?.[1];
    const rest = /^\/v1\/(.*)$/.exec(url.pathname)?.[1];
    if (year === undefined || rest === undefined || /^\d{4}(\/|$)/.test(rest)) {
        return request;
    }
    url.pathname = `/v1/${year}/${rest}`;
    return new Request(url, request);
}

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
        return app.fetch(withYearFromHost(request), env, ctx);
    },
} satisfies ExportedHandler<Env>;
