/**
 * Applies the migrations and every generated SQL file to the local D1 (.wrangler/state), through Wrangler.
 * Never touches a remote database. With `--geo` it only reloads the boundary files into the local R2 bucket.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { Env } from '../src/env';
import { PEMILU } from '../src/tingkat';
import { DATABASES, GEO_BUCKET, GEO_DIR, MANIFEST_PATH, type Manifest, SQL_DIR } from './tables';

function wrangler(args: string[]): void {
    try {
        // CI=1 makes Wrangler answer its own confirmation prompts.
        execFileSync('pnpm', ['exec', 'wrangler', ...args], { stdio: 'pipe', env: { ...process.env, CI: '1' } });
    } catch (error) {
        const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
        throw new Error(`wrangler ${args.join(' ')} failed:\n${stdout ?? ''}${stderr ?? ''}`);
    }
}

/** Every file under data/geo/<pemilu>/ goes into the local R2 bucket under the same name. */
async function uploadBoundaries(): Promise<void> {
    const files = PEMILU.flatMap((pemilu) => {
        const directory = path.join(GEO_DIR, pemilu);
        if (!fs.existsSync(directory)) {
            return [];
        }
        return (fs.readdirSync(directory, { recursive: true }) as string[])
            .filter((name) => name.endsWith('.geojson'))
            .map((name) => path.join(pemilu, name));
    });
    if (files.length === 0) {
        console.log(`${GEO_BUCKET}: nothing built, skipped. Run \`pnpm build-geo\` first.`);
        return;
    }
    // One process for all files; `wrangler r2 object put --local` once per file would take minutes.
    const { env, dispose } = await getPlatformProxy<Env>();
    try {
        for (const file of files) {
            await env.GEO.put(file.split(path.sep).join('/'), fs.readFileSync(path.join(GEO_DIR, file)), {
                httpMetadata: { contentType: 'application/geo+json' },
            });
        }
    } finally {
        await dispose();
    }
    console.log(`${GEO_BUCKET}: ${files.length} boundary files`);
}

async function main() {
    // `--geo` reloads only the boundary files, which takes seconds; the databases take minutes.
    if (process.argv.includes('--geo')) {
        await uploadBoundaries();
        return;
    }
    if (!fs.existsSync(MANIFEST_PATH)) {
        throw new Error('data/sql/manifest.json not found. Run `pnpm build-sql` first.');
    }
    const manifest: Manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    for (const database of Object.values(DATABASES)) {
        console.log(`${database}: applying migrations`);
        wrangler(['d1', 'migrations', 'apply', database, '--local']);
        for (const file of manifest.files[database]) {
            const started = Date.now();
            wrangler(['d1', 'execute', database, '--local', '--yes', '--file', path.join(SQL_DIR, file)]);
            console.log(`${database}: ${file} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
        }
    }
    await uploadBoundaries();
    console.log('\nDone. Run `pnpm verify` to check the result.');
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
