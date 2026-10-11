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

export interface PartyTotalRecord {
    partai_id: number;
    suara: number;
}

/** Every party's votes in the dapil, and the same summed over its kelurahan: the two sides of `checkPartySpread`. */
function partySpread(db: D1Database, level: number, kodeDapil: number): [D1PreparedStatement, D1PreparedStatement] {
    return [
        db
            .prepare('SELECT partai_id, suara FROM suara_partai WHERE tingkat = ? AND kode_dapil = ?')
            .bind(level, kodeDapil),
        db
            .prepare(
                'SELECT partai_id, SUM(suara) AS suara FROM kelurahan_suara_partai WHERE tingkat = ? AND kode_dapil = ? GROUP BY partai_id',
            )
            .bind(level, kodeDapil),
    ];
}

export interface KecamatanVotesRecord {
    kode_kecamatan: number;
    partai_id: number;
    suara: number;
}

/** Party votes of a dapil summed per kecamatan from the kelurahan table, with the dapil-level votes to compare. */
export async function readKecamatanVotes(db: D1Database, tingkat: Tingkat, kodeDapil: number, partyId: number) {
    const level = TINGKAT[tingkat];
    const [dapil, kecamatan, votes, kelurahan, dapilVotes, partyVotes, partyAreas, sharers] = await db.batch([
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
        ...partySpread(db, level, kodeDapil),
        // The other dapil that hold one of this dapil's kecamatan.
        db
            .prepare(
                'SELECT mine.kode_kecamatan AS kode_kecamatan, other.kode_dapil AS kode_dapil FROM dapil_kecamatan mine CROSS JOIN dapil_kecamatan other ON other.tingkat = mine.tingkat AND other.kode_kecamatan = mine.kode_kecamatan AND other.kode_dapil <> mine.kode_dapil WHERE mine.tingkat = ? AND mine.kode_dapil = ?',
            )
            .bind(level, kodeDapil),
    ]);
    return {
        dapil: rows<DapilName>(dapil)[0] ?? null,
        kecamatan: rows<{ kode_kecamatan: string; nama_kecamatan: string }>(kecamatan),
        votes: rows<KecamatanVotesRecord>(votes),
        kelurahanCounts: rows<{ kode_kecamatan: number; jumlah: number }>(kelurahan),
        dapilVotes: rows<{ suara: number }>(dapilVotes)[0]?.suara ?? null,
        partyVotes: rows<PartyTotalRecord>(partyVotes),
        partyAreas: rows<PartyTotalRecord>(partyAreas),
        sharers: rows<{ kode_kecamatan: string; kode_dapil: number }>(sharers),
    };
}

export interface KecamatanLevelVotes {
    kode_kecamatan: string;
    total: number;
    partai: number;
}

// The kecamatan of one dapil, read at another level: that level's dapil are found through the kecamatan
// index, then one key range of kelurahan votes for each. A kecamatan is taken whole, so where two dapil of
// a level share it, both halves are summed. CROSS JOIN fixes the order, so the vote table is never read by level alone.
const KECAMATAN_AT_LEVEL = `
SELECT mine.kode_kecamatan AS kode_kecamatan,
       SUM(k.suara) AS total,
       SUM(CASE WHEN k.partai_id = ? THEN k.suara ELSE 0 END) AS partai
FROM dapil_kecamatan mine
CROSS JOIN dapil_kecamatan other
  ON other.tingkat = ? AND other.kode_kecamatan = mine.kode_kecamatan
CROSS JOIN kelurahan_suara_partai k
  ON k.tingkat = other.tingkat AND k.kode_dapil = other.kode_dapil
 AND k.kode_kelurahan BETWEEN CAST(mine.kode_kecamatan AS INTEGER) * ${KELURAHAN_PER_KECAMATAN}
                        AND CAST(mine.kode_kecamatan AS INTEGER) * ${KELURAHAN_PER_KECAMATAN} + ${KELURAHAN_PER_KECAMATAN - 1}
WHERE mine.tingkat = ? AND mine.kode_dapil = ?
  AND mine.kode_kecamatan GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'
GROUP BY mine.kode_kecamatan`;

// The dapil of another level that hold a kecamatan of this dapil.
const HOLDERS_AT_LEVEL = `
SELECT mine.kode_kecamatan AS kode_kecamatan, other.kode_dapil AS kode_dapil
FROM dapil_kecamatan mine
CROSS JOIN dapil_kecamatan other
  ON other.tingkat = ? AND other.kode_kecamatan = mine.kode_kecamatan
WHERE mine.tingkat = ? AND mine.kode_dapil = ?`;

