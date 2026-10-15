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

export interface PartyTotal {
    partai_id: number;
    suara: number;
}

/** The same check for party votes, which reach kelurahan at every level. */
export interface PartySpreadCheck {
    status: SpreadStatus;
    suara_dapil: number;
    suara_wilayah: number;
    /** Votes the kelurahan give parties above their own dapil totals, summed over the parties. */
    kelebihan: number;
    persen_kelebihan: number | null;
    batas_persen: number;
}

/**
 * Party votes per kelurahan are repeated in places too: in 58 dprd_provinsi dapil every kelurahan carries
 * exactly double. Each party's votes summed over the kelurahan of the dapil are held against its dapil total,
 * by the rule of `checkSpread`.
 */
export function checkPartySpread(
    dapilVotes: readonly PartyTotal[],
    areaTotals: readonly PartyTotal[],
): PartySpreadCheck {
    const inAreas = new Map(areaTotals.map((row) => [row.partai_id, row.suara]));
    let dapil = 0;
    let excess = 0;
    for (const row of dapilVotes) {
        dapil += row.suara;
        excess += Math.max(0, (inAreas.get(row.partai_id) ?? 0) - row.suara);
        inAreas.delete(row.partai_id);
    }
    for (const votes of inAreas.values()) {
        excess += votes;
    }
    const areas = areaTotals.reduce((sum, row) => sum + row.suara, 0);
    const checkable = dapil > 0 && areas > 0;
    let status: SpreadStatus = 'tidak_tersedia';
    if (checkable) {
        status = excess <= dapil * SPREAD_TOLERANCE ? 'sesuai' : 'tidak_sesuai';
    }
    return {
        status,
        suara_dapil: dapil,
        suara_wilayah: areas,
        kelebihan: excess,
        persen_kelebihan: checkable ? round2((excess / dapil) * 100) : null,
        batas_persen: SPREAD_TOLERANCE * 100,
    };
}

export interface HolderTotal extends PartyTotal {
    kode_dapil: number;
}

/**
 * The kecamatan to leave out at one level: those held there by a dapil whose kelurahan repeat party votes.
 * `kecamatan` says which dapil of the level holds each kecamatan, the other two are the sides of the check
 * for those dapil.
 */
export function withheldKecamatan(
    kecamatan: readonly { kode_kecamatan: string; kode_dapil: number }[],
    dapilVotes: readonly HolderTotal[],
    areaVotes: readonly HolderTotal[],
): Set<string> {
    const byDapil = (rows: readonly HolderTotal[]) => {
        const groups = new Map<number, HolderTotal[]>();
        for (const row of rows) {
            groups.set(row.kode_dapil, [...(groups.get(row.kode_dapil) ?? []), row]);
        }
        return groups;
    };
    const inDapil = byDapil(dapilVotes);
    const inAreas = byDapil(areaVotes);
    const failing = new Set(
        [...inAreas.keys()].filter(
            (kode) => checkPartySpread(inDapil.get(kode) ?? [], inAreas.get(kode) ?? []).status === 'tidak_sesuai',
        ),
    );
    return new Set(kecamatan.filter((row) => failing.has(row.kode_dapil)).map((row) => row.kode_kecamatan));
}

/** One count of an area: a kecamatan for the kecamatan sources, a kelurahan summed up to its kecamatan otherwise. */
export interface AreaVote {
    kode: number;
    partai_id: number;
    nomor_urut: number;
    suara: number;
}

/**
 * Where a dapil's candidate votes below dapil level come from. The kelurahan tables of some dapil hold a
 * fraction of the votes and the kecamatan counts hold more, or the other way round, or one of them repeats
 * votes; so the kelurahan and kecamatan counts are tried together (the larger of the two for each candidate in
 * each kecamatan), then each alone, and the first that passes `checkSpread` is used.
 */
export type AreaSource = 'gabungan' | 'kelurahan' | 'kecamatan';

export interface ChosenAreas {
    source: AreaSource;
    votes: AreaVote[];
}

const areaKey = (row: AreaVote) => `${row.kode}:${row.partai_id}:${row.nomor_urut}`;

function larger(first: readonly AreaVote[], second: readonly AreaVote[]): AreaVote[] {
    const merged = new Map(first.map((row) => [areaKey(row), row]));
    for (const row of second) {
        const known = merged.get(areaKey(row));
        if (known === undefined || known.suara < row.suara) {
            merged.set(areaKey(row), row);
        }
    }
    return [...merged.values()];
}

export const candidateTotalsOf = (votes: readonly AreaVote[]): CandidateTotal[] => {
    const totals = new Map<string, CandidateTotal>();
    for (const row of votes) {
        const key = `${row.partai_id}:${row.nomor_urut}`;
        const known = totals.get(key);
        if (known === undefined) {
            totals.set(key, { partai_id: row.partai_id, nomor_urut: row.nomor_urut, suara: row.suara });
        } else {
            known.suara += row.suara;
        }
    }
    return [...totals.values()];
};

export function chooseAreas(
    tingkat: Tingkat,
    candidates: readonly CandidateTotal[],
    kelurahan: readonly AreaVote[],
    kecamatan: readonly AreaVote[],
): ChosenAreas {
    if (kecamatan.length === 0) {
        return { source: 'kelurahan', votes: [...kelurahan] };
    }
    const options: ChosenAreas[] = [
        { source: 'gabungan', votes: larger(kelurahan, kecamatan) },
        { source: 'kelurahan', votes: [...kelurahan] },
        { source: 'kecamatan', votes: [...kecamatan] },
    ];
    const passing = options.find(
        (option) => checkSpread(tingkat, candidates, candidateTotalsOf(option.votes)).status === 'sesuai',
    );
    // None passes: the kelurahan counts stay, flagged as they were before the kecamatan counts were read.
    return passing ?? { source: 'kelurahan', votes: [...kelurahan] };
}
