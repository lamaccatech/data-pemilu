import {
    analyseSeats,
    type CandidateVotes,
    classifyKuadran,
    countedVotes,
    type DapilSeats,
    isComputable,
    isNextSeatNear,
    type Kuadran,
} from '../calc';
import type { DapilRecord } from '../db/dapil';
import { type Election, eligibleParties, type Party } from '../db/election';
import type { Tingkat } from '../tingkat';

/** One dapil as the API returns it for a focus party. Calculated fields are null when party votes are missing. */
export interface DapilView {
    kode_dapil: string;
    nama_dapil: string;
    kode_provinsi: string | null;
    nama_provinsi: string | null;
    kode_kabupaten: string | null;
    nama_kabupaten: string | null;
    jumlah_kursi: number | null;
    total_suara_sah: number | null;
    /** False when the dapil has no party votes (or no seat count), so nothing can be calculated. */
    data_lengkap: boolean;
    suara_partai: number | null;
    kursi_partai: number | null;
    lolos_ambang_batas: boolean;
    harga_kursi_terakhir: number | null;
    target_suara_kursi_pertama: number | null;
    selisih_kursi_pertama: number | null;
    target_suara_kursi_berikutnya: number | null;
    kekurangan_kursi_berikutnya: number | null;
    suara_caleg_batas: number | null;
    kuadran: Kuadran | null;
    peluang_dekat: boolean | null;
}

const code = (value: number | null) => (value === null ? null : String(value));

/** Runs the reference calculation for one dapil and shapes the result for the API. */
export function viewDapil(
    election: Election,
    tingkat: Tingkat,
    dapil: DapilRecord,
    votesByParty: ReadonlyMap<number, number>,
    ownCandidates: readonly CandidateVotes[],
    party: Party,
): { view: DapilView; analysis: DapilSeats | null } {
    const eligible = eligibleParties(election, tingkat);
    const analysis = analyseSeats(
        {
            pemilu: Number(election.pemilu),
            tingkat,
            kode_dapil: String(dapil.kode_dapil),
            nama_dapil: dapil.nama_dapil,
            jumlah_kursi: dapil.jumlah_kursi,
        },
        votesByParty,
        ownCandidates,
        eligible,
        party.partai_id,
    );
    const place = {
        kode_dapil: String(dapil.kode_dapil),
        nama_dapil: dapil.nama_dapil,
        kode_provinsi: code(dapil.kode_provinsi),
        nama_provinsi: dapil.nama_provinsi,
        kode_kabupaten: code(dapil.kode_kabupaten),
        nama_kabupaten: dapil.nama_kabupaten,
        jumlah_kursi: dapil.jumlah_kursi,
    };
    if (!isComputable<DapilSeats>(analysis)) {
        return {
            view: {
                ...place,
                total_suara_sah: null,
                data_lengkap: false,
                suara_partai: null,
                kursi_partai: null,
                lolos_ambang_batas: eligible === null || eligible.has(party.partai_id),
                harga_kursi_terakhir: null,
                target_suara_kursi_pertama: null,
                selisih_kursi_pertama: null,
                target_suara_kursi_berikutnya: null,
                kekurangan_kursi_berikutnya: null,
                suara_caleg_batas: null,
                kuadran: null,
                peluang_dekat: null,
            },
            analysis: null,
        };
    }
    const own = analysis.partai_sendiri;
    return {
        view: {
            ...place,
            total_suara_sah: analysis.total_suara_sah,
            data_lengkap: true,
            suara_partai: own.suara,
            kursi_partai: own.kursi,
            lolos_ambang_batas: own.lolos_ambang_batas,
            harga_kursi_terakhir: analysis.harga_kursi_terakhir,
            target_suara_kursi_pertama: own.target_suara_kursi_pertama,
            selisih_kursi_pertama: own.selisih_kursi_pertama,
            target_suara_kursi_berikutnya: own.target_suara_kursi_berikutnya,
            kekurangan_kursi_berikutnya: own.kekurangan_kursi_berikutnya,
            suara_caleg_batas: own.suara_caleg_batas,
            kuadran: classifyKuadran(countedVotes(votesByParty, eligible), analysis.jumlah_kursi, own),
            peluang_dekat: isNextSeatNear(own, analysis.harga_kursi_terakhir),
        },
        analysis,
    };
}

export interface DapilListSummary {
    jumlah_dapil: number;
    /** Dapil without party votes. Their calculated fields are null. */
    dapil_tanpa_data: number;
    kuadran: Record<Kuadran, number>;
    peluang_dekat: number;
    kursi_partai: number;
}

export function summariseViews(views: readonly DapilView[]): DapilListSummary {
    const summary: DapilListSummary = {
        jumlah_dapil: views.length,
        dapil_tanpa_data: 0,
        kuadran: { aman: 0, waspada: 0, rawan: 0, kosong: 0 },
        peluang_dekat: 0,
        kursi_partai: 0,
    };
    for (const view of views) {
        if (!view.data_lengkap || view.kuadran === null) {
            summary.dapil_tanpa_data++;
            continue;
        }
        summary.kuadran[view.kuadran]++;
        summary.peluang_dekat += view.peluang_dekat ? 1 : 0;
        summary.kursi_partai += view.kursi_partai ?? 0;
    }
    return summary;
}

/** Groups rows by dapil. */
export function groupByDapil<T extends { kode_dapil: number }>(records: readonly T[]): Map<number, T[]> {
    const groups = new Map<number, T[]>();
    for (const record of records) {
        const group = groups.get(record.kode_dapil);
        if (group === undefined) {
            groups.set(record.kode_dapil, [record]);
        } else {
            group.push(record);
        }
    }
    return groups;
}

export const votesMap = (records: readonly { partai_id: number; suara: number }[]) =>
    new Map(records.map((record) => [record.partai_id, record.suara]));