const HOLDER_CODES = `
SELECT other.kode_dapil
FROM dapil_kecamatan mine
CROSS JOIN dapil_kecamatan other
  ON other.tingkat = ? AND other.kode_kecamatan = mine.kode_kecamatan
WHERE mine.tingkat = ? AND mine.kode_dapil = ?`;

// Both sides of `checkPartySpread` for each of those dapil. Entered by dapil, one key range each.
const HOLDER_VOTES = `SELECT kode_dapil, partai_id, suara FROM suara_partai WHERE tingkat = ? AND kode_dapil IN (${HOLDER_CODES})`;
const HOLDER_AREAS = `
SELECT k.kode_dapil AS kode_dapil, k.partai_id AS partai_id, SUM(k.suara) AS suara
FROM kelurahan_suara_partai k
WHERE k.tingkat = ? AND k.kode_dapil IN (${HOLDER_CODES})
GROUP BY k.kode_dapil, k.partai_id`;

export interface HolderPartyTotal extends PartyTotalRecord {
    kode_dapil: number;
}

/** One party's votes and the valid votes in every kecamatan of a dapil, at each of the three levels. */
export async function readKecamatanAcrossLevels(db: D1Database, tingkat: Tingkat, kodeDapil: number, partyId: number) {
    const level = TINGKAT[tingkat];
    const levels = Object.keys(TINGKAT) as Tingkat[];
    const perLevelChecks = levels.flatMap((other) => {
        const args = [TINGKAT[other], TINGKAT[other], level, kodeDapil];
        return [
            db.prepare(HOLDERS_AT_LEVEL).bind(TINGKAT[other], level, kodeDapil),
            db.prepare(HOLDER_VOTES).bind(...args),
            db.prepare(HOLDER_AREAS).bind(...args),
        ];
    });
    const [dapil, kecamatan, ...rest] = await db.batch([
        db.prepare(DAPIL).bind(level, kodeDapil),
        db
            .prepare(
                'SELECT kode_kecamatan, nama_kecamatan FROM dapil_kecamatan WHERE tingkat = ? AND kode_dapil = ? ORDER BY kode_kecamatan',
            )
            .bind(level, kodeDapil),
        ...levels.map((other) => db.prepare(KECAMATAN_AT_LEVEL).bind(partyId, TINGKAT[other], level, kodeDapil)),
        ...perLevelChecks,
    ]);
    const perLevel = rest.slice(0, levels.length);
    const checks = rest.slice(levels.length);
    return {
        dapil: rows<DapilName>(dapil)[0] ?? null,
        kecamatan: rows<{ kode_kecamatan: string; nama_kecamatan: string }>(kecamatan),
        votes: new Map(
            levels.map((other, index) => [
                other,
                new Map(rows<KecamatanLevelVotes>(perLevel[index]).map((row) => [row.kode_kecamatan, row])),
            ]),
        ),
        /** Per level: which dapil hold each kecamatan, and the two sides of the party check for those dapil. */
        holders: new Map(
            levels.map((other, index) => [
                other,
                {
                    kecamatan: rows<{ kode_kecamatan: string; kode_dapil: number }>(checks[index * 3]),
                    dapilVotes: rows<HolderPartyTotal>(checks[index * 3 + 1]),
                    areaVotes: rows<HolderPartyTotal>(checks[index * 3 + 2]),
                },
            ]),
        ),
    };
}

export interface KelurahanStandingRecord {
    kode_kelurahan: number;
    total: number;
    partai: number;
    suara_unggul: number;
    partai_unggul: number;
    nama_kelurahan: string | null;
    dpt: number | null;
    di_bawah_30: number | null;
}

/**
 * Every kelurahan of a dapil in one pass: its valid votes, one party's votes, the leading party, and the
 * voter roll. With a single MAX in the query SQLite takes the bare `partai_id` from the row that holds the
 * maximum, which is the leading party; equal votes give either of them.
 */
