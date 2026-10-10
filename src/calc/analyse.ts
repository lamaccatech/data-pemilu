import { allocateSeats, type VotesByParty, votesNeededForSeats } from './sainte-lague';

export const STANDOUT_LIMIT = 10;
export const PARTY_PILLAR_SHARE = 0.4;

export interface DapilInput {
    pemilu: number;
    tingkat: string;
    kode_dapil: string;
    nama_dapil: string;
    jumlah_kursi: number | null;
}

export interface Candidate {
    partai_id: number;
    nomor_urut: number;
    nama: string;
    suara: number;
    kursi_ke: number;
}

/** What the personal bar needs: one party's candidates, any order. */
export type CandidateVotes = Pick<Candidate, 'nomor_urut' | 'suara'>;

export interface PartyResult {
    partai_id: number;
    suara: number;
    kursi: number;
    lolos_ambang_batas: boolean;
}

export interface OwnPartyResult extends PartyResult {
    target_suara_kursi_pertama: number | null;
    selisih_kursi_pertama: number | null;
    target_suara_kursi_berikutnya: number | null;
    kekurangan_kursi_berikutnya: number | null;
    suara_caleg_batas: number | null;
}

export interface Standout {
    partai_id: number;
    nomor_urut: number;
    nama: string;
    suara: number;
    persen_suara_dapil: number;
    rasio_terhadap_terpilih_terendah: number | null;
    penopang_partai: boolean;
    melampaui_nomor_urut: boolean;
    partai_sendiri: boolean;
}

export interface DapilSummary extends DapilInput {
    total_suara_sah: number;
    dapat_dihitung: boolean;
}

export interface DapilSeats extends DapilSummary {
    dapat_dihitung: true;
    jumlah_kursi: number;
    harga_kursi_terakhir: number | null;
    partai: PartyResult[];
    partai_sendiri: OwnPartyResult;
}

export interface DapilAnalysis extends DapilSeats {
    tokoh_menonjol: Standout[];
}

/** Python's round(value, 2): the exact binary value rounded to two decimals, exact ties going to the even digit. */
export function round2(value: number): number {
    // A double sits exactly halfway between two hundredths only when it is an odd multiple of 1/8.
    if (Number.isInteger(value * 8) && !Number.isInteger(value * 4)) {
        const lower = Math.floor(value * 100);
        return (lower % 2 === 0 ? lower : lower + 1) / 100;
    }
    return Number(value.toFixed(2));
}

const byVotesThenNumber = (a: CandidateVotes, b: CandidateVotes) => b.suara - a.suara || a.nomor_urut - b.nomor_urut;

function sumVotes(votesByParty: VotesByParty): number {
    let total = 0;
    for (const votes of votesByParty.values()) {
        total += votes;
    }
    return total;
}

/** Votes that take part in the seat allocation: every party, or only those passing the national threshold. */
export function countedVotes(votesByParty: VotesByParty, eligiblePartyIds: ReadonlySet<number> | null): VotesByParty {
    if (eligiblePartyIds === null) {
        return votesByParty;
    }
    return new Map([...votesByParty].filter(([partyId]) => eligiblePartyIds.has(partyId)));
}

/**
 * Seat allocation and the focus party's targets for one dapil.
 *
 * `eligiblePartyIds` is the set of parties passing the national threshold (`dpr_ri`), or null when the level
 * has no threshold. `ownCandidates` are the focus party's candidates only.
 */
