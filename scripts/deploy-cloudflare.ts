/**
 * Creates (or finds) the Cloudflare resources the Worker binds to, writes their ids into wrangler.jsonc, applies the
 * migrations and deploys. Safe to run again: a resource that exists is reused. The election data is not loaded here
 * (see README, "Steps"): it is 12 million rows and is loaded once.
 *
 *   pnpm cf:setup     create or reuse D1, KV and R2, write the ids, set API_KEYS if missing, migrate, deploy
 *   pnpm cf:deploy    check the config, migrate, deploy
 *   pnpm cf:check     check wrangler.jsonc has real ids; no network
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.jsonc');
const DATABASES = ['pemilu2024', 'pemilu2019'] as const;
const KV_NAMESPACE = 'data-pemilu-cache';
const KV_BINDING = 'CACHE_KV';
const R2_BUCKET = 'data-pemilu-batas';
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KV_ID = /^[0-9a-f]{32}$/i;
// What wrangler.jsonc carries until `cf:setup` has run; see the zeros in the committed file.
const PLACEHOLDER = /^0{8}-0{4}-0{4}-0{4}-0{8}\d{4}$|^0{28}\d{4}$/;

function wrangler(args: string[], { capture = false, allowFailure = false } = {}) {
    const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
        stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    });
    if (result.status !== 0 && !allowFailure) {
        throw new Error(`wrangler ${args.join(' ')} exited with status ${result.status}.`);
    }
    return result;
}

function listJson(args: string[]): Record<string, string>[] {
    const output = wrangler(args, { capture: true }).stdout;
    try {
        const parsed: unknown = JSON.parse(output);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        throw new Error(`wrangler ${args.join(' ')} returned something that is not JSON.`);
    }
}

function ensureDatabase(name: string): string {
    const find = () => listJson(['d1', 'list', '--json']).find((database) => database.name === name);
    if (find() === undefined) {
        console.log(`Creating D1 database ${name} (APAC)...`);
        wrangler(['d1', 'create', name, '--location', 'apac']);
    }
    const id = find()?.uuid ?? find()?.id;
    if (id === undefined || !D1_ID.test(id)) {
        throw new Error(`Could not read the id of D1 database ${name}.`);
    }
    return id;
}

function ensureKv(): string {
    const find = () => listJson(['kv', 'namespace', 'list']).find((namespace) => namespace.title === KV_NAMESPACE);
    if (find() === undefined) {
        console.log(`Creating KV namespace ${KV_NAMESPACE}...`);
        wrangler(['kv', 'namespace', 'create', KV_NAMESPACE]);
    }
    const id = find()?.id;
    if (id === undefined || !KV_ID.test(id)) {
        throw new Error(`Could not read the id of KV namespace ${KV_NAMESPACE}.`);
    }
    return id;
}

function ensureBucket(): void {
    console.log(`Ensuring R2 bucket ${R2_BUCKET}...`);
    const created = wrangler(['r2', 'bucket', 'create', R2_BUCKET], { allowFailure: true });
    if (created.status !== 0) {
        console.log(`R2 bucket ${R2_BUCKET} may already exist; continuing.`);
    }
}

function ensureApiKeys(): void {
    const secrets = listJson(['secret', 'list', '--format', 'json']);
    if (secrets.some((secret) => secret.name === 'API_KEYS')) {
        return;
    }
    console.log('\nAPI_KEYS is not set. Enter a JSON object mapping key to client label, e.g. {"<random key>":"pan"}');
    wrangler(['secret', 'put', 'API_KEYS']);
}

function databaseIdPattern(name: string) {
    return new RegExp(`("database_name":\\s*"${name}",\\s*"database_id":\\s*)"[^"]*"`);
}
const KV_ID_PATTERN = new RegExp(`("binding":\\s*"${KV_BINDING}",\\s*"id":\\s*)"[^"]*"`);

function writeIds(databaseIds: Record<string, string>, kvId: string): void {
    let config = fs.readFileSync(CONFIG_PATH, 'utf8');
    for (const name of DATABASES) {
        if (!databaseIdPattern(name).test(config)) {
            throw new Error(`wrangler.jsonc has no database_id for ${name}.`);
        }
        config = config.replace(databaseIdPattern(name), `$1${JSON.stringify(databaseIds[name])}`);
    }
    if (!KV_ID_PATTERN.test(config)) {
        throw new Error(`wrangler.jsonc has no ${KV_BINDING} namespace.`);
    }
    config = config.replace(KV_ID_PATTERN, `$1${JSON.stringify(kvId)}`);
    fs.writeFileSync(CONFIG_PATH, config);
    console.log('Wrote the ids into wrangler.jsonc. Commit it.');
}

function check(): void {
    const config = fs.readFileSync(CONFIG_PATH, 'utf8');
    const problems: string[] = [];
    for (const name of DATABASES) {
        const id = databaseIdPattern(name)
            .exec(config)?.[0]
            .match(/"database_id":\s*"([^"]*)"$/)?.[1];
        if (id === undefined || !D1_ID.test(id) || PLACEHOLDER.test(id)) {
            problems.push(`database_id of ${name} is ${id === undefined ? 'missing' : 'a placeholder'}`);
        }
    }
    const kvId = KV_ID_PATTERN.exec(config)?.[0].match(/"id":\s*"([^"]*)"$/)?.[1];
    if (kvId === undefined || !KV_ID.test(kvId) || PLACEHOLDER.test(kvId)) {
        problems.push(`${KV_BINDING} id is ${kvId === undefined ? 'missing' : 'a placeholder'}`);
    }
    if (problems.length > 0) {
        throw new Error(`${problems.join('; ')}. Run \`pnpm cf:setup\`.`);
    }
    console.log('wrangler.jsonc has real ids for both databases and the KV namespace.');
}

function migrateAndDeploy(): void {
    for (const name of DATABASES) {
        console.log(`\nApplying remote migrations to ${name}...`);
        wrangler(['d1', 'migrations', 'apply', name, '--remote']);
    }
    console.log('\nDeploying the Worker...');
    wrangler(['deploy']);
    console.log(
        '\nDeployed. If the data is not loaded yet, load it (README, "Steps"). Then, whenever the data or ' +
            'RESPONSE_VERSION changes, warm KV:\n  pnpm prewarm https://<host> <api key>',
    );
}

function main(): void {
    const command = process.argv[2] ?? 'deploy';
    if (command === 'check') {
        check();
        return;
    }
    if (command === 'setup') {
        execFileSync('pnpm', ['exec', 'wrangler', 'whoami'], { stdio: 'inherit' });
        const databaseIds = Object.fromEntries(DATABASES.map((name) => [name, ensureDatabase(name)]));
        const kvId = ensureKv();
        ensureBucket();
        writeIds(databaseIds, kvId);
        ensureApiKeys();
        migrateAndDeploy();
        return;
    }
    if (command === 'deploy') {
        check();
        migrateAndDeploy();
        return;
    }
    throw new Error(`Unknown command: ${command}. Use setup, deploy or check.`);
}

try {
    main();
} catch (error) {
    console.error(`\nDeployment stopped: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
}