export async function readKelurahanStandings(db: D1Database, tingkat: Tingkat, kodeDapil: number, partyId: number) {
    const level = TINGKAT[tingkat];
    const [dapil, kecamatan, kelurahan, partyVotes, partyAreas] = await db.batch([
        db.prepare(DAPIL).bind(level, kodeDapil),
        db
            .prepare('SELECT kode_kecamatan, nama_kecamatan FROM dapil_kecamatan WHERE tingkat = ? AND kode_dapil = ?')
            .bind(level, kodeDapil),
        db
            .prepare(
                `SELECT k.kode_kelurahan AS kode_kelurahan,
                        SUM(k.suara) AS total,
                        SUM(CASE WHEN k.partai_id = ? THEN k.suara ELSE 0 END) AS partai,
                        MAX(k.suara) AS suara_unggul,
                        k.partai_id AS partai_unggul,
                        d.nama_kelurahan AS nama_kelurahan,
                        d.dpt AS dpt,
                        d.usia_kurang21 + d.usia_u21_25 + d.usia_u26_30 AS di_bawah_30
                 FROM kelurahan_suara_partai k
                 LEFT JOIN kelurahan_dpt d ON d.kode_kelurahan = k.kode_kelurahan
                 WHERE k.tingkat = ? AND k.kode_dapil = ?
                 GROUP BY k.kode_kelurahan`,
            )
            .bind(partyId, level, kodeDapil),
        ...partySpread(db, level, kodeDapil),
    ]);
    return {
        dapil: rows<DapilName>(dapil)[0] ?? null,
        partyVotes: rows<PartyTotalRecord>(partyVotes),
        partyAreas: rows<PartyTotalRecord>(partyAreas),
        kecamatan: new Map(
            rows<{ kode_kecamatan: string; nama_kecamatan: string }>(kecamatan).map((row) => [
                row.kode_kecamatan,
                row.nama_kecamatan,
            ]),
        ),
        kelurahan: rows<KelurahanStandingRecord>(kelurahan),
    };
}

