/**
 * Checks the local D1 after `pnpm load-local`: row counts, the national threshold lists and the ACEH I example.
 * Reads through the same code the Worker uses.
 */
import fs from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import { readDapil } from '../src/db/dapil';
import { database, loadElection, requireParty } from '../src/db/election';
import type { Env } from '../src/env';
import { viewDapil, votesMap } from '../src/service/dapil';
import { PEMILU } from '../src/tingkat';
import { DATABASES, MANIFEST_PATH, type Manifest, SECONDARY_INDEXES, SOURCES } from './tables';

const EXPECTED_THRESHOLD = { '2024': [1, 2, 3, 4, 5, 8, 12, 14], '2019': [1, 2, 3, 4, 5, 8, 10, 12, 14] };
// ACEH I, 2024, dpr_ri, 7 seats, pan with 185,867 votes.
const EXPECTED_ACEH_I = {
    harga_kursi_terakhir: 119581,
    target_suara_kursi_pertama: 106678,
    selisih_kursi_pertama: 79189,
    target_suara_kursi_berikutnya: 358744,
    kekurangan_kursi_berikutnya: 172877,
    suara_caleg_batas: 140614,
};

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
    if (!ok) {
        failures.push(message);
    }
    return ok ? 'ok' : 'MISMATCH';
};

async function main() {
    const manifest: Manifest | null = fs.existsSync(MANIFEST_PATH)
        ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
        : null;
    const { env, dispose } = await getPlatformProxy<Env>();
    try {
        const counts: Record<string, Record<string, number>> = {};
        for (const pemilu of PEMILU) {
            const db = database(env, pemilu);
            const name = DATABASES[pemilu];
            counts[name] = {};
            console.log(`\n${name}`);
            let written = 0;
            for (const source of SOURCES.filter((source) => source.byPemilu || pemilu === '2024')) {
                const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${source.table}`).first<{ n: number }>();
                const n = row?.n ?? 0;
                counts[name][source.table] = n;
                const built = manifest?.rows[name][source.table];
                const status =
                    built === undefined ? '' : check(n === built, `${name}.${source.table}: ${n} rows, built ${built}`);
                const indexes = Object.values(SECONDARY_INDEXES).filter((table) => table === source.table).length;
                written += n * (1 + indexes);
                console.log(`  ${source.table.padEnd(26)}${String(n).padStart(10)}  ${status}`);
            }
            const size = await db.prepare('SELECT 1').run();
            console.log(`  rows written on a full load, index entries included: ${written}`);
            console.log(`  database size: ${(size.meta.size_after / 1e6).toFixed(1)} MB`);
        }

        console.log('\nRow counts against the brief (both elections together)');
        for (const source of SOURCES) {
            const total = Object.values(counts).reduce((sum, tables) => sum + (tables[source.table] ?? 0), 0);
            const status = check(
                total === source.expectedRows,
                `${source.table}: ${total} rows, expected ${source.expectedRows}`,
            );
            console.log(
                `  ${source.table.padEnd(26)}${String(total).padStart(10)}${String(source.expectedRows).padStart(10)}  ${status}`,
            );
        }

        console.log('\nParties passing the 4% national threshold (dpr_ri), by ballot number');
        for (const pemilu of PEMILU) {
            const election = await loadElection(env, pemilu);
            const expected = EXPECTED_THRESHOLD[pemilu];
            const same = JSON.stringify(election.passingThreshold) === JSON.stringify(expected);
            console.log(
                `  ${pemilu}: [${election.passingThreshold.join(', ')}]  ${check(same, `threshold ${pemilu} differs`)}`,
            );
        }

        console.log('\nACEH I, 2024, dpr_ri, pan');
        const election = await loadElection(env, '2024');
        const pan = requireParty(election, 'pan');
        const { dapil, votes, candidates } = await readDapil(env.DB_2024, 'dpr_ri', 1101, pan.partai_id);
        if (dapil === null) {
            throw new Error('dapil 1101 is not in the local database');
        }
        const { view } = viewDapil(election, 'dpr_ri', dapil, votesMap(votes), candidates, pan);
        console.log(
            `  ${view.nama_dapil}, ${view.jumlah_kursi} kursi, suara pan ${view.suara_partai}, kuadran ${view.kuadran}`,
        );
        for (const [field, expected] of Object.entries(EXPECTED_ACEH_I)) {
            const actual = view[field as keyof typeof EXPECTED_ACEH_I];
            console.log(
                `  ${field.padEnd(32)}${String(actual).padStart(8)}  ${check(actual === expected, `${field}: ${actual}, expected ${expected}`)}`,
            );
        }
    } finally {
        await dispose();
    }
    if (failures.length > 0) {
        throw new Error(`\n${failures.length} check(s) failed:\n${failures.join('\n')}`);
    }
    console.log('\nAll checks passed.');
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
