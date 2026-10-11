import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
    test: {
        projects: [
            {
                // Runs inside the Workers runtime with an in-memory D1 seeded from reference/fixtures.json.
                plugins: [
                    cloudflareTest({
                        wrangler: { configPath: './wrangler.jsonc' },
                        miniflare: {
                            bindings: {
                                API_KEYS: '{"kunci-uji":"uji"}',
                                MIGRATIONS_2024: await readD1Migrations('./migrations/2024'),
                                MIGRATIONS_2019: await readD1Migrations('./migrations/2019'),
                            },
                        },
                    }),
                ],
                test: { name: 'worker', include: ['test/worker/**/*.test.ts'], setupFiles: ['./test/worker/setup.ts'] },
            },
            {
                // Runs the same app in Node against the local D1 filled by `pnpm load-local`.
                // One file at a time: each opens the same local SQLite files.
                test: {
                    name: 'data',
                    include: ['test/data/**/*.test.ts'],
                    testTimeout: 60_000,
                    fileParallelism: false,
                },
            },
        ],
    },
}));
