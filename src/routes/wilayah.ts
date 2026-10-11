import type { Hono } from 'hono';
import { round2 } from '../calc';
import { type Election, partyCode, requireParty } from '../db/election';
import {
    type AreaCandidateRecord,
    readKecamatanCandidates,
    readKecamatanVotes,
    readKelurahanCandidates,
    readKelurahanVotes,
} from '../db/wilayah';
import { notFound } from '../errors';
import { type AppEnv, ok } from '../http/context';
import { dapilNotFound, election2024, fields, optionalParty, parseParams } from '../http/params';

const ONLY_2024 = 'Data kelurahan dan kecamatan';

interface PartyVotes {
    partai_id: number;
    suara: number;
}

/** Totals of one area from its party rows: valid votes, the focus party's share and the leading party. */
function summariseArea(election: Election, votes: readonly PartyVotes[], focusPartyId: number) {
    let total = 0;
    let focus = 0;
    let leader: PartyVotes | null = null;
    for (const row of votes) {
        total += row.suara;
        if (row.partai_id === focusPartyId) {
            focus = row.suara;
        }
        // Equal votes: the lower ballot number leads, as in the seat allocation.
        if (
            leader === null ||
            row.suara > leader.suara ||
            (row.suara === leader.suara && row.partai_id < leader.partai_id)
        ) {
            leader = row;
        }
    }
    return {
        suara_partai: focus,
        total_suara_sah: total,
        persen_suara: total > 0 ? round2((focus / total) * 100) : null,
        partai_unggul:
            leader === null ? null : { kode_partai: partyCode(election, leader.partai_id), suara: leader.suara },
    };
}

const NO_DATA = { suara_partai: null, total_suara_sah: null, persen_suara: null, partai_unggul: null };

function viewCandidates(election: Election, candidates: readonly AreaCandidateRecord[]) {
    return candidates.map((row) => ({
        kode_partai: partyCode(election, row.partai_id),
        nomor_urut: row.nomor_urut,
        nama: row.nama,
        jenis_kelamin: row.jenis_kelamin,
        suara: row.suara,
        suara_dapil: row.suara_dapil,
        kursi_ke: row.kursi_ke,
    }));
}

function group<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
    const groups = new Map<K, T[]>();
    for (const item of items) {
        const key = keyOf(item);
        const members = groups.get(key);
        if (members === undefined) {
            groups.set(key, [item]);
        } else {
            members.push(item);
        }
    }
    return groups;
}

