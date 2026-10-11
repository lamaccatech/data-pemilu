import type { Hono } from 'hono';
import { countedVotes, findStandouts, rankQuotients, round2 } from '../calc';
import { readAliases, readDapil, readDapilList, readPadanan, readPadananList } from '../db/dapil';
import { eligibleParties, loadElection, partyCode, requireParty } from '../db/election';
import { notFound } from '../errors';
import { type AppEnv, ok } from '../http/context';
import { dapilNotFound, election2024, electionOf, fields, optionalParty, parseParams } from '../http/params';
import { type DapilView, groupByDapil, summariseViews, viewDapil, votesMap } from '../service/dapil';
import { TINGKAT, TINGKAT_NAMES } from '../tingkat';

export function registerDapilRoutes(app: Hono<AppEnv>): void {
    // 1. The parties of an election.
    app.get('/v1/:pemilu/partai', async (c) => {
        const { pemilu, election } = await electionOf(c);
        parseParams(c, {});
        const passing = new Set(election.passingThreshold);
        const data = election.parties.map((party) => ({
            kode_partai: party.kode_partai,
            nama_partai: party.nama_partai,
            nomor_urut: party.partai_id,
            lolos_ambang_batas_dpr_ri: passing.has(party.partai_id),
        }));
        return ok(c, data, { pemilu, jumlah_partai: data.length });
    });

    // 10. How applications' own dapil names map to kode_dapil.
    app.get('/v1/:pemilu/dapil-alias', async (c) => {
        const { pemilu, db } = await election2024(c, 'Alias dapil');
        parseParams(c, {});
        const aliases = await readAliases(db);
        const data = aliases.map((alias) => ({
            tingkat: TINGKAT_NAMES.find((name) => TINGKAT[name] === alias.tingkat),
            nama_di_aplikasi: alias.nama_di_aplikasi,
            nama_dapil: alias.nama_dapil,
            kode_dapil: String(alias.kode_dapil),
        }));
        return ok(c, data, { pemilu, jumlah_alias: data.length });
    });

    // 2. Every dapil of a level, calculated for one party.
    app.get('/v1/:pemilu/:tingkat/dapil', async (c) => {
        const { pemilu, election, db } = await electionOf(c);
        const { tingkat, partai, provinsi, kabupaten } = parseParams(c, {
            tingkat: fields.tingkat,
            partai: fields.partai,
            provinsi: fields.provinsi.optional(),
            kabupaten: fields.kabupaten.optional(),
        });
        if (pemilu === '2019' && (provinsi !== undefined || kabupaten !== undefined)) {
            throw notFound(
                'tidak-tersedia',
                'Hasil Pemilu 2019 tidak memuat kode provinsi dan kabupaten, sehingga saringan wilayah hanya tersedia untuk Pemilu 2024.',
            );
        }
        const party = requireParty(election, partai);
        const list = await readDapilList(db, tingkat, party.partai_id, { provinsi, kabupaten });
        const votes = groupByDapil(list.votes);
        const candidates = groupByDapil(list.ownCandidates);
        const data = list.dapil.map(
            (dapil) =>
                viewDapil(
                    election,
                    tingkat,
                    dapil,
                    votesMap(votes.get(dapil.kode_dapil) ?? []),
                    candidates.get(dapil.kode_dapil) ?? [],
                    party,
                ).view,
        );
        return ok(c, data, { pemilu, tingkat, partai, ...summariseViews(data) });
    });

    // 3. One dapil: every party's votes and seats, and the quotients around the last seat.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil', async (c) => {
        const { pemilu, election, db } = await electionOf(c);
        const { tingkat, kode_dapil, partai } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            partai: fields.partai,
        });
        const party = requireParty(election, partai);
        const { dapil, votes, candidates } = await readDapil(db, tingkat, kode_dapil, party.partai_id);
        if (dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        const votesByParty = votesMap(votes);
        const { view, analysis } = viewDapil(election, tingkat, dapil, votesByParty, candidates, party);
        let pembagianKursi = null;
        if (analysis !== null) {
            const seats = analysis.jumlah_kursi;
            const ranked = rankQuotients(countedVotes(votesByParty, eligibleParties(election, tingkat)), seats)
                .slice(0, seats + 1)
                .map((entry, index) => ({
                    peringkat: index + 1,
                    kode_partai: partyCode(election, entry.partai_id),
                    suara: entry.suara,
                    pembagi: entry.pembagi,
                    hasil_bagi: round2(entry.hasil_bagi),
                    mendapat_kursi: index < seats,
                }));
            pembagianKursi = {
                kursi_terakhir: ranked[seats - 1] ?? null,
                kursi_pertama_yang_gagal: ranked[seats] ?? null,
                // Every winning quotient, highest first, followed by the first one that won nothing.
                tabel: ranked,
            };
        }
        const data = {
            ...view,
            partai: (analysis?.partai ?? []).map((row) => ({
                kode_partai: partyCode(election, row.partai_id),
                suara: row.suara,
                kursi: row.kursi,
                lolos_ambang_batas: row.lolos_ambang_batas,
            })),
            pembagian_kursi: pembagianKursi,
        };
        return ok(c, data, { pemilu, tingkat, partai, sumber_suara: [...new Set(votes.map((row) => row.sumber))] });
    });

    // 4. Candidates of a dapil, and the strongest ones who did not win a seat.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/caleg', async (c) => {
        const { pemilu, election, db } = await electionOf(c);
        const { tingkat, kode_dapil, partai } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            partai: fields.partai.optional(),
        });
        const party = optionalParty(election, partai);
        // Every party's candidates are read even with a party filter: tokoh_menonjol looks across the dapil.
        const { dapil, votes, candidates } = await readDapil(db, tingkat, kode_dapil);
        if (dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        const votesByParty = votesMap(votes);
        const complete = dapil.jumlah_kursi !== null && votes.some((row) => row.suara > 0);
        const caleg = candidates
            .filter((row) => party === null || row.partai_id === party.partai_id)
            .map((row) => ({
                kode_partai: partyCode(election, row.partai_id),
                nomor_urut: row.nomor_urut,
                nama: row.nama,
                jenis_kelamin: row.jenis_kelamin,
                suara: row.suara,
                kursi_ke: row.kursi_ke,
            }));
        // Without party votes the shares cannot be worked out, as in the reference.
        const tokohMenonjol = complete
            ? findStandouts(votesByParty, candidates, party?.partai_id ?? null).map(({ partai_id, ...rest }) => ({
                  kode_partai: partyCode(election, partai_id),
                  ...rest,
              }))
            : null;
        return ok(
            c,
            { caleg, tokoh_menonjol: tokohMenonjol },
            {
                pemilu,
                tingkat,
                kode_dapil: String(dapil.kode_dapil),
                nama_dapil: dapil.nama_dapil,
                partai: partai ?? null,
                jumlah_caleg: caleg.length,
                data_lengkap: complete,
            },
        );
    });

    // 13. Every 2024 dapil of a level that has a comparable 2019 dapil, so a caller can compare a whole
    // level by reading the two dapil lists once instead of asking per dapil.
    app.get('/v1/:pemilu/:tingkat/padanan', async (c) => {
        const { pemilu, db } = await election2024(c, 'Padanan dapil');
        const { tingkat } = parseParams(c, { tingkat: fields.tingkat });
        const pairs = await readPadananList(db, tingkat);
        const data = pairs.map((pair) => ({
            kode_dapil: String(pair.kode_dapil_2024),
            kode_dapil_2019: String(pair.kode_dapil_2019),
        }));
        return ok(c, data, { pemilu, tingkat, jumlah_padanan: data.length });
    });

    // 9. The matching 2019 dapil and, when the two are comparable, the 2019 calculation for the same party.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/padanan', async (c) => {
        const { pemilu, election, db } = await election2024(c, 'Padanan dapil');
        const { tingkat, kode_dapil, partai } = parseParams(c, {
            tingkat: fields.tingkat,
            kode_dapil: fields.kode_dapil,
            partai: fields.partai.optional(),
        });
        optionalParty(election, partai);
        const { dapil, padanan } = await readPadanan(db, tingkat, kode_dapil);
        if (dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        let hasil2019: DapilView | null = null;
        let partaiAdaDi2019: boolean | null = null;
        if (padanan !== null && padanan.sebanding === 1 && partai !== undefined) {
            // D1 cannot join across databases: the 2019 figures come from a second query.
            const election2019 = await loadElection(c.env, '2019');
            const party2019 = election2019.partyByCode.get(partai);
            partaiAdaDi2019 = party2019 !== undefined;
            if (party2019 !== undefined) {
                const before = await readDapil(c.env.DB_2019, tingkat, padanan.kode_dapil_2019, party2019.partai_id);
                if (before.dapil !== null) {
                    hasil2019 = viewDapil(
                        election2019,
                        tingkat,
                        before.dapil,
                        votesMap(before.votes),
                        before.candidates,
                        party2019,
                    ).view;
                }
            }
        }
        const data = {
            kode_dapil: String(dapil.kode_dapil),
            nama_dapil: dapil.nama_dapil,
            padanan:
                padanan === null
                    ? null
                    : {
                          kode_dapil_2019: String(padanan.kode_dapil_2019),
                          nama_dapil_2019: padanan.nama_dapil_2019,
                          sebanding: padanan.sebanding === 1,
                          ada_di_hasil_2019: padanan.ada_di_hasil_2019 === 1,
                          ada_di_hasil_2024: padanan.ada_di_hasil_2024 === 1,
                      },
            hasil_2019: hasil2019,
        };
        return ok(c, data, { pemilu, tingkat, partai: partai ?? null, partai_ada_di_2019: partaiAdaDi2019 });
    });
}
