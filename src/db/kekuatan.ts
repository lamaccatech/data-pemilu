import { TINGKAT, type Tingkat } from '../tingkat';

export interface VoteSplit {
    dapil_tanpa_pecahan: number;
    suara_caleg: number;
    suara_gambar: number;
    suara_terbagi: number;
}

export interface SettlementSplit {
    belum_terpetakan: number;
    kabupaten: number;
    kota: number;
}

// 2024 stores the province on the dapil. 2019 DPR RI codes start with it; the other 2019 levels do not.
export type ProvinceScope = { match: 'column' | 'prefix'; code: number } | null;

const EMPTY_SPLIT: VoteSplit = { dapil_tanpa_pecahan: 0, suara_caleg: 0, suara_gambar: 0, suara_terbagi: 0 };

function provinceSql(scope: ProvinceScope) {
    if (scope === null) {
        return { args: [] as number[], sql: '' };
    }

    const column = scope.match === 'column' ? 'd.kode_provinsi' : 'd.kode_dapil / 100';

    return { args: [scope.code], sql: ` AND ${column} = ?` };
}

// A dapil whose candidate votes are missing, or exceed the party's votes, has no symbol split.
// The same rule as one dapil: the extra is not a real personal vote.
const SPLIT_SQL = `
SELECT
    COALESCE(SUM(CASE WHEN p.suara_caleg > 0 AND p.suara_caleg <= s.suara THEN s.suara - p.suara_caleg ELSE 0 END), 0) AS suara_gambar,
    COALESCE(SUM(CASE WHEN p.suara_caleg > 0 AND p.suara_caleg <= s.suara THEN p.suara_caleg ELSE 0 END), 0) AS suara_caleg,
    COALESCE(SUM(CASE WHEN p.suara_caleg > 0 AND p.suara_caleg <= s.suara THEN s.suara ELSE 0 END), 0) AS suara_terbagi,
    COALESCE(SUM(CASE WHEN p.suara_caleg IS NULL OR p.suara_caleg <= 0 OR p.suara_caleg > s.suara THEN 1 ELSE 0 END), 0) AS dapil_tanpa_pecahan
FROM suara_partai s
JOIN dapil d ON d.tingkat = s.tingkat AND d.kode_dapil = s.kode_dapil
LEFT JOIN (
    SELECT kode_dapil, SUM(suara) AS suara_caleg
    FROM caleg
    WHERE tingkat = ? AND partai_id = ?
    GROUP BY kode_dapil
) p ON p.kode_dapil = s.kode_dapil
WHERE s.tingkat = ? AND s.partai_id = ? AND s.suara > 0`;

