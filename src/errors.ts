import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** An error the client is told about: `{ "error": { "code", "message" } }`. Messages are in Indonesian. */
export class ApiError extends Error {
    constructor(
        readonly status: ContentfulStatusCode,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

export const notFound = (code: string, message: string) => new ApiError(404, code, message);
