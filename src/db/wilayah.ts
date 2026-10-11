import { TINGKAT, type Tingkat } from '../tingkat';
import type { DapilRecord } from './dapil';

// Kelurahan and kecamatan tables exist in the 2024 database only.

const rows = <T>(result: D1Result<unknown> | undefined) => (result?.results ?? []) as T[];

const DAPIL = 'SELECT kode_dapil, nama_dapil, jumlah_kursi FROM dapil WHERE tingkat = ? AND kode_dapil = ?';

export type DapilName = Pick<DapilRecord, 'kode_dapil' | 'nama_dapil' | 'jumlah_kursi'>;

/** A kelurahan code is its kecamatan code followed by four digits. */
const KELURAHAN_PER_KECAMATAN = 10_000;

/** The primary key range that holds the kelurahan of one kecamatan, or null for a non-numeric (overseas) code. */
export function kelurahanRange(kodeKecamatan: string): [number, number] | null {
    if (!/^\d{6}$/.test(kodeKecamatan)) {
        return null;
    }
    const first = Number(kodeKecamatan) * KELURAHAN_PER_KECAMATAN;
    return [first, first + KELURAHAN_PER_KECAMATAN - 1];
}

export interface KecamatanVotesRecord {
    kode_kecamatan: number;
    partai_id: number;
    suara: number;
}

/** Party votes of a dapil summed per kecamatan from the kelurahan table, with the dapil-level votes to compare. */
export async function readKecamatanVotes(db: D1Database, tingkat: Tingkat, kodeDapil: number, partyId: number) {
    const level = TINGKAT[tingkat];
    const [dapil, kecamatan, votes, kelurahan, dapilVotes] = await db.batch([
        db.prepare(DAPIL).bind(level, kodeDapil),
        db
            .prepare(
                'SELECT kode_kecamatan, nama_kecamatan FROM dapil_kecamatan WHERE tingkat = ? AND kode_dapil = ? ORDER BY kode_kecamatan',
            )
            .bind(level, kodeDapil),
        db
            .prepare(
                `SELECT kode_kelurahan / ${KELURAHAN_PER_KECAMATAN} AS kode_kecamatan, partai_id, SUM(suara) AS suara FROM kelurahan_suara_partai WHERE tingkat = ? AND kode_dapil = ? GROUP BY 1, 2`,
            )
            .bind(level, kodeDapil),
        db
            .prepare(
                `SELECT kode_kelurahan / ${KELURAHAN_PER_KECAMATAN} AS kode_kecamatan, COUNT(DISTINCT kode_kelurahan) AS jumlah FROM kelurahan_suara_partai WHERE tingkat = ? AND kode_dapil = ? GROUP BY 1`,
            )
            .bind(level, kodeDapil),
        db
            .prepare('SELECT suara FROM suara_partai WHERE tingkat = ? AND kode_dapil = ? AND partai_id = ?')
            .bind(level, kodeDapil, partyId),
    ]);
    return {
        dapil: rows<DapilName>(dapil)[0] ?? null,
        kecamatan: rows<{ kode_kecamatan: string; nama_kecamatan: string }>(kecamatan),
        votes: rows<KecamatanVotesRecord>(votes),
        kelurahanCounts: rows<{ kode_kecamatan: number; jumlah: number }>(kelurahan),
        dapilVotes: rows<{ suara: number }>(dapilVotes)[0]?.suara ?? null,
    };
}

export interface DptRecord {
    kode_kelurahan: number;
    nama_kelurahan: string;
    dpt: number;
    dpt_l: number;
    dpt_p: number;
    usia_kurang21: number;
    usia_u21_25: number;
    usia_u26_30: number;
    usia_u31_40: number;
    usia_u41_50: number;
    usia_u51_55: number;
    usia_lebih55: number;
}

