import { round2 } from '../calc';
import type { Tingkat } from '../tingkat';

/**
 * Candidate votes below dapil level come from another count than the dapil totals, and in some dapil the
 * source repeats them: every kelurahan of ACEH I carries close to double its votes. A candidate cannot have
 * polled more inside the dapil than in the dapil, so the votes above a candidate's own total are the measure.
 */
export type SpreadStatus = 'sesuai' | 'tidak_sesuai' | 'tidak_tersedia';

/** Excess votes tolerated, as a share: the two counts differ by a few votes in most dapil without being wrong. */
export const SPREAD_TOLERANCE = 0.01;

export interface CandidateTotal {
    partai_id: number;
    nomor_urut: number;
    suara: number;
}

export interface SpreadCheck {
    status: SpreadStatus;
    /** The depth candidate votes reach at this level. */
    tingkat_wilayah: 'kelurahan' | 'kecamatan';
    suara_caleg_dapil: number;
    suara_caleg_wilayah: number;
    /** Votes the areas give candidates above their own dapil totals, summed over the candidates. */
    kelebihan: number;
    persen_kelebihan: number | null;
    batas_persen: number;
}

const keyOf = (row: Pick<CandidateTotal, 'partai_id' | 'nomor_urut'>) => `${row.partai_id}:${row.nomor_urut}`;

export const areaDepth = (tingkat: Tingkat) => (tingkat === 'dprd_provinsi' ? 'kecamatan' : 'kelurahan');

/** Votes one candidate may have in the areas before they count as repeated. */
export const toleratedVotes = (dapilVotes: number) => dapilVotes + Math.ceil(dapilVotes * SPREAD_TOLERANCE);

/**
 * Sets every candidate's votes summed over the areas of a dapil against the dapil totals. Fewer votes in the
 * areas is a gap in the data and passes; more is the fault looked for. Without area rows, or without dapil
 * totals to hold them against, nothing can be said.
 */
export function checkSpread(
    tingkat: Tingkat,
    candidates: readonly CandidateTotal[],
    areaTotals: readonly CandidateTotal[],
): SpreadCheck {
    const inAreas = new Map(areaTotals.map((row) => [keyOf(row), row.suara]));
    let dapilVotes = 0;
    let excess = 0;
    for (const row of candidates) {
        dapilVotes += row.suara;
        excess += Math.max(0, (inAreas.get(keyOf(row)) ?? 0) - row.suara);
        inAreas.delete(keyOf(row));
    }
    // What is left belongs to nobody on the dapil's list, so all of it is excess.
    for (const votes of inAreas.values()) {
        excess += votes;
    }
    const areaVotes = areaTotals.reduce((sum, row) => sum + row.suara, 0);
    const checkable = dapilVotes > 0 && areaVotes > 0;
    let status: SpreadStatus = 'tidak_tersedia';
    if (checkable) {
        status = excess <= dapilVotes * SPREAD_TOLERANCE ? 'sesuai' : 'tidak_sesuai';
    }
    return {
        status,
        tingkat_wilayah: areaDepth(tingkat),
        suara_caleg_dapil: dapilVotes,
        suara_caleg_wilayah: areaVotes,
        kelebihan: excess,
        persen_kelebihan: checkable ? round2((excess / dapilVotes) * 100) : null,
        batas_persen: SPREAD_TOLERANCE * 100,
    };
}