export interface DapilDptBand {
    kode_kecamatan: string;
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

const DPT_SUMS = `SUM(dpt) AS dpt, SUM(dpt_l) AS dpt_l, SUM(dpt_p) AS dpt_p,
    SUM(usia_kurang21) AS usia_kurang21, SUM(usia_u21_25) AS usia_u21_25, SUM(usia_u26_30) AS usia_u26_30,
    SUM(usia_u31_40) AS usia_u31_40, SUM(usia_u41_50) AS usia_u41_50, SUM(usia_u51_55) AS usia_u51_55,
    SUM(usia_lebih55) AS usia_lebih55`;

// Two binds per range, and D1 allows 100 bound parameters on one statement.
const RANGE_CHUNK = 40;

// Kelurahan that vote in another dapil sharing a kecamatan, and not in this one. A scan of
// `kode_dapil <> ?` across the vote table does not use the primary key, so this stays on the
// kecamatan index and one key range per other dapil.
// CROSS JOIN fixes that order: left to itself the planner starts from the vote table and reads a whole level.
const EXCLUDED_KELURAHAN = `
SELECT DISTINCT k.kode_kelurahan
FROM dapil_kecamatan mine
CROSS JOIN dapil_kecamatan other
  ON other.tingkat = mine.tingkat AND other.kode_kecamatan = mine.kode_kecamatan AND other.kode_dapil <> mine.kode_dapil
CROSS JOIN kelurahan_suara_partai k
  ON k.tingkat = other.tingkat AND k.kode_dapil = other.kode_dapil
 AND k.kode_kelurahan BETWEEN CAST(mine.kode_kecamatan AS INTEGER) * ${KELURAHAN_PER_KECAMATAN}
                        AND CAST(mine.kode_kecamatan AS INTEGER) * ${KELURAHAN_PER_KECAMATAN} + ${KELURAHAN_PER_KECAMATAN - 1}
WHERE mine.tingkat = ? AND mine.kode_dapil = ?
  AND mine.kode_kecamatan GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'
  AND NOT EXISTS (
    SELECT 1 FROM kelurahan_suara_partai here
    WHERE here.tingkat = mine.tingkat AND here.kode_dapil = mine.kode_dapil AND here.kode_kelurahan = k.kode_kelurahan
  )`;

// Kelurahan of a kecamatan this dapil shares with another, with votes in none of the dapil that hold
// it. Nothing says which dapil such a kelurahan votes in, so it is counted for none of them.
const UNPLACED_KELURAHAN = `
SELECT r.kode_kelurahan AS kode_kelurahan, r.dpt AS dpt
FROM dapil_kecamatan mine
CROSS JOIN kelurahan_dpt r
  ON r.kode_kelurahan BETWEEN CAST(mine.kode_kecamatan AS INTEGER) * ${KELURAHAN_PER_KECAMATAN}
                        AND CAST(mine.kode_kecamatan AS INTEGER) * ${KELURAHAN_PER_KECAMATAN} + ${KELURAHAN_PER_KECAMATAN - 1}
WHERE mine.tingkat = ? AND mine.kode_dapil = ?
  AND mine.kode_kecamatan GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'
  AND EXISTS (
    SELECT 1 FROM dapil_kecamatan other
    WHERE other.tingkat = mine.tingkat AND other.kode_kecamatan = mine.kode_kecamatan AND other.kode_dapil <> mine.kode_dapil
  )
  AND NOT EXISTS (
    SELECT 1 FROM dapil_kecamatan holder
    CROSS JOIN kelurahan_suara_partai k
      ON k.tingkat = holder.tingkat AND k.kode_dapil = holder.kode_dapil AND k.kode_kelurahan = r.kode_kelurahan
    WHERE holder.tingkat = mine.tingkat AND holder.kode_kecamatan = mine.kode_kecamatan
  )`;

// The same for one kecamatan, by its range of kelurahan codes.
const UNPLACED_IN_RANGE = `
SELECT r.kode_kelurahan AS kode_kelurahan
FROM kelurahan_dpt r
WHERE r.kode_kelurahan BETWEEN ? AND ?
  AND NOT EXISTS (
    SELECT 1 FROM dapil_kecamatan holder
    CROSS JOIN kelurahan_suara_partai k
      ON k.tingkat = holder.tingkat AND k.kode_dapil = holder.kode_dapil AND k.kode_kelurahan = r.kode_kelurahan
    WHERE holder.tingkat = ? AND holder.kode_kecamatan = ?
  )`;

const DPT_COLUMNS = [
    'dpt',
    'dpt_l',
    'dpt_p',
    'usia_kurang21',
    'usia_u21_25',
    'usia_u26_30',
    'usia_u31_40',
    'usia_u41_50',
    'usia_u51_55',
    'usia_lebih55',
] as const;

function chunk<T>(items: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

function rangeSum(db: D1Database, ranges: readonly (readonly [number, number])[]) {
    const where = ranges.map(() => 'kode_kelurahan BETWEEN ? AND ?').join(' OR ');
    return db
        .prepare(
            `SELECT printf('%06d', kode_kelurahan / ${KELURAHAN_PER_KECAMATAN}) AS kode_kecamatan, ${DPT_SUMS}
             FROM kelurahan_dpt WHERE ${where} GROUP BY 1`,
        )
        .bind(...ranges.flat());
}

async function subtractExcluded(db: D1Database, bands: Map<string, DapilDptBand>, codes: readonly number[]) {
    const fetched = await db.batch(
        chunk(codes, 90).map((group) => {
            const marks = group.map(() => '?').join(', ');
            return db
                .prepare(
                    `SELECT kode_kelurahan, ${DPT_COLUMNS.join(', ')} FROM kelurahan_dpt WHERE kode_kelurahan IN (${marks})`,
                )
                .bind(...group);
        }),
    );
    for (const result of fetched) {
        for (const row of rows<Pick<DptRecord, 'kode_kelurahan' | (typeof DPT_COLUMNS)[number]>>(result)) {
            const code = String(Math.floor(row.kode_kelurahan / KELURAHAN_PER_KECAMATAN)).padStart(6, '0');
            const band = bands.get(code);
            if (band === undefined) {
                continue;
            }
            for (const column of DPT_COLUMNS) {
                band[column] -= row[column];
            }
        }
    }
}

const KELURAHAN_PER_PROVINCE = 100_000_000;

export type VoterRoll = Omit<DapilDptBand, 'kode_kecamatan'>;

export interface AreaRoll {
    kode: string;
    dpt: number;
    di_bawah_30: number;
}

function under30Of(roll: Pick<VoterRoll, 'usia_kurang21' | 'usia_u21_25' | 'usia_u26_30'>) {
    return roll.usia_kurang21 + roll.usia_u21_25 + roll.usia_u26_30;
}

function asAreaRoll(kode: string, roll: VoterRoll): AreaRoll {
    return { kode, dpt: roll.dpt, di_bawah_30: under30Of(roll) };
}

/** Registered voters of every province. A kelurahan code starts with its two-digit province code. */
export async function readProvinceRolls(db: D1Database): Promise<AreaRoll[]> {
    const [result] = await db.batch([
        db.prepare(
            `SELECT printf('%02d', kode_kelurahan / ${KELURAHAN_PER_PROVINCE}) AS kode, ${DPT_SUMS}
             FROM kelurahan_dpt GROUP BY 1`,
        ),
    ]);

    return rows<VoterRoll & { dpt: number | null; kode: string }>(result).flatMap((row) =>
        row.dpt === null || row.dpt <= 0 ? [] : [asAreaRoll(row.kode, row)],
    );
}

/** Registered voters of the whole country. */
export async function readNationalDpt(db: D1Database): Promise<VoterRoll | null> {
    const [result] = await db.batch([db.prepare(`SELECT ${DPT_SUMS} FROM kelurahan_dpt`)]);
    const roll = rows<VoterRoll & { dpt: number | null }>(result)[0];

    if (roll === undefined || roll.dpt === null) {
        return null;
    }

    return roll;
}

const DAPIL_IN_PROVINCE = `
SELECT d.kode_dapil, k.kode_kecamatan
FROM dapil d
JOIN dapil_kecamatan k ON k.tingkat = d.tingkat AND k.kode_dapil = d.kode_dapil
WHERE d.tingkat = ? AND d.kode_provinsi = ?`;

// A kecamatan of this province that another dapil also holds. The other dapil may lie outside the province.
const SHARED_KECAMATAN = `
SELECT DISTINCT mine.kode_kecamatan
FROM dapil_kecamatan mine
JOIN dapil_kecamatan other
  ON other.tingkat = mine.tingkat AND other.kode_kecamatan = mine.kode_kecamatan AND other.kode_dapil <> mine.kode_dapil
WHERE mine.tingkat = ? AND mine.kode_dapil IN (
  SELECT kode_dapil FROM dapil WHERE tingkat = ? AND kode_provinsi = ?
)`;

// Kelurahan of one kecamatan that vote in another dapil and not in this one.
const ELSEWHERE_IN_RANGE = `
SELECT DISTINCT k.kode_kelurahan
FROM dapil_kecamatan other
JOIN kelurahan_suara_partai k
  ON k.tingkat = other.tingkat AND k.kode_dapil = other.kode_dapil AND k.kode_kelurahan BETWEEN ? AND ?
WHERE other.tingkat = ? AND other.kode_kecamatan = ? AND other.kode_dapil <> ?
  AND NOT EXISTS (
    SELECT 1 FROM kelurahan_suara_partai here
    WHERE here.tingkat = ? AND here.kode_dapil = ? AND here.kode_kelurahan = k.kode_kelurahan
  )`;

function addRoll(totals: Map<number, VoterRoll>, kodeDapil: number, band: DapilDptBand) {
    const total = totals.get(kodeDapil);

    if (total === undefined) {
        totals.set(kodeDapil, { ...band });
        return;
    }

    for (const column of DPT_COLUMNS) {
        total[column] += band[column];
    }
}

function subtractRoll(band: DapilDptBand, row: Pick<VoterRoll, (typeof DPT_COLUMNS)[number]>) {
    for (const column of DPT_COLUMNS) {
        band[column] -= row[column];
    }
}

interface SplitKecamatan {
    band: DapilDptBand;
    dapil: number;
    range: readonly [number, number];
}

async function assignSplitKecamatan(
    db: D1Database,
    level: number,
    totals: Map<number, VoterRoll>,
    splits: readonly SplitKecamatan[],
) {
    const excluded = await db.batch(
        splits.map((split) =>
            db
                .prepare(ELSEWHERE_IN_RANGE)
                .bind(...split.range, level, split.band.kode_kecamatan, split.dapil, level, split.dapil),
        ),
    );
    const unplaced = await db.batch(
        splits.map((split) => db.prepare(UNPLACED_IN_RANGE).bind(...split.range, level, split.band.kode_kecamatan)),
    );
    const jobs = splits.map((split, index) => ({
        codes: rows<{ kode_kelurahan: number }>(excluded[index]).map((row) => row.kode_kelurahan),
        isIncomplete: rows(unplaced[index]).length > 0,
        split,
    }));
    // A dapil whose shared kecamatan holds voters that belong to no dapil has no roll to report.
    const incomplete = new Set(jobs.filter((job) => job.isIncomplete).map((job) => job.split.dapil));
    const codes = [...new Set(jobs.flatMap((job) => job.codes))];
    const rolls = new Map<number, VoterRoll>();

    if (codes.length > 0) {
        const fetched = await db.batch(
            chunk(codes, 90).map((group) => {
                const marks = group.map(() => '?').join(', ');
                return db
                    .prepare(
                        `SELECT kode_kelurahan, ${DPT_COLUMNS.join(', ')} FROM kelurahan_dpt WHERE kode_kelurahan IN (${marks})`,
                    )
                    .bind(...group);
            }),
        );

        for (const result of fetched) {
            for (const row of rows<Pick<DptRecord, 'kode_kelurahan' | (typeof DPT_COLUMNS)[number]>>(result)) {
                rolls.set(row.kode_kelurahan, row);
            }
        }
    }

    for (const job of jobs) {
        const band = { ...job.split.band };

        for (const code of job.codes) {
            const row = rolls.get(code);

            if (row !== undefined) {
                subtractRoll(band, row);
            }
        }

        if (band.dpt > 0) {
            addRoll(totals, job.split.dapil, band);
        }
    }
    return incomplete;
}

/** Registered voters of each dapil in a province: the total and how many are under 30. */
export async function readDapilRolls(db: D1Database, tingkat: Tingkat, kodeProvinsi: number): Promise<AreaRoll[]> {
    const level = TINGKAT[tingkat];
    const [membershipResult, sharedResult] = await db.batch([
        db.prepare(DAPIL_IN_PROVINCE).bind(level, kodeProvinsi),
        db.prepare(SHARED_KECAMATAN).bind(level, level, kodeProvinsi),
    ]);
    const shared = new Set(rows<{ kode_kecamatan: string }>(sharedResult).map((row) => row.kode_kecamatan));
    const holders = new Map<string, number[]>();

    for (const row of rows<{ kode_dapil: number; kode_kecamatan: string }>(membershipResult)) {
        if (kelurahanRange(row.kode_kecamatan) === null) {
            continue;
        }

        holders.set(row.kode_kecamatan, [...(holders.get(row.kode_kecamatan) ?? []), row.kode_dapil]);
    }

    const ranges = [...holders.keys()].flatMap((code) => {
        const range = kelurahanRange(code);
        return range === null ? [] : [range];
    });

    if (ranges.length === 0) {
        return [];
    }

    const summed = await db.batch(chunk(ranges, RANGE_CHUNK).map((group) => rangeSum(db, group)));
    const bands = new Map<string, DapilDptBand>();

    for (const result of summed) {
        for (const band of rows<DapilDptBand>(result)) {
            bands.set(band.kode_kecamatan, band);
        }
    }

    const totals = new Map<number, VoterRoll>();
    const splits: SplitKecamatan[] = [];

    for (const [kecamatan, dapils] of holders) {
        const band = bands.get(kecamatan);
        const range = kelurahanRange(kecamatan);

        if (band === undefined || band.dpt <= 0 || range === null) {
            continue;
        }

        const onlyDapil = dapils[0];

        if (!shared.has(kecamatan) && dapils.length === 1 && onlyDapil !== undefined) {
            addRoll(totals, onlyDapil, band);
            continue;
        }

        for (const dapil of dapils) {
            splits.push({ band, dapil, range });
        }
    }

    const incomplete = splits.length > 0 ? await assignSplitKecamatan(db, level, totals, splits) : new Set<number>();

    return [...totals]
        .flatMap(([kode, roll]) => (roll.dpt > 0 && !incomplete.has(kode) ? [asAreaRoll(String(kode), roll)] : []))
        .sort((left, right) => left.kode.localeCompare(right.kode));
}

/** Registered voters of one province. A kelurahan code starts with its two-digit province code. */
export async function readProvinceDpt(db: D1Database, kodeProvinsi: number): Promise<VoterRoll | null> {
    const first = kodeProvinsi * KELURAHAN_PER_PROVINCE;
    const [result] = await db.batch([
        db
            .prepare(`SELECT ${DPT_SUMS} FROM kelurahan_dpt WHERE kode_kelurahan BETWEEN ? AND ?`)
            .bind(first, first + KELURAHAN_PER_PROVINCE - 1),
    ]);
    const roll = rows<VoterRoll & { dpt: number | null }>(result)[0];
    if (roll === undefined || roll.dpt === null) {
        return null;
    }
    return roll;
}

/** Registered voters of a dapil, summed per kecamatan from the kelurahan roll. */
export async function readDapilDpt(db: D1Database, tingkat: Tingkat, kodeDapil: number) {
    const level = TINGKAT[tingkat];
    const [dapilResult, kecamatanResult] = await db.batch([
        db.prepare(DAPIL).bind(level, kodeDapil),
        db
            .prepare('SELECT kode_kecamatan FROM dapil_kecamatan WHERE tingkat = ? AND kode_dapil = ?')
            .bind(level, kodeDapil),
    ]);
    const dapil = rows<DapilName>(dapilResult)[0] ?? null;
    const ranges = rows<{ kode_kecamatan: string }>(kecamatanResult).flatMap((row) => {
        const range = kelurahanRange(row.kode_kecamatan);
        return range === null ? [] : [range];
    });
    if (ranges.length === 0) {
        return { dapil, bands: [] as DapilDptBand[], unplaced: { kelurahan: 0, dpt: 0 } };
    }

    const results = await db.batch([
        ...chunk(ranges, RANGE_CHUNK).map((group) => rangeSum(db, group)),
        db.prepare(EXCLUDED_KELURAHAN).bind(level, kodeDapil),
        db.prepare(UNPLACED_KELURAHAN).bind(level, kodeDapil),
    ]);
    const bands = new Map<string, DapilDptBand>();
    for (const result of results.slice(0, -2)) {
        for (const band of rows<DapilDptBand>(result)) {
            bands.set(band.kode_kecamatan, band);
        }
    }
    const elsewhere = rows<{ kode_kelurahan: number }>(results.at(-2)).map((row) => row.kode_kelurahan);
    const unplaced = rows<{ kode_kelurahan: number; dpt: number }>(results.at(-1));
    const excluded = [...elsewhere, ...unplaced.map((row) => row.kode_kelurahan)];
    if (excluded.length > 0) {
        await subtractExcluded(db, bands, excluded);
    }
    return {
        dapil,
        /** Voters of a shared kecamatan that could be given to no dapil. Above zero, the roll is incomplete. */
        unplaced: { kelurahan: unplaced.length, dpt: unplaced.reduce((sum, row) => sum + row.dpt, 0) },
        bands: [...bands.values()]
            .filter((band) => band.dpt > 0)
            .sort((left, right) => left.kode_kecamatan.localeCompare(right.kode_kecamatan)),
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
        ...partySpread(db, level, kodeDapil),
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
    const [dapil, holders, kecamatan, partyVotes, partyAreas, votes, dpt, elsewhere] = await db.batch(statements);
    return {
        dapil: rows<DapilName>(dapil)[0] ?? null,
        /** Null when the kecamatan is not part of this dapil. */
        namaKecamatan: rows<{ nama_kecamatan: string }>(kecamatan)[0]?.nama_kecamatan ?? null,
        holders: rows<{ kode_dapil: number }>(holders).map((row) => row.kode_dapil),
        partyVotes: rows<PartyTotalRecord>(partyVotes),
        partyAreas: rows<PartyTotalRecord>(partyAreas),
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

export interface CandidateAreaTotal {
    partai_id: number;
    nomor_urut: number;
    suara: number;
}

/**
 * Every candidate's votes summed over the areas of a dapil: its kelurahan, or its kecamatan for
 * dprd_provinsi. For holding against the dapil totals; see `checkSpread`.
 */
export function candidateAreaTotals(db: D1Database, tingkat: Tingkat, kodeDapil: number): D1PreparedStatement {
    if (tingkat === 'dprd_provinsi') {
        return db
            .prepare(
                'SELECT partai_id, nomor_urut, SUM(suara) AS suara FROM kecamatan_suara_caleg WHERE kode_dapil = ? GROUP BY partai_id, nomor_urut',
            )
            .bind(kodeDapil);
    }
    return db
        .prepare(
            'SELECT partai_id, nomor_urut, SUM(suara) AS suara FROM kelurahan_suara_caleg WHERE tingkat = ? AND kode_dapil = ? GROUP BY partai_id, nomor_urut',
        )
        .bind(TINGKAT[tingkat], kodeDapil);
}

export async function readCandidateAreaTotals(db: D1Database, tingkat: Tingkat, kodeDapil: number) {
    const [totals] = await db.batch([candidateAreaTotals(db, tingkat, kodeDapil)]);
    return rows<CandidateAreaTotal>(totals);
}

export interface CandidateAreaRecord {
    kode: number;
    /** The candidate's votes there; zero when others have rows there and the candidate has none. */
    suara: number;
}

export interface ListedCandidate {
    partai_id: number;
    nomor_urut: number;
    nama: string;
    jenis_kelamin: string | null;
    suara: number;
    kursi_ke: number;
}

export interface CandidateIdentity {
    partyId: number;
    nomorUrut: number;
}

// Only candidates with votes have a row, so an area is known to be counted by anyone's row in it.
const CANDIDATE_SUM = 'SUM(CASE WHEN partai_id = ? AND nomor_urut = ? THEN suara ELSE 0 END) AS suara';

function candidateAreas(
    db: D1Database,
    tingkat: Tingkat,
    kodeDapil: number,
    { partyId, nomorUrut }: CandidateIdentity,
    range: [number, number] | null,
): D1PreparedStatement {
    if (tingkat === 'dprd_provinsi') {
        return db
            .prepare(
                `SELECT kode_kecamatan AS kode, ${CANDIDATE_SUM} FROM kecamatan_suara_caleg WHERE kode_dapil = ? GROUP BY kode_kecamatan`,
            )
            .bind(partyId, nomorUrut, kodeDapil);
    }
    if (range === null) {
        return db
            .prepare(
                `SELECT kode_kelurahan / ${KELURAHAN_PER_KECAMATAN} AS kode, ${CANDIDATE_SUM} FROM kelurahan_suara_caleg WHERE tingkat = ? AND kode_dapil = ? GROUP BY 1`,
            )
            .bind(partyId, nomorUrut, TINGKAT[tingkat], kodeDapil);
    }
    return db
        .prepare(
            `SELECT kode_kelurahan AS kode, ${CANDIDATE_SUM} FROM kelurahan_suara_caleg WHERE tingkat = ? AND kode_dapil = ? AND kode_kelurahan BETWEEN ? AND ? GROUP BY kode_kelurahan`,
        )
        .bind(partyId, nomorUrut, TINGKAT[tingkat], kodeDapil, ...range);
}

function partyAreas(
    db: D1Database,
    tingkat: Tingkat,
    kodeDapil: number,
    partyId: number,
    range: [number, number] | null,
): D1PreparedStatement {
    const level = TINGKAT[tingkat];
    if (range === null) {
        return db
            .prepare(
                `SELECT kode_kelurahan / ${KELURAHAN_PER_KECAMATAN} AS kode, SUM(CASE WHEN partai_id = ? THEN suara ELSE 0 END) AS suara FROM kelurahan_suara_partai WHERE tingkat = ? AND kode_dapil = ? GROUP BY 1`,
            )
            .bind(partyId, level, kodeDapil);
    }
    return db
        .prepare(
            'SELECT kode_kelurahan AS kode, SUM(CASE WHEN partai_id = ? THEN suara ELSE 0 END) AS suara FROM kelurahan_suara_partai WHERE tingkat = ? AND kode_dapil = ? AND kode_kelurahan BETWEEN ? AND ? GROUP BY kode_kelurahan',
        )
        .bind(partyId, level, kodeDapil, ...range);
}

/**
 * One candidate's votes in every kecamatan of the dapil, or in the kelurahan of one kecamatan, beside the
 * votes of the candidate's party there. With every candidate's area total, to check the dapil first.
 */
export async function readCandidateAreas(
    db: D1Database,
    tingkat: Tingkat,
    kodeDapil: number,
    candidate: CandidateIdentity,
    kodeKecamatan: string | null,
) {
    const level = TINGKAT[tingkat];
    const range = kodeKecamatan === null ? null : kelurahanRange(kodeKecamatan);
    // An overseas kecamatan has no kelurahan: a range that holds nothing keeps the statements the same.
    const within: [number, number] | null = kodeKecamatan === null ? null : (range ?? [-1, -1]);
    const [dapil, kecamatan, everyone, totals, own, party, names, wholeParty, wholePartyAreas] = await db.batch([
        db.prepare(DAPIL).bind(level, kodeDapil),
        db
            .prepare(
                'SELECT kode_kecamatan, nama_kecamatan FROM dapil_kecamatan WHERE tingkat = ? AND kode_dapil = ? ORDER BY kode_kecamatan',
            )
            .bind(level, kodeDapil),
        // Everyone on the dapil's list: the check holds every candidate's area votes against these.
        db
            .prepare(
                'SELECT partai_id, nomor_urut, nama, jenis_kelamin, suara, kursi_ke FROM caleg WHERE tingkat = ? AND kode_dapil = ?',
            )
            .bind(level, kodeDapil),
        candidateAreaTotals(db, tingkat, kodeDapil),
        candidateAreas(db, tingkat, kodeDapil, candidate, within),
        partyAreas(db, tingkat, kodeDapil, candidate.partyId, within),
        db
            .prepare('SELECT kode_kelurahan, nama_kelurahan FROM kelurahan_dpt WHERE kode_kelurahan BETWEEN ? AND ?')
            .bind(...(within ?? [-1, -1])),
        ...partySpread(db, level, kodeDapil),
    ]);
    return {
        dapil: rows<DapilName>(dapil)[0] ?? null,
        kecamatan: rows<{ kode_kecamatan: string; nama_kecamatan: string }>(kecamatan),
        candidates: rows<ListedCandidate>(everyone),
        areaTotals: rows<CandidateAreaTotal>(totals),
        candidateVotes: rows<CandidateAreaRecord>(own),
        partyVotes: rows<CandidateAreaRecord>(party),
        kelurahanNames: rows<{ kode_kelurahan: number; nama_kelurahan: string }>(names),
        dapilPartyVotes: rows<PartyTotalRecord>(wholeParty),
        dapilPartyAreas: rows<PartyTotalRecord>(wholePartyAreas),
    };
}