/** Party votes and voter roll of every kelurahan of one kecamatan, as far as it lies in the dapil. */
export async function readKelurahanVotes(db: D1Database, tingkat: Tingkat, kodeDapil: number, kodeKecamatan: string) {
    const level = TINGKAT[tingkat];
    const range = kelurahanRange(kodeKecamatan);
    const statements = [
        db.prepare(DAPIL).bind(level, kodeDapil),
        // Served by the dapil_kecamatan_kecamatan index alone: every dapil that holds this kecamatan.
        db
            .prepare('SELECT kode_dapil FROM dapil_kecamatan WHERE tingkat = ? AND kode_kecamatan = ?')
            .bind(level, kodeKecamatan),
        db
            .prepare(
                'SELECT nama_kecamatan FROM dapil_kecamatan WHERE tingkat = ? AND kode_dapil = ? AND kode_kecamatan = ?',
            )
            .bind(level, kodeDapil, kodeKecamatan),
    ];
    if (range !== null) {
        statements.push(
            db
                .prepare(
                    'SELECT kode_kelurahan, partai_id, suara FROM kelurahan_suara_partai WHERE tingkat = ? AND kode_dapil = ? AND kode_kelurahan BETWEEN ? AND ?',
                )
                .bind(level, kodeDapil, ...range),
            db.prepare('SELECT * FROM kelurahan_dpt WHERE kode_kelurahan BETWEEN ? AND ?').bind(...range),
            // Where a kecamatan is split between dapil: the kelurahan that have votes in another dapil.
            // CROSS JOIN fixes the order: the few dapil first, then one key range of votes for each.
            db
                .prepare(
                    'SELECT DISTINCT k.kode_kelurahan FROM dapil_kecamatan d CROSS JOIN kelurahan_suara_partai k ON k.tingkat = d.tingkat AND k.kode_dapil = d.kode_dapil AND k.kode_kelurahan BETWEEN ? AND ? WHERE d.tingkat = ? AND d.kode_kecamatan = ? AND d.kode_dapil <> ?',
                )
                .bind(...range, level, kodeKecamatan, kodeDapil),
        );
    }
    const [dapil, holders, kecamatan, votes, dpt, elsewhere] = await db.batch(statements);
    return {
        dapil: rows<DapilName>(dapil)[0] ?? null,
        /** Null when the kecamatan is not part of this dapil. */
        namaKecamatan: rows<{ nama_kecamatan: string }>(kecamatan)[0]?.nama_kecamatan ?? null,
        holders: rows<{ kode_dapil: number }>(holders).map((row) => row.kode_dapil),
        votes: rows<{ kode_kelurahan: number; partai_id: number; suara: number }>(votes),
        dpt: rows<DptRecord>(dpt),
        elsewhere: rows<{ kode_kelurahan: number }>(elsewhere).map((row) => row.kode_kelurahan),
    };
}

export interface AreaCandidateRecord {
    partai_id: number;
    nomor_urut: number;
    nama: string | null;
    jenis_kelamin: string | null;
    suara: number;
    suara_dapil: number | null;
    kursi_ke: number | null;
}

const CANDIDATE_COLUMNS =
    'k.partai_id, k.nomor_urut, c.nama, c.jenis_kelamin, k.suara, c.suara AS suara_dapil, c.kursi_ke';
const CANDIDATE_JOIN =
    'LEFT JOIN caleg c ON c.tingkat = ? AND c.kode_dapil = k.kode_dapil AND c.partai_id = k.partai_id AND c.nomor_urut = k.nomor_urut';

/** Candidate votes in one kelurahan (dpr_ri and dprd_kabupaten_kota). Only candidates with votes have a row. */
export async function readKelurahanCandidates(
    db: D1Database,
    tingkat: Tingkat,
    kodeDapil: number,
    kodeKelurahan: number,
    partyId: number | null,
) {
    const level = TINGKAT[tingkat];
    const kodeKecamatan = String(Math.floor(kodeKelurahan / KELURAHAN_PER_KECAMATAN));
    const where = 'k.tingkat = ? AND k.kode_dapil = ? AND k.kode_kelurahan = ?';
    const [dapil, kecamatan, kelurahan, any, candidates] = await db.batch([
        db.prepare(DAPIL).bind(level, kodeDapil),
        db
            .prepare(
                'SELECT nama_kecamatan FROM dapil_kecamatan WHERE tingkat = ? AND kode_dapil = ? AND kode_kecamatan = ?',
            )
            .bind(level, kodeDapil, kodeKecamatan),
        db.prepare('SELECT nama_kelurahan FROM kelurahan_dpt WHERE kode_kelurahan = ?').bind(kodeKelurahan),
        // With a party filter an empty answer could mean "no data" or "no votes"; this tells them apart.
        db
            .prepare(`SELECT 1 AS ada FROM kelurahan_suara_caleg k WHERE ${where} LIMIT 1`)
            .bind(level, kodeDapil, kodeKelurahan),
        partyId === null
            ? db
                  .prepare(
                      `SELECT ${CANDIDATE_COLUMNS} FROM kelurahan_suara_caleg k ${CANDIDATE_JOIN} WHERE ${where} ORDER BY k.partai_id, k.nomor_urut`,
                  )
                  .bind(level, level, kodeDapil, kodeKelurahan)
            : db
                  .prepare(
                      `SELECT ${CANDIDATE_COLUMNS} FROM kelurahan_suara_caleg k ${CANDIDATE_JOIN} WHERE ${where} AND k.partai_id = ? ORDER BY k.nomor_urut`,
                  )
                  .bind(level, level, kodeDapil, kodeKelurahan, partyId),
    ]);
    return {
        dapil: rows<DapilName>(dapil)[0] ?? null,
        kodeKecamatan,
        namaKecamatan: rows<{ nama_kecamatan: string }>(kecamatan)[0]?.nama_kecamatan ?? null,
        namaKelurahan: rows<{ nama_kelurahan: string }>(kelurahan)[0]?.nama_kelurahan ?? null,
        hasData: rows(any).length > 0,
        candidates: rows<AreaCandidateRecord>(candidates),
    };
}

