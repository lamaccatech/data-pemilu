import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import fixtures from '../../reference/fixtures.json';
import { resetElections } from '../../src/db/election';
import { TINGKAT, type Tingkat } from '../../src/tingkat';

declare global {
    namespace Cloudflare {
        interface Env {
            MIGRATIONS_2024: D1Migration[];
            MIGRATIONS_2019: D1Migration[];
        }
    }
}

// Ballot numbers per election. The fixtures only carry the numbers, so the codes are listed here.
const PARTIES: Record<'2024' | '2019', string[]> = {
    '2024': [
        'pkb',
        'gerindra',
        'pdip',
        'golkar',
        'nasdem',
        'partai_buruh',
        'gelora',
        'pks',
        'pkn',
        'hanura',
        'garuda',
        'pan',
        'pbb',
        'demokrat',
        'psi',
        'perindo',
        'ppp',
        'pna',
        'gabthat',
        'pda',
        'partai_aceh',
        'pas_aceh',
        'sira',
        'ummat',
    ],
    '2019': [
        'pkb',
        'gerindra',
        'pdip',
        'golkar',
        'nasdem',
        'garuda',
        'berkarya',
        'pks',
        'perindo',
        'ppp',
        'psi',
        'pan',
        'hanura',
        'demokrat',
        'partai_aceh',
        'sira',
        'pda',
        'pna',
        'pbb',
        'pkpi',
    ],
};

async function seed(db: D1Database, pemilu: '2024' | '2019'): Promise<void> {
    const statements = PARTIES[pemilu].map((code, index) =>
        db
            .prepare('INSERT INTO partai (partai_id, kode_partai, nama_partai) VALUES (?, ?, ?)')
            .bind(index + 1, code, `Partai ${code}`),
    );
    for (const { input, expected } of fixtures.dapil) {
        if (String(expected.pemilu) !== pemilu) {
            continue;
        }
        const level = TINGKAT[expected.tingkat as Tingkat];
        const code = Number(expected.kode_dapil);
        statements.push(
            db
                .prepare(
                    'INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, jumlah_kursi, total_suara_sah) VALUES (?, ?, ?, ?, ?)',
                )
                .bind(level, code, expected.nama_dapil, expected.jumlah_kursi, expected.total_suara_sah),
        );
        for (const [partyId, votes] of Object.entries(input.suara_partai)) {
            statements.push(
                db
                    .prepare(
                        "INSERT INTO suara_partai (tingkat, kode_dapil, partai_id, suara, sumber) VALUES (?, ?, ?, ?, 'uji')",
                    )
                    .bind(level, code, Number(partyId), votes),
            );
        }
        for (const row of input.caleg) {
            statements.push(
                db
                    .prepare(
                        'INSERT INTO caleg (tingkat, kode_dapil, partai_id, nomor_urut, nama, jenis_kelamin, suara, kursi_ke) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    )
                    .bind(
                        level,
                        code,
                        Number(row.partai_id),
                        Number(row.nomor_urut),
                        row.nama,
                        row.jenis_kelamin || null,
                        Number(row.suara),
                        Number(row.kursi_ke),
                    ),
            );
        }
    }
    await db.batch(statements);
}

await applyD1Migrations(env.DB_2024, env.MIGRATIONS_2024);
await applyD1Migrations(env.DB_2019, env.MIGRATIONS_2019);
const seeded = await env.DB_2024.prepare('SELECT COUNT(*) AS n FROM partai').first<{ n: number }>();
if (seeded?.n === 0) {
    await seed(env.DB_2024, '2024');
    await seed(env.DB_2019, '2019');
    await env.DB_2024.batch([
        env.DB_2024.prepare("INSERT INTO padanan_dapil VALUES (1, 1101, 1101, 'ACEH I', 1, 1, 1)"),
        env.DB_2024.prepare("INSERT INTO dapil_alias VALUES (1, 'SUMUT I', 'SUMATERA UTARA I', 1201)"),
    ]);
}
resetElections();
