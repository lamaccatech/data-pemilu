import { allocateSeats, countedVotes, round2, type VotesByParty } from '../calc';
import type { KecamatanLevelVotes, KelurahanStandingRecord } from '../db/wilayah';
import { TINGKAT_NAMES, type Tingkat } from '../tingkat';

/** Swings are tried in steps of this many percent. */
const SWING_STEP = 0.1;

/**
 * The votes a party would add by matching, in every kelurahan where it is under it, its own share over the
 * kelurahan of the dapil. The same figure as the total of `ruang-suara`.
 */
export function voteRoom(kelurahan: readonly KelurahanStandingRecord[]): number {
    const counted = kelurahan.filter((row) => row.total > 0);
    const partyVotes = counted.reduce((sum, row) => sum + row.partai, 0);
    const validVotes = counted.reduce((sum, row) => sum + row.total, 0);
    const benchmark = validVotes > 0 ? partyVotes / validVotes : 0;
    return counted.reduce((sum, row) => sum + Math.max(Math.round(row.total * benchmark - row.partai), 0), 0);
}

/**
 * The votes a party would add at one level by matching, in every kecamatan, the best share it has there at
 * another level: people who already vote for it for another council. A kecamatan counts only where this
 * level and at least one other have usable figures.
 */
export function levelGapVotes(
    tingkat: Tingkat,
    kecamatan: readonly { kode_kecamatan: string }[],
    votes: ReadonlyMap<Tingkat, ReadonlyMap<string, KecamatanLevelVotes>>,
    withheld: ReadonlyMap<Tingkat, ReadonlySet<string>>,
): number {
    const shareAt = (level: Tingkat, kode: string) => {
        const row = votes.get(level)?.get(kode);
        return row === undefined || row.total <= 0 || withheld.get(level)?.has(kode) ? null : row;
    };
    let extra = 0;
    for (const { kode_kecamatan } of kecamatan) {
        const here = shareAt(tingkat, kode_kecamatan);
        if (here === null) {
            continue;
        }
        let best = 0;
        for (const level of TINGKAT_NAMES) {
            const there = level === tingkat ? null : shareAt(level, kode_kecamatan);
            if (there !== null) {
                best = Math.max(best, there.partai / there.total);
            }
        }
        extra += Math.max(Math.round(best * here.total - here.partai), 0);
    }
    return extra;
}

/** The party's votes after `swing` percent of every other party's votes move to it, plus new voters. */
function swungVotes(votes: VotesByParty, partyId: number, swing: number, newVoters: number): Map<number, number> {
    const tried = new Map(votes);
    let gained = newVoters;
    for (const [otherId, otherVotes] of votes) {
        if (otherId !== partyId) {
            // Rounded the way a caller applying the swing itself would round it.
            const moved = Math.round((otherVotes * swing) / 100);
            tried.set(otherId, otherVotes - moved);
            gained += moved;
        }
    }
    tried.set(partyId, (votes.get(partyId) ?? 0) + gained);
    return tried;
}

/**
 * The smallest swing, the same percentage of every other party's votes, that gives the party one more seat
 * once `newVoters` have been added. Zero when the new voters are enough alone, null when no swing is.
 */
export function minimalSwing(
    votes: VotesByParty,
    eligible: ReadonlySet<number> | null,
    seats: number,
    partyId: number,
    newVoters: number,
): number | null {
    const seatsWith = (swing: number) =>
        allocateSeats(countedVotes(swungVotes(votes, partyId, swing, newVoters), eligible), seats).seatsByParty.get(
            partyId,
        ) ?? 0;
    const held = allocateSeats(countedVotes(votes, eligible), seats).seatsByParty.get(partyId) ?? 0;
    if (seatsWith(0) > held) {
        return 0;
    }
    let low = 0;
    let high = 100 / SWING_STEP;
    if (seatsWith(100) <= held) {
        return null;
    }
    // In whole steps, so the answer is a figure a slider can be set to.
    while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (seatsWith(middle * SWING_STEP) > held) {
            high = middle;
        } else {
            low = middle;
        }
    }
    return round2(high * SWING_STEP);
}

export interface History {
    /** Comparable dapil of the level where the party has votes in both elections. */
    jumlah_dapil: number;
    /** In how many of them the party's votes rose by at least the share asked about. */
    dapil_mencapai: number;
    persen_median: number | null;
    persen_kuartil_atas: number | null;
    /** The party's own change in this dapil. Null when it has no comparable 2019 dapil. */
    persen_dapil_ini: number | null;
}

const quantile = (sorted: readonly number[], share: number) =>
    sorted.length === 0 ? null : round2(sorted[Math.min(Math.floor(sorted.length * share), sorted.length - 1)] ?? 0);

/**
 * How a party's votes changed between the two elections in every comparable dapil of a level, in percent of
 * its 2019 votes, set against a change asked about: what it has done before, as a measure of what is asked.
 */
export function historyOf(
    pairs: readonly { kode_dapil_2024: number; kode_dapil_2019: number }[],
    now: ReadonlyMap<number, number>,
    then: ReadonlyMap<number, number>,
    kodeDapil: number,
    askedPercent: number,
): History {
    const changes: number[] = [];
    let here: number | null = null;
    for (const pair of pairs) {
        const after = now.get(pair.kode_dapil_2024);
        const before = then.get(pair.kode_dapil_2019);
        if (after === undefined || before === undefined || before <= 0 || after <= 0) {
            continue;
        }
        const change = ((after - before) / before) * 100;
        changes.push(change);
        if (pair.kode_dapil_2024 === kodeDapil) {
            here = round2(change);
        }
    }
    const sorted = [...changes].sort((a, b) => a - b);
    return {
        jumlah_dapil: changes.length,
        dapil_mencapai: changes.filter((change) => change >= askedPercent).length,
        persen_median: quantile(sorted, 0.5),
        persen_kuartil_atas: quantile(sorted, 0.75),
        persen_dapil_ini: here,
    };
}

/**
 * The recommendation, put together. Supporters are people already inclined, so they are named and not
 * entered as votes: a published contact effect is a few points of turnout among people reached, and that
 * rate is not applied here. The two share gaps are returned for the cards that already show them, and not
 * added either: nothing published estimates the votes gained by closing them. The swing is the distance on
 * the 2024 quotients, with no new voters.
 */
export function recommend(input: {
    votes: VotesByParty;
    eligible: ReadonlySet<number> | null;
    seats: number;
    partyId: number;
    shortfall: number;
    supporters: number;
    voteRoom: number | null;
    levelGap: number | null;
    history: History;
}) {
    const own = input.votes.get(input.partyId) ?? 0;
    const swing = minimalSwing(input.votes, input.eligible, input.seats, input.partyId, 0);
    const fromSwing =
        swing === null ? null : (swungVotes(input.votes, input.partyId, swing, 0).get(input.partyId) ?? own) - own;
    return {
        kekurangan_kursi_berikutnya: input.shortfall,
        persen_dibutuhkan: own > 0 ? round2((input.shortfall / own) * 100) : null,
        sumber_teridentifikasi: {
            pendukung: input.supporters,
            ruang_suara: input.voteRoom,
            lintas_tingkat: input.levelGap,
            /** Neither gap is taken as votes. */
            dipakai: null,
            pemilih_baru: 0,
            persen_dari_kekurangan: null,
        },
        /** The smallest swing that wins the next seat from the 2024 result. Null when none does. */
        ayunan_persen: swing,
        suara_dari_ayunan: fromSwing,
        riwayat: input.history,
    };
}