export function analyseSeats(
    dapil: DapilInput,
    votesByParty: VotesByParty,
    ownCandidates: readonly CandidateVotes[],
    eligiblePartyIds: ReadonlySet<number> | null,
    ownPartyId: number,
): DapilSummary | DapilSeats {
    const seats = dapil.jumlah_kursi;
    const totalVotes = sumVotes(votesByParty);
    const summary: DapilSummary = {
        pemilu: dapil.pemilu,
        tingkat: dapil.tingkat,
        kode_dapil: dapil.kode_dapil,
        nama_dapil: dapil.nama_dapil,
        jumlah_kursi: seats,
        total_suara_sah: totalVotes,
        dapat_dihitung: seats !== null && totalVotes > 0,
    };
    if (seats === null || totalVotes <= 0) {
        return summary;
    }
    const isEligible = (partyId: number) => eligiblePartyIds === null || eligiblePartyIds.has(partyId);
    const counted = countedVotes(votesByParty, eligiblePartyIds);
    const { seatsByParty, winning } = allocateSeats(counted, seats);
    const lastWinning = winning.at(-1);

    const ownVotes = votesByParty.get(ownPartyId) ?? 0;
    const ownSeats = seatsByParty.get(ownPartyId) ?? 0;
    const sortedOwn = [...ownCandidates].sort(byVotesThenNumber);
    const targetFirstSeat = votesNeededForSeats(counted, seats, ownPartyId, 1);
    const targetNextSeat = votesNeededForSeats(counted, seats, ownPartyId, ownSeats + 1);
    // The personal bar: the party's last seated candidate, or its top candidate when it holds no seat.
    const barIndex = Math.max(ownSeats, 1) - 1;

    return {
        ...summary,
        dapat_dihitung: true,
        jumlah_kursi: seats,
        harga_kursi_terakhir: lastWinning === undefined ? null : Math.ceil(lastWinning),
        partai: [...votesByParty]
            .sort(([idA, votesA], [idB, votesB]) => votesB - votesA || idA - idB)
            .map(([partyId, votes]) => ({
                partai_id: partyId,
                suara: votes,
                kursi: seatsByParty.get(partyId) ?? 0,
                lolos_ambang_batas: isEligible(partyId),
            })),
        partai_sendiri: {
            partai_id: ownPartyId,
            suara: ownVotes,
            kursi: ownSeats,
            lolos_ambang_batas: isEligible(ownPartyId),
            target_suara_kursi_pertama: targetFirstSeat,
            selisih_kursi_pertama: targetFirstSeat === null ? null : ownVotes - targetFirstSeat,
            target_suara_kursi_berikutnya: targetNextSeat,
            kekurangan_kursi_berikutnya: targetNextSeat === null ? null : Math.max(targetNextSeat - ownVotes, 0),
            suara_caleg_batas: sortedOwn[barIndex]?.suara ?? null,
        },
    };
}

/**
 * The strongest candidates who did not win a seat, across every party in the dapil.
 *
 * `ownPartyId` only sets the `partai_sendiri` flag; pass null when no focus party was asked for.
 */
export function findStandouts(
    votesByParty: VotesByParty,
    candidates: readonly Candidate[],
    ownPartyId: number | null,
): Standout[] {
    const totalVotes = sumVotes(votesByParty);
    const seatedVotes = candidates.filter((row) => row.kursi_ke > 0).map((row) => row.suara);
    const lowestSeated = seatedVotes.length > 0 ? Math.min(...seatedVotes) : null;
    const rankInParty = new Map<string, number>();
    const byParty = new Map<number, Candidate[]>();
    for (const row of candidates) {
        const rows = byParty.get(row.partai_id) ?? [];
        rows.push(row);
        byParty.set(row.partai_id, rows);
    }
    for (const rows of byParty.values()) {
        rows.sort(byVotesThenNumber).forEach((row, index) => {
            rankInParty.set(`${row.partai_id}:${row.nomor_urut}`, index + 1);
        });
    }
    const notSeated = candidates
        .filter((row) => row.kursi_ke === 0 && row.suara > 0)
        .sort((a, b) => b.suara - a.suara || a.partai_id - b.partai_id || a.nomor_urut - b.nomor_urut);
    return notSeated.slice(0, STANDOUT_LIMIT).map((row) => {
        const partyTotal = votesByParty.get(row.partai_id) ?? 0;
        const rank = rankInParty.get(`${row.partai_id}:${row.nomor_urut}`) ?? 0;
        return {
            partai_id: row.partai_id,
            nomor_urut: row.nomor_urut,
            nama: row.nama,
            suara: row.suara,
            persen_suara_dapil: round2((row.suara / totalVotes) * 100),
            // A lowest seated candidate with zero votes gives no ratio, as in the reference.
            rasio_terhadap_terpilih_terendah: lowestSeated ? round2(row.suara / lowestSeated) : null,
            penopang_partai: partyTotal > 0 && row.suara / partyTotal >= PARTY_PILLAR_SHARE,
            melampaui_nomor_urut: row.nomor_urut >= 3 && rank <= 2,
            partai_sendiri: row.partai_id === ownPartyId,
        };
    });
}

/** `analyse_dapil` of the reference: seats, the focus party's targets and the standout candidates. */
export function analyseDapil(
    dapil: DapilInput,
    votesByParty: VotesByParty,
    candidates: readonly Candidate[],
    eligiblePartyIds: ReadonlySet<number> | null,
    ownPartyId: number,
): DapilSummary | DapilAnalysis {
    const ownCandidates = candidates.filter((row) => row.partai_id === ownPartyId);
    const result = analyseSeats(dapil, votesByParty, ownCandidates, eligiblePartyIds, ownPartyId);
    if (!isComputable(result)) {
        return result;
    }
    return { ...result, tokoh_menonjol: findStandouts(votesByParty, candidates, ownPartyId) };
}

export function isComputable<T extends DapilSeats>(result: DapilSummary | T): result is T {
    return result.dapat_dihitung;
}
