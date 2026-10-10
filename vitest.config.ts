import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        projects: [
            {
                // Runs inside the Workers runtime with an empty in-memory D1 that the tests seed themselves.
                plugins: [
                    cloudflareTest({
                        wrangler: { configPath: './wrangler.jsonc' },
                        miniflare: { bindings: { API_KEYS: '{"kunci-uji":"uji"}' } },
                    }),
                ],
                test: { name: 'worker', include: ['test/worker/**/*.test.ts'] },
            },
            {
                // Runs the same app in Node against the local D1 filled by `pnpm load-local`.
                test: { name: 'data', include: ['test/data/**/*.test.ts'], testTimeout: 60_000 },
            },
        ],
    },
});
