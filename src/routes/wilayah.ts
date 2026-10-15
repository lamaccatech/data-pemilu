import type { Hono } from 'hono';
import { z } from 'zod';
import { round2 } from '../calc';
import { readDapil, readPadananList, readPartyVotesOfLevel } from '../db/dapil';
import { type Election, eligibleParties, loadElection, partyCode, requireParty } from '../db/election';
import {
    type AreaCandidateRecord,
    type CandidateAreaRecord,
    readCandidateAreas,
    readCandidateKabupaten,
    readDapilDpt,
    readDapilKabupaten,
    readDapilKecamatanCandidates,
    readKecamatanAcrossLevels,
    readKecamatanCandidates,
    readKecamatanVotes,
    readKelurahanCandidates,
    readKelurahanStandings,
    readKelurahanVotes,
} from '../db/wilayah';
import { notFound } from '../errors';
import { type AppEnv, ok } from '../http/context';
import { dapilNotFound, election2024, fields, optionalParty, parseParams } from '../http/params';
import { viewDapil, votesMap } from '../service/dapil';
import { historyOf, levelGapVotes, recommend, voteRoom } from '../service/rekomendasi';
import { checkPartySpread, checkSpread, toleratedVotes, withheldKecamatan } from '../service/sebaran';
import { TINGKAT_NAMES } from '../tingkat';

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

/** Every party with votes in an area, most votes first. */
function rankParties(election: Election, votes: readonly PartyVotes[]) {
    return votes
        .filter((row) => row.suara > 0)
        .sort((a, b) => b.suara - a.suara || a.partai_id - b.partai_id)
        .map((row) => ({ kode_partai: partyCode(election, row.partai_id), suara: row.suara }));
}

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

