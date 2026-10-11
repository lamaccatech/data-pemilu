import {
    allocateSeats,
    type Candidate,
    countedVotes,
    type Kuadran,
    rankQuotients,
    round2,
    type VotesByParty,
    votesNeededForSeats,
} from '../calc';
import type { DapilRecord } from '../db/dapil';
import { type Election, eligibleParties, type Party, partyCode } from '../db/election';
import type { Tingkat } from '../tingkat';
import { viewDapil } from './dapil';

/** A party's strongest candidate in the dapil, and how much of the party's vote is theirs. */
export interface TopCandidate {
    nomor_urut: number;
    nama: string;
    suara: number;
    persen_suara_partai: number;
    terpilih: boolean;
}

export interface Before {
    suara: number;
    persen_suara: number;
    kursi: number;
}

/** One party in the contest for a dapil. Every party is calculated the way the focus party is elsewhere. */
export interface Contender {
    kode_partai: string;
    suara: number;
    persen_suara: number;
    kursi: number;
    lolos_ambang_batas: boolean;
    kuadran: Kuadran;
    /** Votes above what the seats it holds needed. Null without a seat. */
    margin_kursi: number | null;
    /** Null when there is no next seat to win: it holds them all, or is under the national threshold. */
    kekurangan_kursi_berikutnya: number | null;
    peluang_dekat: boolean;
    /** Votes given to the party's candidates by name. Null when the dapil has no candidate votes for it. */
    suara_caleg: number | null;
    /** Votes for the party symbol alone: the party's votes minus its candidates'. Null as above. */
    suara_gambar: number | null;
    persen_suara_gambar: number | null;
    caleg_teratas: TopCandidate | null;
    /** The same party in the comparable 2019 dapil. Null when there is none or the party did not run. */
    hasil_2019: Before | null;
}

export interface SeatRow {
    peringkat: number;
    kode_partai: string;
    suara: number;
    pembagi: number;
    /** Which of the party's seats this quotient is: its first, second, ... */
    kursi_partai_ke: number;
    hasil_bagi: number;
    mendapat_kursi: boolean;
}

export interface Competition {
    partai: Contender[];
    pembagian_kursi: {
        kursi_terakhir: SeatRow | null;
        kursi_pertama_yang_gagal: SeatRow | null;
        /** Every winning quotient, highest first, followed by the first one that won nothing. */
        tabel: SeatRow[];
    };
    /** The party that needs the fewest extra votes for one more seat: the cheapest seat to take. */
    penantang_terdekat: { kode_partai: string; kekurangan: number } | null;
}

const percent = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : 0);

function personalVotes(party: Party, partyVotes: number, candidates: readonly Candidate[]) {
    const own = candidates.filter((row) => row.partai_id === party.partai_id);
    const total = own.reduce((sum, row) => sum + row.suara, 0);
    // No candidate votes, or more of them than the party has: the source is incomplete here, so the
    // split between symbol and candidates is unknown rather than zero.
    if (total === 0 || total > partyVotes) {
        return { suara_caleg: null, suara_gambar: null, persen_suara_gambar: null, caleg_teratas: null };
    }
    const top = [...own].sort((a, b) => b.suara - a.suara || a.nomor_urut - b.nomor_urut)[0];
    return {
        suara_caleg: total,
        suara_gambar: partyVotes - total,
        persen_suara_gambar: percent(partyVotes - total, partyVotes),
        caleg_teratas:
            top === undefined
                ? null
                : {
                      nomor_urut: top.nomor_urut,
                      nama: top.nama,
                      suara: top.suara,
                      persen_suara_partai: percent(top.suara, partyVotes),
                      terpilih: top.kursi_ke > 0,
                  },
    };
}

/** Votes and seats of every party in a dapil of an earlier election, by `kode_partai`. */
export function resultsByCode(
    election: Election,
    tingkat: Tingkat,
    seats: number | null,
    votesByParty: VotesByParty,
): Map<string, Before> {
    const results = new Map<string, Before>();
    let total = 0;
    for (const votes of votesByParty.values()) {
        total += votes;
    }
    if (seats === null || total <= 0) {
        return results;
    }
    const { seatsByParty } = allocateSeats(countedVotes(votesByParty, eligibleParties(election, tingkat)), seats);
    for (const [partyId, votes] of votesByParty) {
        results.set(partyCode(election, partyId), {
            suara: votes,
            persen_suara: percent(votes, total),
            kursi: seatsByParty.get(partyId) ?? 0,
        });
    }
    return results;
}

/**
 * Every party of a dapil side by side: how firmly each holds its seats, what one more would cost, how much
 * of its vote is personal, and the order the seats were won in. Null when the dapil cannot be calculated.
 */
export function viewCompetition(
    election: Election,
    tingkat: Tingkat,
    dapil: DapilRecord,
    votesByParty: VotesByParty,
    candidates: readonly Candidate[],
    before: ReadonlyMap<string, Before> | null,
): Competition | null {
    const seats = dapil.jumlah_kursi;
    const counted = countedVotes(votesByParty, eligibleParties(election, tingkat));
    const contenders: Contender[] = [];
    let total = 0;
    for (const votes of votesByParty.values()) {
        total += votes;
    }
    if (seats === null || total <= 0) {
        return null;
    }
    for (const party of election.parties) {
        const votes = votesByParty.get(party.partai_id);
        if (votes === undefined) {
            continue;
        }
        const own = candidates.filter((row) => row.partai_id === party.partai_id);
        const { view } = viewDapil(election, tingkat, dapil, votesByParty, own, party);
        const held = view.kursi_partai ?? 0;
        const needed = held > 0 ? votesNeededForSeats(counted, seats, party.partai_id, held) : null;
        contenders.push({
            kode_partai: party.kode_partai,
            suara: votes,
            persen_suara: percent(votes, total),
            kursi: held,
            lolos_ambang_batas: view.lolos_ambang_batas,
            kuadran: view.kuadran ?? 'kosong',
            margin_kursi: needed === null ? null : votes - needed,
            // Under the threshold the calculation still reports what a seat would take, which no gain in
            // one dapil can deliver.
            kekurangan_kursi_berikutnya: view.lolos_ambang_batas ? view.kekurangan_kursi_berikutnya : null,
            peluang_dekat: view.peluang_dekat === true,
            ...personalVotes(party, votes, candidates),
            hasil_2019: before?.get(party.kode_partai) ?? null,
        });
    }
    contenders.sort((a, b) => b.suara - a.suara || a.kode_partai.localeCompare(b.kode_partai));

    const tabel: SeatRow[] = rankQuotients(counted, seats)
        .slice(0, seats + 1)
        .map((entry, index) => ({
            peringkat: index + 1,
            kode_partai: partyCode(election, entry.partai_id),
            suara: entry.suara,
            pembagi: entry.pembagi,
            kursi_partai_ke: (entry.pembagi + 1) / 2,
            hasil_bagi: round2(entry.hasil_bagi),
            mendapat_kursi: index < seats,
        }));

    let nearest: Competition['penantang_terdekat'] = null;
    for (const contender of contenders) {
        const shortfall = contender.kekurangan_kursi_berikutnya;
        if (shortfall !== null && (nearest === null || shortfall < nearest.kekurangan)) {
            nearest = { kode_partai: contender.kode_partai, kekurangan: shortfall };
        }
    }
    return {
        partai: contenders,
        pembagian_kursi: {
            kursi_terakhir: tabel[seats - 1] ?? null,
            kursi_pertama_yang_gagal: tabel[seats] ?? null,
            tabel,
        },
        penantang_terdekat: nearest,
    };
}