// Kemendagri: the last two digits of a kabupaten code are 71 or higher for a kota. Sabang and
// Singkawang are cities under that rule; Lima Puluh Kota, Kotawaringin and Kotabaru are not.
// A dapil that sits wholly in one kind keeps its full party votes. A dapil that contains both is
// split by kelurahan, and left unmapped when those rows are missing or exceed the dapil.
const SETTLEMENT_SQL = `
WITH kinds AS (
    SELECT kode_dapil,
        CASE
            WHEN SUM(CASE WHEN kode_kecamatan GLOB '[0-9]*' AND CAST(substr(kode_kecamatan, 1, 4) AS INTEGER) % 100 >= 71 THEN 1 ELSE 0 END) > 0
             AND SUM(CASE WHEN kode_kecamatan GLOB '[0-9]*' AND CAST(substr(kode_kecamatan, 1, 4) AS INTEGER) % 100 < 71 THEN 1 ELSE 0 END) = 0
             AND SUM(CASE WHEN kode_kecamatan NOT GLOB '[0-9]*' THEN 1 ELSE 0 END) = 0
            THEN 'kota'
            WHEN SUM(CASE WHEN kode_kecamatan GLOB '[0-9]*' AND CAST(substr(kode_kecamatan, 1, 4) AS INTEGER) % 100 < 71 THEN 1 ELSE 0 END) > 0
             AND SUM(CASE WHEN kode_kecamatan GLOB '[0-9]*' AND CAST(substr(kode_kecamatan, 1, 4) AS INTEGER) % 100 >= 71 THEN 1 ELSE 0 END) = 0
             AND SUM(CASE WHEN kode_kecamatan NOT GLOB '[0-9]*' THEN 1 ELSE 0 END) = 0
            THEN 'kabupaten'
            WHEN SUM(CASE WHEN kode_kecamatan GLOB '[0-9]*' THEN 1 ELSE 0 END) > 0
            THEN 'campuran'
            ELSE 'lain'
        END AS jenis
    FROM dapil_kecamatan
    WHERE tingkat = ?
    GROUP BY kode_dapil
),
kel AS (
    SELECT kode_dapil,
        SUM(CASE WHEN (kode_kelurahan / 1000000) % 100 >= 71 THEN suara ELSE 0 END) AS kota,
        SUM(CASE WHEN (kode_kelurahan / 1000000) % 100 < 71 THEN suara ELSE 0 END) AS kabupaten,
        SUM(suara) AS total
    FROM kelurahan_suara_partai
    WHERE tingkat = ? AND partai_id = ?
    GROUP BY kode_dapil
)
SELECT
    COALESCE(SUM(CASE
        WHEN k.jenis = 'kota' THEN s.suara
        WHEN k.jenis = 'campuran' AND kel.total IS NOT NULL AND kel.total <= s.suara THEN kel.kota
        ELSE 0
    END), 0) AS kota,
    COALESCE(SUM(CASE
        WHEN k.jenis = 'kabupaten' THEN s.suara
        WHEN k.jenis = 'campuran' AND kel.total IS NOT NULL AND kel.total <= s.suara THEN kel.kabupaten
        ELSE 0
    END), 0) AS kabupaten,
    COALESCE(SUM(CASE
        WHEN k.jenis IS NULL OR k.jenis = 'lain' THEN s.suara
        WHEN k.jenis = 'campuran' AND (kel.total IS NULL OR kel.total > s.suara) THEN s.suara
        WHEN k.jenis = 'campuran' THEN s.suara - kel.total
        ELSE 0
    END), 0) AS belum_terpetakan
FROM suara_partai s
JOIN dapil d ON d.tingkat = s.tingkat AND d.kode_dapil = s.kode_dapil
LEFT JOIN kinds k ON k.kode_dapil = s.kode_dapil
LEFT JOIN kel ON kel.kode_dapil = s.kode_dapil
WHERE s.tingkat = ? AND s.partai_id = ? AND s.suara > 0`;

// DPRD kabupaten/kota: each dapil is one kabupaten or one kota, so the dapil code is the split.
const COUNCIL_SQL = `
SELECT
    COALESCE(SUM(CASE WHEN d.kode_kabupaten % 100 >= 71 THEN s.suara ELSE 0 END), 0) AS kota,
    COALESCE(SUM(CASE WHEN d.kode_kabupaten IS NOT NULL AND d.kode_kabupaten % 100 < 71 THEN s.suara ELSE 0 END), 0) AS kabupaten,
    COALESCE(SUM(CASE WHEN d.kode_kabupaten IS NULL THEN s.suara ELSE 0 END), 0) AS belum_terpetakan
FROM suara_partai s
JOIN dapil d ON d.tingkat = s.tingkat AND d.kode_dapil = s.kode_dapil
WHERE s.tingkat = ? AND s.partai_id = ? AND s.suara > 0`;

export async function readVoteSplit(
    db: D1Database,
    tingkat: Tingkat,
    partyId: number,
    scope: ProvinceScope,
): Promise<VoteSplit> {
    const level = TINGKAT[tingkat];
    const province = provinceSql(scope);
    const row = await db
        .prepare(`${SPLIT_SQL}${province.sql}`)
        .bind(level, partyId, level, partyId, ...province.args)
        .first<VoteSplit>();

    return row ?? EMPTY_SPLIT;
}

export async function readSettlementSplit(
    db: D1Database,
    tingkat: Tingkat,
    partyId: number,
    scope: ProvinceScope,
): Promise<SettlementSplit> {
    const level = TINGKAT[tingkat];
    const province = provinceSql(scope);
    const sql = tingkat === 'dprd_kabupaten_kota' ? COUNCIL_SQL : SETTLEMENT_SQL;
    const args =
        tingkat === 'dprd_kabupaten_kota'
            ? [level, partyId, ...province.args]
            : [level, level, partyId, level, partyId, ...province.args];
    const row = await db
        .prepare(`${sql}${province.sql}`)
        .bind(...args)
        .first<SettlementSplit>();

    return row ?? { belum_terpetakan: 0, kabupaten: 0, kota: 0 };
}