/** A candidate's votes in one area beside the party's. Null where the area has no rows of that kind. */
function besideParty(own: CandidateAreaRecord | undefined, party: CandidateAreaRecord | undefined) {
    const votes = own?.suara ?? null;
    const partyVotes = party?.suara ?? null;
    return {
        // False when no candidate of any party has a row there, which is a gap in the data, not zero votes.
        data_tersedia: own !== undefined,
        suara: votes,
        suara_partai: partyVotes,
        persen_dari_partai:
            votes === null || partyVotes === null || partyVotes <= 0 ? null : round2((votes / partyVotes) * 100),
    };
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
        const [found, roll] = await Promise.all([
            readKecamatanVotes(db, tingkat, kode_dapil, party.partai_id),
            readDapilDpt(db, tingkat, kode_dapil),
        ]);
        if (found.dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        const voters = new Map(
            roll.bands.map((band) => [
                band.kode_kecamatan,
                {
                    dpt: band.dpt,
                    di_bawah_30: band.usia_kurang21 + band.usia_u21_25 + band.usia_u26_30,
                },
            ]),
        );
        const check = checkPartySpread(found.partyVotes, found.partyAreas);
        // Kelurahan that give the parties more votes than the dapil are not shown as votes at all.
        const votes = group(check.status === 'tidak_sesuai' ? [] : found.votes, (row) => String(row.kode_kecamatan));
        const kelurahan = new Map(found.kelurahanCounts.map((row) => [String(row.kode_kecamatan), row.jumlah]));
        const sharers = group(found.sharers, (row) => row.kode_kecamatan);
        let fromKelurahan = 0;
        let withoutData = 0;
        const data = found.kecamatan.map((kecamatan) => {
            const rows = votes.get(kecamatan.kode_kecamatan);
            const place = {
                kode_kecamatan: kecamatan.kode_kecamatan,
                nama_kecamatan: kecamatan.nama_kecamatan,
                // Other dapil that hold this kecamatan too. The figures here are this dapil's part of it.
                dapil_lain: (sharers.get(kecamatan.kode_kecamatan) ?? []).map((row) => String(row.kode_dapil)),
            };
            const dpt = voters.get(kecamatan.kode_kecamatan) ?? null;
            if (rows === undefined) {
                withoutData++;
                return { ...place, data_tersedia: false, jumlah_kelurahan_berdata: 0, ...NO_DATA, partai: [], dpt };
            }
            const summary = summariseArea(election, rows, party.partai_id);
            fromKelurahan += summary.suara_partai;
            return {
                ...place,
                data_tersedia: true,
                jumlah_kelurahan_berdata: kelurahan.get(kecamatan.kode_kecamatan) ?? 0,
                ...summary,
                dpt,
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
            // `tidak_sesuai`: the source repeats party votes in this dapil's kelurahan, so every kecamatan
            // is returned without votes. The voter roll is not affected.
            sebaran_partai: check,
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
        const check = checkPartySpread(found.partyVotes, found.partyAreas);
        const votes = group(check.status === 'tidak_sesuai' ? [] : found.votes, (row) => row.kode_kelurahan);
        const dpt = new Map(found.dpt.map((row) => [row.kode_kelurahan, row]));
        const elsewhere = new Set(found.elsewhere);
        // The voter roll names every kelurahan of the kecamatan; those that vote in another dapil are left out.
        // Which kelurahan belong here is told by the rows themselves, withheld or not.
        const present = new Set(found.votes.map((row) => row.kode_kelurahan));
        const codes = [...new Set([...dpt.keys(), ...present])]
            .filter((kode) => present.has(kode) || !elsewhere.has(kode))
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
                partai: rows === undefined ? [] : rankParties(election, rows),
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
            sebaran_partai: check,
        });
    });

    // 17. One party in every kecamatan of a dapil at all three levels, to see where its vote for one
    // council runs ahead of its vote for another. A kecamatan is read whole at every level.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/lintas-tingkat', async (c) => {
        const { pemilu, election, db } = await election2024(c, ONLY_2024);
        const { tingkat, kode_dapil, partai } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            partai: fields.partai,
        });
        const party = requireParty(election, partai);
        const found = await readKecamatanAcrossLevels(db, tingkat, kode_dapil, party.partai_id);
        if (found.dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        // A kecamatan is left out at a level when a dapil that holds it there has repeated party votes.
        const withheld = new Map(
            TINGKAT_NAMES.map((level) => {
                const holders = found.holders.get(level);
                return [
                    level,
                    withheldKecamatan(holders?.kecamatan ?? [], holders?.dapilVotes ?? [], holders?.areaVotes ?? []),
                ];
            }),
        );
        const withheldCount = Object.fromEntries(TINGKAT_NAMES.map((level) => [level, 0]));
        const data = found.kecamatan.map((kecamatan) => ({
            kode_kecamatan: kecamatan.kode_kecamatan,
            nama_kecamatan: kecamatan.nama_kecamatan,
            // Null where the level has no kelurahan votes for the kecamatan, no such council at all, or
            // votes the source repeats.
            tingkat: Object.fromEntries(
                TINGKAT_NAMES.map((level) => {
                    const votes = found.votes.get(level)?.get(kecamatan.kode_kecamatan);
                    if (votes !== undefined && withheld.get(level)?.has(kecamatan.kode_kecamatan)) {
                        withheldCount[level] = (withheldCount[level] ?? 0) + 1;
                        return [level, null];
                    }
                    return [
                        level,
                        votes === undefined || votes.total <= 0
                            ? null
                            : {
                                  suara_partai: votes.partai,
                                  total_suara_sah: votes.total,
                                  persen_suara: round2((votes.partai / votes.total) * 100),
                              },
                    ];
                }),
            ),
        }));
        return ok(c, data, {
            pemilu,
            tingkat,
            kode_dapil: String(found.dapil.kode_dapil),
            nama_dapil: found.dapil.nama_dapil,
            partai,
            jumlah_kecamatan: data.length,
            // Per level: the kecamatan left out because the source repeats party votes there.
            kecamatan_tidak_sesuai: withheldCount,
        });
    });

    // 18. Where one party polled under its own average in the dapil, and by how many votes: for each
    // kelurahan, its valid votes times the gap between the party's share over the dapil's kelurahan and
    // its share there. A benchmark against the party's own result, not a forecast.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/ruang-suara', async (c) => {
        const { pemilu, election, db } = await election2024(c, ONLY_2024);
        const { tingkat, kode_dapil, partai } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            partai: fields.partai,
        });
        const party = requireParty(election, partai);
        const found = await readKelurahanStandings(db, tingkat, kode_dapil, party.partai_id);
        if (found.dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        const check = checkPartySpread(found.partyVotes, found.partyAreas);
        // Repeated party votes would double the room: such a dapil has none to report.
        const counted = check.status === 'tidak_sesuai' ? [] : found.kelurahan.filter((row) => row.total > 0);
        let partyVotes = 0;
        let validVotes = 0;
        for (const row of counted) {
            partyVotes += row.partai;
            validVotes += row.total;
        }
        // The party's share over the kelurahan that have votes, so every kelurahan is measured against
        // the same ground it is part of. The kelurahan data is incomplete, so this can differ a little
        // from the share of the dapil result.
        const benchmark = validVotes > 0 ? partyVotes / validVotes : 0;
        let totalRoom = 0;
        const data = counted
            .map((row) => {
                const room = Math.max(Math.round(row.total * benchmark - row.partai), 0);
                const kodeKecamatan = String(Math.floor(row.kode_kelurahan / 10_000)).padStart(6, '0');
                totalRoom += room;
                return {
                    kode_kelurahan: String(row.kode_kelurahan),
                    nama_kelurahan: row.nama_kelurahan,
                    kode_kecamatan: kodeKecamatan,
                    nama_kecamatan: found.kecamatan.get(kodeKecamatan) ?? null,
                    suara_partai: row.partai,
                    total_suara_sah: row.total,
                    persen_suara: round2((row.partai / row.total) * 100),
                    ruang_suara: room,
                    partai_unggul: {
                        kode_partai: partyCode(election, row.partai_unggul),
                        suara: row.suara_unggul,
                        persen_suara: round2((row.suara_unggul / row.total) * 100),
                    },
                    dpt: row.dpt === null ? null : { dpt: row.dpt, di_bawah_30: row.di_bawah_30 ?? 0 },
                };
            })
            // Only the kelurahan under the party's average have room; the largest first.
            .filter((row) => row.ruang_suara > 0)
            .sort((a, b) => b.ruang_suara - a.ruang_suara || a.kode_kelurahan.localeCompare(b.kode_kelurahan));
        return ok(c, data, {
            pemilu,
            tingkat,
            kode_dapil: String(found.dapil.kode_dapil),
            nama_dapil: found.dapil.nama_dapil,
            partai,
            persen_patokan: round2(benchmark * 100),
            jumlah_kelurahan_berdata: counted.length,
            jumlah_kelurahan_di_bawah_patokan: data.length,
            total_ruang_suara: totalRoom,
            sebaran_partai: check,
        });
    });

    // 28. The distance to the party's next seat: the smallest swing from every other party on the 2024
    // result, and how often the party's votes rose that much between elections. Supporters are named as
    // people to contact and are not added as votes, nor are the share gaps.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/rekomendasi', async (c) => {
        const { pemilu, election, db } = await election2024(c, 'Rekomendasi');
        const { tingkat, kode_dapil, partai, pendukung } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            partai: fields.partai,
            pendukung: fields.pendukung.optional(),
        });
        const party = requireParty(election, partai);
        const { dapil, votes, candidates } = await readDapil(db, tingkat, kode_dapil, party.partai_id);
        if (dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        const votesByParty = votesMap(votes);
        const { view } = viewDapil(election, tingkat, dapil, votesByParty, candidates, party);
        const shortfall = view.lolos_ambang_batas ? view.kekurangan_kursi_berikutnya : null;
        // No next seat to win: every seat is the party's, it is under the national threshold, or the
        // dapil has no party votes. There is nothing to recommend.
        if (dapil.jumlah_kursi === null || shortfall === null || shortfall <= 0) {
            return ok(c, null, { pemilu, tingkat, partai, kode_dapil: String(dapil.kode_dapil) });
        }
        const election2019 = await loadElection(c.env, '2019');
        const party2019 = election2019.partyByCode.get(partai);
        const [standings, levels, pairs, now, then] = await Promise.all([
            readKelurahanStandings(db, tingkat, kode_dapil, party.partai_id),
            readKecamatanAcrossLevels(db, tingkat, kode_dapil, party.partai_id),
            readPadananList(db, tingkat),
            readPartyVotesOfLevel(db, tingkat, party.partai_id),
            party2019 === undefined
                ? new Map<number, number>()
                : readPartyVotesOfLevel(c.env.DB_2019, tingkat, party2019.partai_id),
        ]);
        // Kelurahan votes the source repeats would double either figure: such a dapil has none.
        const isRepeated = checkPartySpread(standings.partyVotes, standings.partyAreas).status === 'tidak_sesuai';
        const room = isRepeated ? null : voteRoom(standings.kelurahan);
        const withheld = new Map(
            TINGKAT_NAMES.map((level) => {
                const holders = levels.holders.get(level);
                return [
                    level,
                    withheldKecamatan(holders?.kecamatan ?? [], holders?.dapilVotes ?? [], holders?.areaVotes ?? []),
                ];
            }),
        );
        const gap = isRepeated ? null : levelGapVotes(tingkat, levels.kecamatan, levels.votes, withheld);
        const own = votesByParty.get(party.partai_id) ?? 0;
        const data = recommend({
            votes: votesByParty,
            eligible: eligibleParties(election, tingkat),
            seats: dapil.jumlah_kursi,
            partyId: party.partai_id,
            shortfall,
            supporters: pendukung ?? 0,
            voteRoom: room === 0 ? null : room,
            levelGap: gap === 0 ? null : gap,
            history: historyOf(pairs, now, then, kode_dapil, own > 0 ? (shortfall / own) * 100 : 0),
        });
        return ok(c, data, {
            pemilu,
            tingkat,
            partai,
            kode_dapil: String(dapil.kode_dapil),
            nama_dapil: dapil.nama_dapil,
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

    // 23a. Where one candidate's votes come from, by kabupaten: the level the source counts whole. dpr_ri and
    // dprd_provinsi, 2024 only. The areas add up to the candidate's dapil votes.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/caleg/:partai/:nomor_urut/kabupaten', async (c) => {
        const { pemilu, election, db } = await election2024(c, ONLY_2024);
        const { tingkat, kode_dapil, partai, nomor_urut } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            partai: fields.partai,
            nomor_urut: fields.nomor_urut,
        });
        if (tingkat === 'dprd_kabupaten_kota') {
            throw notFound('tidak-tersedia', 'Dapil DPRD kabupaten/kota ada di dalam satu kabupaten/kota.');
        }
        const party = requireParty(election, partai);
        const found = await readCandidateKabupaten(db, tingkat, kode_dapil, {
            partyId: party.partai_id,
            nomorUrut: nomor_urut,
        });
        if (found.dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        if (found.candidate === null) {
            throw notFound(
                'caleg-tidak-ditemukan',
                `Caleg ${partai} nomor urut ${nomor_urut} tidak ada di dapil ${kode_dapil}.`,
            );
        }
        const recorded = found.kabupaten.reduce((sum, row) => sum + row.suara, 0);
        const wilayah = found.kabupaten.map((row) => ({
            kode_kabupaten: row.kode_kabupaten,
            nama_kabupaten: row.nama_kabupaten,
            suara: row.suara,
            suara_partai: row.suara_partai,
            persen_dari_partai: row.suara_partai > 0 ? round2((row.suara / row.suara_partai) * 100) : null,
            persen_dari_caleg:
                found.candidate !== null && found.candidate.suara > 0
                    ? round2((row.suara / found.candidate.suara) * 100)
                    : null,
        }));
        return ok(
            c,
            {
                caleg: {
                    kode_partai: partai,
                    nomor_urut: found.candidate.nomor_urut,
                    nama: found.candidate.nama,
                    jenis_kelamin: found.candidate.jenis_kelamin,
                    suara: found.candidate.suara,
                    kursi_ke: found.candidate.kursi_ke,
                },
                // Summed over the kabupaten, to set beside `caleg.suara`. Null where the dapil has no such rows.
                suara_tercatat: found.kabupaten.length === 0 ? null : recorded,
                wilayah: found.kabupaten.length === 0 ? null : wilayah,
            },
            {
                pemilu,
                tingkat,
                kode_dapil: String(found.dapil.kode_dapil),
                nama_dapil: found.dapil.nama_dapil,
                tingkat_wilayah: 'kabupaten',
                jumlah_kabupaten: found.kabupaten.length,
            },
        );
    });

    // 23b. Every candidate's votes per area of a dapil in one answer: what 23 and 23a give for one candidate,
    // for all of them. By kabupaten (dpr_ri and dprd_provinsi) the rekap, which adds up to the dapil; by kecamatan
    // the counts 23 would choose for each candidate, withheld on the same check. 2024 only.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/caleg-wilayah', async (c) => {
        const { pemilu, election, db } = await election2024(c, ONLY_2024);
        const { tingkat, kode_dapil, tingkat_wilayah } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            tingkat_wilayah: z.enum(['kabupaten', 'kecamatan']).default('kecamatan'),
        });
        const kodePartai = (partaiId: number) => partyCode(election, partaiId);
        if (tingkat_wilayah === 'kabupaten') {
            if (tingkat === 'dprd_kabupaten_kota') {
                throw notFound('tidak-tersedia', 'Dapil DPRD kabupaten/kota ada di dalam satu kabupaten/kota.');
            }
            const found = await readDapilKabupaten(db, tingkat, kode_dapil);
            if (found.dapil === null) {
                throw dapilNotFound(tingkat, kode_dapil, pemilu);
            }
            const byKabupaten = new Map<string, { nama: string; partai: unknown[]; caleg: unknown[] }>();
            for (const row of found.parties) {
                const entry = byKabupaten.get(row.kode_kabupaten) ?? {
                    nama: row.nama_kabupaten,
                    partai: [],
                    caleg: [],
                };
                entry.partai.push({ kode_partai: kodePartai(row.partai_id), suara: row.suara });
                byKabupaten.set(row.kode_kabupaten, entry);
            }
            let recorded = 0;
            for (const row of found.candidates) {
                recorded += row.suara;
                byKabupaten.get(row.kode_kabupaten)?.caleg.push({
                    kode_partai: kodePartai(row.partai_id),
                    nomor_urut: row.nomor_urut,
                    suara: row.suara,
                });
            }
            const wilayah = [...byKabupaten].map(([kode, entry]) => ({
                kode_kabupaten: kode,
                nama_kabupaten: entry.nama,
                partai: entry.partai,
                caleg: entry.caleg,
            }));
            return ok(
                c,
                {
                    suara_tercatat: found.candidates.length === 0 ? null : recorded,
                    wilayah: wilayah.length === 0 ? null : wilayah,
                },
                {
                    pemilu,
                    tingkat,
                    kode_dapil: String(found.dapil.kode_dapil),
                    nama_dapil: found.dapil.nama_dapil,
                    tingkat_wilayah: 'kabupaten',
                    jumlah_kabupaten: wilayah.length,
                },
            );
        }
        const found = await readDapilKecamatanCandidates(db, tingkat, kode_dapil);
        if (found.dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        const check = checkSpread(tingkat, found.candidates, found.areaTotals);
        const listed = new Map(found.candidates.map((row) => [`${row.partai_id}:${row.nomor_urut}`, row.suara]));
        // The same tolerance 23 holds a single candidate to. A candidate who carries repeated votes is left out
        // of the answer, as 23 leaves out that candidate's areas; the others stay.
        const recordedOf = new Map(found.areaTotals.map((row) => [`${row.partai_id}:${row.nomor_urut}`, row.suara]));
        const isSound = check.status === 'sesuai';
        const isRepeated = (partaiId: number, nomorUrut: number) => {
            const key = `${partaiId}:${nomorUrut}`;

            return (recordedOf.get(key) ?? 0) > toleratedVotes(listed.get(key) ?? 0);
        };
        const byKecamatan = new Map<number, { kode_partai: string; nomor_urut: number; suara: number }[]>();
        for (const row of found.votes) {
            if (row.suara <= 0 || isRepeated(row.partai_id, row.nomor_urut)) {
                continue;
            }
            const list = byKecamatan.get(row.kode) ?? [];
            list.push({ kode_partai: kodePartai(row.partai_id), nomor_urut: row.nomor_urut, suara: row.suara });
            byKecamatan.set(row.kode, list);
        }
        const wilayah = found.kecamatan.map((row) => ({
            kode_kecamatan: row.kode_kecamatan,
            nama_kecamatan: row.nama_kecamatan,
            caleg: byKecamatan.get(Number(row.kode_kecamatan)) ?? [],
        }));
        const recorded = found.areaTotals.reduce((sum, row) => sum + row.suara, 0);
        return ok(
            c,
            {
                suara_tercatat: check.status === 'tidak_tersedia' ? null : recorded,
                wilayah: isSound ? wilayah : null,
            },
            {
                pemilu,
                tingkat,
                kode_dapil: String(found.dapil.kode_dapil),
                nama_dapil: found.dapil.nama_dapil,
                tingkat_wilayah: 'kecamatan',
                jumlah_kecamatan: wilayah.length,
                sebaran_wilayah: check,
                sumber_wilayah: found.sumber,
            },
        );
    });

    // 23. Where one candidate's votes come from: every kecamatan of the dapil, or the kelurahan of one
    // kecamatan, beside the votes of the candidate's party there. Only where the areas agree with the dapil.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/caleg/:partai/:nomor_urut/wilayah', async (c) => {
        const { pemilu, election, db } = await election2024(c, ONLY_2024);
        const { tingkat, kode_dapil, partai, nomor_urut, kecamatan } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            partai: fields.partai,
            nomor_urut: fields.nomor_urut,
            kecamatan: fields.kode_kecamatan.optional(),
        });
        if (tingkat === 'dprd_provinsi' && kecamatan !== undefined) {
            throw notFound('tidak-tersedia', 'Suara caleg DPRD provinsi hanya tersedia sampai tingkat kecamatan.');
        }
        const party = requireParty(election, partai);
        const found = await readCandidateAreas(
            db,
            tingkat,
            kode_dapil,
            { partyId: party.partai_id, nomorUrut: nomor_urut },
            kecamatan ?? null,
        );
        if (found.dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        const candidate = found.candidates.find(
            (row) => row.partai_id === party.partai_id && row.nomor_urut === nomor_urut,
        );
        if (candidate === undefined) {
            throw notFound(
                'caleg-tidak-ditemukan',
                `Caleg ${partai} nomor urut ${nomor_urut} tidak ada di dapil ${kode_dapil}.`,
            );
        }
        const inside = kecamatan === undefined ? null : found.kecamatan.find((row) => row.kode_kecamatan === kecamatan);
        if (inside === undefined) {
            throw notFound('kecamatan-tidak-ditemukan', `Kecamatan ${kecamatan} tidak termasuk dapil ${kode_dapil}.`);
        }
        const check = checkSpread(tingkat, found.candidates, found.areaTotals);
        const recorded =
            found.areaTotals.find((row) => row.partai_id === party.partai_id && row.nomor_urut === nomor_urut)?.suara ??
            0;
        // A dapil can pass while one candidate in it carries repeated votes, so the candidate is held to the
        // same tolerance.
        // Below a kecamatan only kelurahan counts exist, so where the kecamatan counts alone passed there is nothing.
        const shown =
            check.status === 'sesuai' &&
            recorded <= toleratedVotes(candidate.suara) &&
            !(inside !== null && found.sumber === 'kecamatan');
        const partyCheck = checkPartySpread(found.dapilPartyVotes, found.dapilPartyAreas);
        const own = new Map(found.candidateVotes.map((row) => [row.kode, row]));
        // Party votes the source repeats are left out; the candidate's own are judged by their own check.
        const partyVotes = new Map(
            (partyCheck.status === 'tidak_sesuai' ? [] : found.partyVotes).map((row) => [row.kode, row]),
        );
        let areas = null;
        if (shown && inside === null) {
            areas = found.kecamatan.map((row) => {
                const kode = Number(row.kode_kecamatan);
                return {
                    kode_kecamatan: row.kode_kecamatan,
                    nama_kecamatan: row.nama_kecamatan,
                    ...besideParty(own.get(kode), partyVotes.get(kode)),
                };
            });
        } else if (shown) {
            const names = new Map(found.kelurahanNames.map((row) => [row.kode_kelurahan, row.nama_kelurahan]));
            areas = [...new Set([...own.keys(), ...partyVotes.keys()])]
                .sort((a, b) => a - b)
                .map((kode) => ({
                    kode_kelurahan: String(kode),
                    nama_kelurahan: names.get(kode) ?? null,
                    ...besideParty(own.get(kode), partyVotes.get(kode)),
                }));
        }
        const data = {
            caleg: {
                kode_partai: partai,
                nomor_urut: candidate.nomor_urut,
                nama: candidate.nama,
                jenis_kelamin: candidate.jenis_kelamin,
                suara: candidate.suara,
                kursi_ke: candidate.kursi_ke,
            },
            // False when the dapil marks no winner at all, so `caleg.kursi_ke` 0 says nothing.
            pemenang_ditandai: found.candidates.some((row) => row.kursi_ke > 0),
            // The candidate's votes summed over the areas, to set beside `caleg.suara`. Null without area rows.
            suara_tercatat: check.status === 'tidak_tersedia' ? null : recorded,
            // Null when the areas do not agree with the dapil totals, or there are none: see `meta.sebaran_wilayah`.
            wilayah: areas,
        };
        return ok(c, data, {
            pemilu,
            tingkat,
            kode_dapil: String(found.dapil.kode_dapil),
            nama_dapil: found.dapil.nama_dapil,
            tingkat_wilayah: inside === null ? 'kecamatan' : 'kelurahan',
            kode_kecamatan: inside?.kode_kecamatan ?? null,
            nama_kecamatan: inside?.nama_kecamatan ?? null,
            sebaran_wilayah: check,
            sebaran_partai: partyCheck,
            // Which counts `wilayah` is read from: kelurahan, kecamatan, or the larger of both for each (dpr_ri).
            sumber_wilayah: found.sumber,
        });
    });
}
