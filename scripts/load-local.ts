/**
 * Applies the migrations and every generated SQL file to the local D1 (.wrangler/state), through Wrangler.
 * Never touches a remote database.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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

function main() {
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
    for (const pemilu of PEMILU) {
        const key = `${pemilu}/provinsi.geojson`;
        const file = path.join(GEO_DIR, key);
        if (!fs.existsSync(file)) {
            console.log(`${GEO_BUCKET}: ${key} not built, skipped. Run \`pnpm build-geo\` first.`);
            continue;
        }
        wrangler([
            'r2',
            'object',
            'put',
            `${GEO_BUCKET}/${key}`,
            '--local',
            '--file',
            file,
            '--content-type',
            'application/geo+json',
        ]);
        console.log(`${GEO_BUCKET}: ${key}`);
    }
    console.log('\nDone. Run `pnpm verify` to check the result.');
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