/** Candidate votes in one kecamatan, dprd_provinsi only: at this level they stop at kecamatan. */
export async function readKecamatanCandidates(
    db: D1Database,
    kodeDapil: number,
    kodeKecamatan: string,
    partyId: number | null,
) {
    const level = TINGKAT.dprd_provinsi;
    // The vote table stores the code as an integer; a non-numeric code cannot have rows.
    const numeric = /^\d{6}$/.test(kodeKecamatan) ? Number(kodeKecamatan) : -1;
    const where = 'k.kode_dapil = ? AND k.kode_kecamatan = ?';
    const [dapil, kecamatan, any, candidates] = await db.batch([
        db.prepare(DAPIL).bind(level, kodeDapil),
        db
            .prepare(
                'SELECT nama_kecamatan FROM dapil_kecamatan WHERE tingkat = ? AND kode_dapil = ? AND kode_kecamatan = ?',
            )
            .bind(level, kodeDapil, kodeKecamatan),
        db.prepare(`SELECT 1 AS ada FROM kecamatan_suara_caleg k WHERE ${where} LIMIT 1`).bind(kodeDapil, numeric),
        partyId === null
            ? db
                  .prepare(
                      `SELECT ${CANDIDATE_COLUMNS} FROM kecamatan_suara_caleg k ${CANDIDATE_JOIN} WHERE ${where} ORDER BY k.partai_id, k.nomor_urut`,
                  )
                  .bind(level, kodeDapil, numeric)
            : db
                  .prepare(
                      `SELECT ${CANDIDATE_COLUMNS} FROM kecamatan_suara_caleg k ${CANDIDATE_JOIN} WHERE ${where} AND k.partai_id = ? ORDER BY k.nomor_urut`,
                  )
                  .bind(level, kodeDapil, numeric, partyId),
    ]);
    return {
        dapil: rows<DapilName>(dapil)[0] ?? null,
        namaKecamatan: rows<{ nama_kecamatan: string }>(kecamatan)[0]?.nama_kecamatan ?? null,
        hasData: rows(any).length > 0,
        candidates: rows<AreaCandidateRecord>(candidates),
    };
}

export interface KelurahanDptTotal {
    kode_kelurahan: number;
    dpt: number;
}

// One page stays under the D1 row cap. The full table is about 84,000 rows.
const KELURAHAN_DPT_PAGE = 10_000;

/** Every kelurahan's registered-voter total. Paged, because one statement cannot return the whole table. */
export async function readAllKelurahanDpt(db: D1Database): Promise<KelurahanDptTotal[]> {
    const collected: KelurahanDptTotal[] = [];
    let after = 0;
    for (;;) {
        const page = rows<KelurahanDptTotal>(
            await db
                .prepare(
                    'SELECT kode_kelurahan, dpt FROM kelurahan_dpt WHERE kode_kelurahan > ? ORDER BY kode_kelurahan LIMIT ?',
                )
                .bind(after, KELURAHAN_DPT_PAGE)
                .all(),
        );
        collected.push(...page);
        const last = page.at(-1);
        if (page.length < KELURAHAN_DPT_PAGE || last === undefined) {
            return collected;
        }
        after = last.kode_kelurahan;
    }
}
