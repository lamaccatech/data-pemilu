import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('GET /healthz', () => {
    it('answers without an API key', async () => {
        const response = await exports.default.fetch('https://example.com/healthz');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ data: { status: 'ok' }, meta: {} });
    });
});
