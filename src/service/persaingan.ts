import {
    type Candidate,
    countedVotes,
    type Kuadran,
    normalizePersonName,
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
    /** Null when the dapil marks no winner at all. */
    terpilih: boolean | null;
}

/** A candidate who won a seat. */
export interface SeatHolder {
    nomor_urut: number;
    nama: string;
    suara: number;
}

/**
 * A seat holder set against the comparable dapil of the election before, by name with titles dropped. A same
 * name is a likely match, not a proven one. Both fields are null when there is nothing to compare with.
 */
export interface SeatHolderNow extends SeatHolder {
    /** Votes of the same-named candidate then, in whichever party. Null when no one of that name ran. */
    suara_2019: number | null;
    /** Whether that candidate also won a seat then. Null when the earlier results mark no winners. */
    terpilih_2019: boolean | null;
}

/** One party's result in the comparable dapil of the election before. */
export interface Before {
    suara: number;
    persen_suara: number;
    kursi: number;
    /** Its place among the parties of the dapil by votes, 1 being the largest. */
    peringkat: number;
    persen_suara_gambar: number | null;
    caleg_terpilih: SeatHolder[];
}

/** The comparable dapil of the election before, shaped for setting beside the current one. */
export interface Earlier {
    partai: ReadonlyMap<string, Before>;
    /** By normalised name: the most votes where a name occurs twice. */
    caleg: ReadonlyMap<string, { suara: number; terpilih: boolean }>;
    /** False when the earlier results mark no seat winner at all, so "won a seat then" cannot be told. */
    pemenang_ditandai: boolean;
}

/** One party in the contest for a dapil. Every party is calculated the way the focus party is elsewhere. */
export interface Contender {
    kode_partai: string;
    suara: number;
    persen_suara: number;
    kursi: number;
    /** Its place among the parties of the dapil by votes, 1 being the largest. */
    peringkat: number;
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
    caleg_terpilih: SeatHolderNow[];
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

function personalVotes(party: Party, partyVotes: number, candidates: readonly Candidate[], winnersMarked: boolean) {
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
                      terpilih: winnersMarked ? top.kursi_ke > 0 : null,
                  },
    };
}

const bySeat = (a: Candidate, b: Candidate) => a.kursi_ke - b.kursi_ke || b.suara - a.suara;

function seatHolders(party: Party, candidates: readonly Candidate[]): SeatHolder[] {
    return candidates
        .filter((row) => row.partai_id === party.partai_id && row.kursi_ke > 0)
        .sort(bySeat)
        .map((row) => ({ nomor_urut: row.nomor_urut, nama: row.nama, suara: row.suara }));
}

/** Shapes the competition of the comparable earlier dapil for setting beside the current one. */
export function earlierOf(competition: Competition, candidates: readonly Candidate[]): Earlier {
    const caleg = new Map<string, { suara: number; terpilih: boolean }>();
    for (const row of candidates) {
        const name = normalizePersonName(row.nama);
        const known = caleg.get(name);
        if (name !== '' && (known === undefined || row.suara > known.suara)) {
            caleg.set(name, { suara: row.suara, terpilih: row.kursi_ke > 0 });
        }
    }
    return {
        partai: new Map(
            competition.partai.map((row) => [
                row.kode_partai,
                {
                    suara: row.suara,
                    persen_suara: row.persen_suara,
                    kursi: row.kursi,
                    peringkat: row.peringkat,
                    persen_suara_gambar: row.persen_suara_gambar,
                    caleg_terpilih: row.caleg_terpilih.map(({ nomor_urut, nama, suara }) => ({
                        nomor_urut,
                        nama,
                        suara,
                    })),
                },
            ]),
        ),
        caleg,
        pemenang_ditandai: candidates.some((row) => row.kursi_ke > 0),
    };
}

/** One dapil in the overview of a level: who got what, without the per-party analysis. */
export interface DapilStandings {
    kode_dapil: string;
    nama_dapil: string;
    kode_provinsi: string | null;
    jumlah_kursi: number | null;
    total_suara_sah: number | null;
    /** False when the dapil has no party votes (or no seat count); the rest is then empty. */
    data_lengkap: boolean;
    /** Parties with votes, most votes first. */
    partai: { kode_partai: string; suara: number; kursi: number }[];
    /** The party that won the seat with the smallest quotient. */
    pemegang_kursi_terakhir: string | null;
}

/** Votes and seats of every party in one dapil, for drawing a whole level at once. */
export function viewStandings(
    election: Election,
    tingkat: Tingkat,
    dapil: DapilRecord,
    votesByParty: VotesByParty,
): DapilStandings {
    const place = {
        kode_dapil: String(dapil.kode_dapil),
        nama_dapil: dapil.nama_dapil,
        kode_provinsi: dapil.kode_provinsi === null ? null : String(dapil.kode_provinsi),
        jumlah_kursi: dapil.jumlah_kursi,
    };
    const seats = dapil.jumlah_kursi;
    let total = 0;
    for (const votes of votesByParty.values()) {
        total += votes;
    }
    if (seats === null || total <= 0) {
        return { ...place, total_suara_sah: null, data_lengkap: false, partai: [], pemegang_kursi_terakhir: null };
    }
    const winners = rankQuotients(countedVotes(votesByParty, eligibleParties(election, tingkat)), seats).slice(
        0,
        seats,
    );
    const seatsByParty = new Map<number, number>();
    for (const winner of winners) {
        seatsByParty.set(winner.partai_id, (seatsByParty.get(winner.partai_id) ?? 0) + 1);
    }
    const last = winners.at(-1);
    return {
        ...place,
        total_suara_sah: total,
        data_lengkap: true,
        partai: [...votesByParty]
            .filter(([, votes]) => votes > 0)
            .sort(([idA, votesA], [idB, votesB]) => votesB - votesA || idA - idB)
            .map(([partyId, votes]) => ({
                kode_partai: partyCode(election, partyId),
                suara: votes,
                kursi: seatsByParty.get(partyId) ?? 0,
            })),
        pemegang_kursi_terakhir: last === undefined ? null : partyCode(election, last.partai_id),
    };
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
    earlier: Earlier | null,
): Competition | null {
    const seats = dapil.jumlah_kursi;
    const counted = countedVotes(votesByParty, eligibleParties(election, tingkat));
    const contenders: Contender[] = [];
    const winnersMarked = candidates.some((row) => row.kursi_ke > 0);
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
            // Set once every party is known.
            peringkat: 0,
            ...personalVotes(party, votes, candidates, winnersMarked),
            caleg_terpilih: seatHolders(party, candidates).map((holder) => {
                const then = earlier?.caleg.get(normalizePersonName(holder.nama));
                return {
                    ...holder,
                    suara_2019: then?.suara ?? null,
                    terpilih_2019: earlier?.pemenang_ditandai ? (then?.terpilih ?? false) : null,
                };
            }),
            hasil_2019: earlier?.partai.get(party.kode_partai) ?? null,
        });
    }
    contenders.sort((a, b) => b.suara - a.suara || a.kode_partai.localeCompare(b.kode_partai));
    contenders.forEach((contender, index) => {
        contender.peringkat = index + 1;
    });

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