export function registerWilayahRoutes(app: Hono<AppEnv>): void {
    // 5. Party votes per kecamatan of a dapil, summed from the kelurahan table.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/kecamatan', async (c) => {
        const { pemilu, election, db } = await election2024(c, ONLY_2024);
        const { tingkat, kode_dapil, partai } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            partai: fields.partai,
        });
        const party = requireParty(election, partai);
        const found = await readKecamatanVotes(db, tingkat, kode_dapil, party.partai_id);
        if (found.dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        const votes = group(found.votes, (row) => String(row.kode_kecamatan));
        const kelurahan = new Map(found.kelurahanCounts.map((row) => [String(row.kode_kecamatan), row.jumlah]));
        let fromKelurahan = 0;
        let withoutData = 0;
        const data = found.kecamatan.map((kecamatan) => {
            const rows = votes.get(kecamatan.kode_kecamatan);
            const place = { kode_kecamatan: kecamatan.kode_kecamatan, nama_kecamatan: kecamatan.nama_kecamatan };
            if (rows === undefined) {
                withoutData++;
                return { ...place, data_tersedia: false, jumlah_kelurahan_berdata: 0, ...NO_DATA, partai: [] };
            }
            const summary = summariseArea(election, rows, party.partai_id);
            fromKelurahan += summary.suara_partai;
            return {
                ...place,
                data_tersedia: true,
                jumlah_kelurahan_berdata: kelurahan.get(kecamatan.kode_kecamatan) ?? 0,
                ...summary,
                partai: rows
                    .map((row) => ({ kode_partai: partyCode(election, row.partai_id), suara: row.suara }))
                    .sort((a, b) => b.suara - a.suara),
            };
        });
        return ok(c, data, {
            pemilu,
            tingkat,
            kode_dapil: String(found.dapil.kode_dapil),
            nama_dapil: found.dapil.nama_dapil,
            partai,
            jumlah_kecamatan: data.length,
            // Kecamatan with no kelurahan vote rows at all. They are listed, never filled in.
            kecamatan_tanpa_data: withoutData,
            // The kelurahan data is incomplete, so the sum over kelurahan can fall short of the dapil figure.
            suara_partai_dari_kelurahan: fromKelurahan,
            suara_partai_dapil: found.dapilVotes,
            selisih: found.dapilVotes === null ? null : found.dapilVotes - fromKelurahan,
        });
    });

    // 6. The kelurahan of one kecamatan: focus party, total, share, leading party and the voter roll.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/kelurahan', async (c) => {
        const { pemilu, election, db } = await election2024(c, ONLY_2024);
        const { tingkat, kode_dapil, partai, kecamatan } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            partai: fields.partai,
            kecamatan: fields.kode_kecamatan,
        });
        const party = requireParty(election, partai);
        const found = await readKelurahanVotes(db, tingkat, kode_dapil, kecamatan);
        if (found.dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        if (found.namaKecamatan === null) {
            throw notFound('kecamatan-tidak-ditemukan', `Kecamatan ${kecamatan} tidak termasuk dapil ${kode_dapil}.`);
        }
        const votes = group(found.votes, (row) => row.kode_kelurahan);
        const dpt = new Map(found.dpt.map((row) => [row.kode_kelurahan, row]));
        const elsewhere = new Set(found.elsewhere);
        // The voter roll names every kelurahan of the kecamatan; those that vote in another dapil are left out.
        const codes = [...new Set([...dpt.keys(), ...votes.keys()])]
            .filter((kode) => votes.has(kode) || !elsewhere.has(kode))
            .sort((a, b) => a - b);
        let withoutData = 0;
        const data = codes.map((kode) => {
            const rows = votes.get(kode);
            const roll = dpt.get(kode);
            if (rows === undefined) {
                withoutData++;
            }
            let voters = null;
            if (roll !== undefined) {
                const { kode_kelurahan: _kode, nama_kelurahan: _nama, ...figures } = roll;
                voters = figures;
            }
            return {
                kode_kelurahan: String(kode),
                nama_kelurahan: roll?.nama_kelurahan ?? null,
                data_tersedia: rows !== undefined,
                ...(rows === undefined ? NO_DATA : summariseArea(election, rows, party.partai_id)),
                dpt: voters,
            };
        });
        return ok(c, data, {
            pemilu,
            tingkat,
            kode_dapil: String(found.dapil.kode_dapil),
            nama_dapil: found.dapil.nama_dapil,
            partai,
            kode_kecamatan: kecamatan,
            nama_kecamatan: found.namaKecamatan,
            jumlah_kelurahan: data.length,
            // Kelurahan on the voter roll without any vote rows. Their vote fields are null.
            kelurahan_tanpa_data: withoutData,
            // Other dapil that share this kecamatan. A kelurahan without data may belong to one of them.
            dapil_lain: found.holders.filter((holder) => holder !== kode_dapil).map(String),
        });
    });

    // 7. Candidate votes in one kelurahan.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/kelurahan/:kode_kelurahan/caleg', async (c) => {
        const { pemilu, election, db } = await election2024(c, ONLY_2024);
        const { tingkat, kode_dapil, kode_kelurahan, partai } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            kode_kelurahan: fields.kode_kelurahan,
            partai: fields.partai.optional(),
        });
        if (tingkat === 'dprd_provinsi') {
            throw notFound(
                'tidak-tersedia',
                'Suara caleg DPRD provinsi hanya tersedia sampai tingkat kecamatan. Gunakan /kecamatan/:kode_kecamatan/caleg.',
            );
        }
        const party = optionalParty(election, partai);
        const found = await readKelurahanCandidates(db, tingkat, kode_dapil, kode_kelurahan, party?.partai_id ?? null);
        if (found.dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        if (found.namaKecamatan === null || (found.namaKelurahan === null && !found.hasData)) {
            throw notFound(
                'kelurahan-tidak-ditemukan',
                `Kelurahan ${kode_kelurahan} tidak termasuk dapil ${kode_dapil}.`,
            );
        }
        const data = {
            kode_kelurahan: String(kode_kelurahan),
            nama_kelurahan: found.namaKelurahan,
            kode_kecamatan: found.kodeKecamatan,
            nama_kecamatan: found.namaKecamatan,
            // False when the kelurahan has no candidate rows at all, which is a gap in the data, not zero votes.
            data_tersedia: found.hasData,
            caleg: viewCandidates(election, found.candidates),
        };
        return ok(c, data, {
            pemilu,
            tingkat,
            kode_dapil: String(found.dapil.kode_dapil),
            nama_dapil: found.dapil.nama_dapil,
            partai: partai ?? null,
            jumlah_caleg: data.caleg.length,
            catatan: 'Hanya caleg dengan suara lebih dari nol yang tercatat di tingkat kelurahan.',
        });
    });

    // 8. Candidate votes in one kecamatan, dprd_provinsi only.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/kecamatan/:kode_kecamatan/caleg', async (c) => {
        const { pemilu, election, db } = await election2024(c, ONLY_2024);
        const { tingkat, kode_dapil, kode_kecamatan, partai } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            kode_kecamatan: fields.kode_kecamatan,
            partai: fields.partai.optional(),
        });
        if (tingkat !== 'dprd_provinsi') {
            throw notFound(
                'tidak-tersedia',
                'Suara caleg per kecamatan hanya tersedia untuk DPRD provinsi. Untuk tingkat lain gunakan /kelurahan/:kode_kelurahan/caleg.',
            );
        }
        const party = optionalParty(election, partai);
        const found = await readKecamatanCandidates(db, kode_dapil, kode_kecamatan, party?.partai_id ?? null);
        if (found.dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        if (found.namaKecamatan === null) {
            throw notFound(
                'kecamatan-tidak-ditemukan',
                `Kecamatan ${kode_kecamatan} tidak termasuk dapil ${kode_dapil}.`,
            );
        }
        const data = {
            kode_kecamatan,
            nama_kecamatan: found.namaKecamatan,
            data_tersedia: found.hasData,
            caleg: viewCandidates(election, found.candidates),
        };
        return ok(c, data, {
            pemilu,
            tingkat,
            kode_dapil: String(found.dapil.kode_dapil),
            nama_dapil: found.dapil.nama_dapil,
            partai: partai ?? null,
            jumlah_caleg: data.caleg.length,
        });
    });
}
