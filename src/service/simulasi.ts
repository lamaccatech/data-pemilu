import type { DapilRecord } from '../db/dapil';
import type { Election } from '../db/election';
import type { Tingkat } from '../tingkat';
import { viewCompetition } from './persaingan';

/** One party in a what-if: its result beside what the tried votes give it. */
export interface SimulatedParty {
    kode_partai: string;
    suara_awal: number;
    suara: number;
    kursi_awal: number;
    kursi: number;
    lolos_ambang_batas: boolean;
    /** Votes above what its seats needed with the tried votes. Null without a seat. */
    margin_kursi: number | null;
    /** Votes still missing for one more seat with the tried votes. Null when there is none to win. */
    kekurangan_kursi_berikutnya: number | null;
}

const lastSeatPrice = (row: { suara: number; pembagi: number } | null) =>
    row === null ? null : Math.ceil(row.suara / row.pembagi);

/**
 * The seats of a dapil with some parties' votes replaced, set beside the real result. The same
 * calculation as the result itself, run twice. The national threshold is not recalculated: which parties
 * pass it is taken from the real national result, since one dapil's votes do not decide it.
 * Null when either set of votes cannot be calculated.
 */
export function simulateSeats(
    election: Election,
    tingkat: Tingkat,
    dapil: DapilRecord,
    actualVotes: ReadonlyMap<number, number>,
    triedVotes: ReadonlyMap<number, number>,
) {
    const actual = viewCompetition(election, tingkat, dapil, actualVotes, [], null);
    const tried = viewCompetition(election, tingkat, dapil, triedVotes, [], null);
    if (actual === null || tried === null) {
        return null;
    }
    const before = new Map(actual.partai.map((row) => [row.kode_partai, row]));
    const partai: SimulatedParty[] = tried.partai.map((row) => ({
        kode_partai: row.kode_partai,
        suara_awal: before.get(row.kode_partai)?.suara ?? 0,
        suara: row.suara,
        kursi_awal: before.get(row.kode_partai)?.kursi ?? 0,
        kursi: row.kursi,
        lolos_ambang_batas: row.lolos_ambang_batas,
        margin_kursi: row.margin_kursi,
        kekurangan_kursi_berikutnya: row.kekurangan_kursi_berikutnya,
    }));
    return {
        total_suara_sah_awal: actual.partai.reduce((sum, row) => sum + row.suara, 0),
        total_suara_sah: partai.reduce((sum, row) => sum + row.suara, 0),
        harga_kursi_terakhir_awal: lastSeatPrice(actual.pembagian_kursi.kursi_terakhir),
        harga_kursi_terakhir: lastSeatPrice(tried.pembagian_kursi.kursi_terakhir),
        partai,
        /** Only the parties whose seats change, the largest gain first. */
        perubahan_kursi: partai
            .filter((row) => row.kursi !== row.kursi_awal)
            .map((row) => ({ kode_partai: row.kode_partai, selisih: row.kursi - row.kursi_awal }))
            .sort((a, b) => b.selisih - a.selisih || a.kode_partai.localeCompare(b.kode_partai)),
        pembagian_kursi: tried.pembagian_kursi.tabel,
    };
}
