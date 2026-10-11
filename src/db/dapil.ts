import { TINGKAT, type Tingkat } from '../tingkat';

export interface DapilRecord {
    kode_dapil: number;
    nama_dapil: string;
    kode_provinsi: number | null;
    nama_provinsi: string | null;
    kode_kabupaten: number | null;
    nama_kabupaten: string | null;
    jumlah_kursi: number | null;
    total_suara_sah: number;
}

export interface PartyVotesRecord {
    kode_dapil: number;
    partai_id: number;
    suara: number;
    sumber: string;
}

export interface CandidateRecord {
    kode_dapil: number;
    partai_id: number;
    nomor_urut: number;
    nama: string;
    jenis_kelamin: string | null;
    suara: number;
    kursi_ke: number;
}

export type OwnCandidateRecord = Pick<CandidateRecord, 'kode_dapil' | 'nomor_urut' | 'suara'>;

export interface DapilFilter {
    provinsi?: number;
    kabupaten?: number;
}

const DAPIL_COLUMNS =
    'kode_dapil, nama_dapil, kode_provinsi, nama_provinsi, kode_kabupaten, nama_kabupaten, jumlah_kursi, total_suara_sah';

const rows = <T>(result: D1Result<unknown> | undefined) => (result?.results ?? []) as T[];

/** Every dapil of a level, with all party votes and the focus party's candidates. Three queries, one round trip. */
export async function readDapilList(db: D1Database, tingkat: Tingkat, partyId: number, filter: DapilFilter) {
    const level = TINGKAT[tingkat];
    const conditions = ['tingkat = ?'];
    const scopeArgs: number[] = [level];
    if (filter.provinsi !== undefined) {
        conditions.push('kode_provinsi = ?');
        scopeArgs.push(filter.provinsi);
    }
    if (filter.kabupaten !== undefined) {
        conditions.push('kode_kabupaten = ?');
        scopeArgs.push(filter.kabupaten);
    }
    const scope = conditions.join(' AND ');
    // Without a region filter the level itself is the scope, so the subquery is left out.
    const filtered = scopeArgs.length > 1;
    const inScope = filtered ? ` AND kode_dapil IN (SELECT kode_dapil FROM dapil WHERE ${scope})` : '';
    const subqueryArgs = filtered ? scopeArgs : [];
    const [dapil, votes, candidates] = await db.batch([
        db.prepare(`SELECT ${DAPIL_COLUMNS} FROM dapil WHERE ${scope} ORDER BY kode_dapil`).bind(...scopeArgs),
        db
            .prepare(`SELECT kode_dapil, partai_id, suara FROM suara_partai WHERE tingkat = ?${inScope}`)
            .bind(level, ...subqueryArgs),
        // Served by the caleg_partai index alone.
        db
            .prepare(`SELECT kode_dapil, nomor_urut, suara FROM caleg WHERE tingkat = ? AND partai_id = ?${inScope}`)
            .bind(level, partyId, ...subqueryArgs),
    ]);
    return {
        dapil: rows<DapilRecord>(dapil),
        votes: rows<Omit<PartyVotesRecord, 'sumber'>>(votes),
        ownCandidates: rows<OwnCandidateRecord>(candidates),
    };
}

/** One dapil with its party votes and candidates: all of them, or one party's when `partyId` is given. */
export async function readDapil(db: D1Database, tingkat: Tingkat, kodeDapil: number, partyId?: number) {
    const level = TINGKAT[tingkat];
    const candidateColumns = 'kode_dapil, partai_id, nomor_urut, nama, jenis_kelamin, suara, kursi_ke';
    const [dapil, votes, candidates] = await db.batch([
        db.prepare(`SELECT ${DAPIL_COLUMNS} FROM dapil WHERE tingkat = ? AND kode_dapil = ?`).bind(level, kodeDapil),
        db
            .prepare(
                'SELECT kode_dapil, partai_id, suara, sumber FROM suara_partai WHERE tingkat = ? AND kode_dapil = ?',
            )
            .bind(level, kodeDapil),
        partyId === undefined
            ? db
                  .prepare(
                      `SELECT ${candidateColumns} FROM caleg WHERE tingkat = ? AND kode_dapil = ? ORDER BY partai_id, nomor_urut`,
                  )
                  .bind(level, kodeDapil)
            : db
                  .prepare(
                      `SELECT ${candidateColumns} FROM caleg WHERE tingkat = ? AND kode_dapil = ? AND partai_id = ? ORDER BY nomor_urut`,
                  )
                  .bind(level, kodeDapil, partyId),
    ]);
    return {
        dapil: rows<DapilRecord>(dapil)[0] ?? null,
        votes: rows<PartyVotesRecord>(votes),
        candidates: rows<CandidateRecord>(candidates),
    };
}

export interface PadananRecord {
    kode_dapil_2019: number;
    nama_dapil_2019: string;
    sebanding: number;
    ada_di_hasil_2019: number;
    ada_di_hasil_2024: number;
}

/** The 2024 dapil and its matching 2019 dapil, if it has one. Only in the 2024 database. */
export async function readPadanan(db: D1Database, tingkat: Tingkat, kodeDapil: number) {
    const level = TINGKAT[tingkat];
    const [dapil, padanan] = await db.batch([
        db.prepare(`SELECT ${DAPIL_COLUMNS} FROM dapil WHERE tingkat = ? AND kode_dapil = ?`).bind(level, kodeDapil),
        db
            .prepare(
                'SELECT kode_dapil_2019, nama_dapil_2019, sebanding, ada_di_hasil_2019, ada_di_hasil_2024 FROM padanan_dapil WHERE tingkat = ? AND kode_dapil_2024 = ?',
            )
            .bind(level, kodeDapil),
    ]);
    return { dapil: rows<DapilRecord>(dapil)[0] ?? null, padanan: rows<PadananRecord>(padanan)[0] ?? null };
}

export interface PadananPairRecord {
    kode_dapil_2024: number;
    kode_dapil_2019: number;
}

/** Every comparable 2024 to 2019 pair of a level whose two sides are both in the results. */
export async function readPadananList(db: D1Database, tingkat: Tingkat) {
    const result = await db
        .prepare(
            'SELECT kode_dapil_2024, kode_dapil_2019 FROM padanan_dapil WHERE tingkat = ? AND sebanding = 1 AND ada_di_hasil_2019 = 1 AND ada_di_hasil_2024 = 1 ORDER BY kode_dapil_2024',
        )
        .bind(TINGKAT[tingkat])
        .all<PadananPairRecord>();
    return result.results;
}

export interface AliasRecord {
    tingkat: number;
    nama_di_aplikasi: string;
    nama_dapil: string;
    kode_dapil: number;
}

/** All 70 alias rows; the whole table is the answer. */
export async function readAliases(db: D1Database): Promise<AliasRecord[]> {
    const result = await db
        .prepare(
            'SELECT tingkat, nama_di_aplikasi, nama_dapil, kode_dapil FROM dapil_alias ORDER BY tingkat, nama_di_aplikasi',
        )
        .all();
    return rows<AliasRecord>(result);
}
