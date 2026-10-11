import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import fixtures from '../../reference/fixtures.json';
import { normalizePersonName } from '../../src/calc';
import { call, json } from './helpers';

const fixture = (pemilu: number, tingkat: string, predicate: (expected: Expected) => boolean = () => true) => {
    const found = fixtures.dapil.find(
        ({ expected }) => expected.pemilu === pemilu && expected.tingkat === tingkat && predicate(expected as Expected),
    );
    if (found === undefined) {
        throw new Error(`no fixture for ${pemilu} ${tingkat}`);
    }
    return found.expected as Expected;
};

interface Expected {
    pemilu: number;
    tingkat: string;
    kode_dapil: string;
    nama_dapil: string;
    jumlah_kursi: number;
    total_suara_sah: number;
    dapat_dihitung: boolean;
    harga_kursi_terakhir?: number;
    partai?: { partai_id: number; suara: number; kursi: number }[];
    partai_sendiri?: Record<string, number | boolean | null>;
    tokoh_menonjol?: Record<string, unknown>[];
}

describe('authentication', () => {
    it('refuses a request without a key', async () => {
        const { status, body } = await json('/v1/2024/partai', null);
        expect(status).toBe(401);
        expect(body).toEqual({ error: { code: 'tidak-berwenang', message: expect.any(String) } });
    });

    it('refuses an unknown key', async () => {
        expect((await json('/v1/2024/partai', 'salah')).status).toBe(401);
    });

    it('accepts a known key for any party', async () => {
        const { status, body } = await json('/v1/2024/partai');
        expect(status).toBe(200);
        expect(body.data).toHaveLength(24);
        expect(body.data[11]).toMatchObject({ kode_partai: 'pan', nomor_urut: 12 });
        expect(body.meta).toEqual({ pemilu: '2024', jumlah_partai: 24 });
    });

    it('leaves /healthz open', async () => {
        expect((await call('/healthz', null)).status).toBe(200);
    });
});

describe('routing and validation', () => {
    it.each([
        ['/v1/2014/partai', 404, 'pemilu-tidak-ditemukan'],
        ['/v1/2024/dpd/dapil?partai=pan', 400, 'parameter-tidak-valid'],
        ['/v1/2024/dprd_provinsi/dapil', 400, 'parameter-tidak-valid'],
        ['/v1/2024/dprd_provinsi/dapil?partai=PAN', 400, 'parameter-tidak-valid'],
        ['/v1/2024/dprd_provinsi/dapil?partai=pan&prov=11', 400, 'parameter-tidak-valid'],
        ['/v1/2024/dprd_provinsi/dapil?partai=pan&provinsi=aceh', 400, 'parameter-tidak-valid'],
        ['/v1/2024/dprd_provinsi/dapil/abc?partai=pan', 400, 'parameter-tidak-valid'],
        ['/v1/2024/dprd_provinsi/dapil?partai=tidak_ada', 404, 'partai-tidak-ditemukan'],
        ['/v1/2024/dprd_provinsi/dapil/999999?partai=pan', 404, 'dapil-tidak-ditemukan'],
        ['/v1/2024/dprd_provinsi/dapil/999999/caleg', 404, 'dapil-tidak-ditemukan'],
        ['/v1/2019/dprd_provinsi/dapil?partai=pan&provinsi=11', 404, 'tidak-tersedia'],
        ['/v1/2019/dpr_ri/dapil/1101/padanan', 404, 'tidak-tersedia'],
        ['/v1/2019/dapil-alias', 404, 'tidak-tersedia'],
        ['/v1/2024/tidak-ada', 404, 'tidak-ditemukan'],
    ])('%s answers %i %s', async (path, expectedStatus, code) => {
        const response = await call(path);
        const body = (await response.json()) as { error: { code: string; message: string } };
        expect(response.status).toBe(expectedStatus);
        expect(body.error.code).toBe(code);
        expect(body.error.message.length).toBeGreaterThan(0);
    });

    it('accepts a version marker from the caller and still refuses other unknown parameters', async () => {
        const marked = await json('/v1/2024/partai?__versi=7');
        expect(marked.status).toBe(200);
        expect(marked.body.data).toHaveLength(24);
        expect((await json('/v1/2024/partai?versi=7')).status).toBe(400);
    });

    it('names the faulty parameter in Indonesian', async () => {
        const { body } = await json('/v1/2024/dprd_provinsi/dapil?prov=11');
        expect(body.error.message).toContain('partai wajib diisi');
        expect(body.error.message).toContain('parameter tidak dikenal: prov');
    });

    it('takes the election from the hostname when the path has none', async () => {
        const viaHost = await json('/v1/partai', undefined, 'https://pemilu2019.lamaccaservices.com');
        expect(viaHost.status).toBe(200);
        expect(viaHost.body.meta.pemilu).toBe('2019');
        expect(viaHost.body.data).toHaveLength(20);
        const viaPath = await json('/v1/2024/partai', undefined, 'https://pemilu2019.lamaccaservices.com');
        expect(viaPath.body.meta.pemilu).toBe('2024');
    });
});

describe('caching', () => {
    it('serves the second request from the Cache API, and never without a key', async () => {
        const path = '/v1/2024/partai?cache=1';
        // An unknown parameter is a 400, which must not be cached.
        expect((await call(path)).headers.get('X-Cache')).toBeNull();
        expect((await call(path)).headers.get('Cache-Control')).toBe('no-store');

        const url = '/v1/2019/partai';
        const first = await call(url);
        expect(first.headers.get('X-Cache')).toBe('MISS');
        expect(first.headers.get('Cache-Control')).toBe('private, max-age=86400');
        const body = await first.text();
        const second = await call(url);
        expect(second.headers.get('X-Cache')).toBe('HIT');
        expect(second.headers.get('Cache-Control')).toBe('private, max-age=86400');
        expect(await second.text()).toBe(body);
        expect((await call(url, null)).status).toBe(401);
    });
});

describe('dapil endpoints against the fixtures', () => {
    // dpr_ri needs the national totals of all 84 dapil, so it is checked against the loaded database in
    // test/data. These levels have no threshold and can be checked from the fixtures alone.
    const cases = fixtures.dapil
        .map(({ expected }) => expected as Expected)
        .filter((expected) => expected.pemilu === 2024 && expected.tingkat !== 'dpr_ri' && expected.dapat_dihitung);

    it('has fixtures to check', () => {
        expect(cases.length).toBe(3);
    });

    it.each(cases.map((expected) => [`${expected.tingkat} ${expected.kode_dapil}`, expected] as const))(
        'GET dapil %s gives the reference figures for pan',
        async (_label, expected) => {
            const { status, body } = await json(`/v1/2024/${expected.tingkat}/dapil/${expected.kode_dapil}?partai=pan`);
            const own = expected.partai_sendiri ?? {};
            expect(status).toBe(200);
            expect(body.data).toMatchObject({
                kode_dapil: expected.kode_dapil,
                nama_dapil: expected.nama_dapil,
                jumlah_kursi: expected.jumlah_kursi,
                total_suara_sah: expected.total_suara_sah,
                data_lengkap: true,
                suara_partai: own.suara,
                kursi_partai: own.kursi,
                harga_kursi_terakhir: expected.harga_kursi_terakhir,
                target_suara_kursi_pertama: own.target_suara_kursi_pertama,
                selisih_kursi_pertama: own.selisih_kursi_pertama,
                target_suara_kursi_berikutnya: own.target_suara_kursi_berikutnya,
                kekurangan_kursi_berikutnya: own.kekurangan_kursi_berikutnya,
                suara_caleg_batas: own.suara_caleg_batas,
            });
            expect(body.data.partai.map((row: { suara: number; kursi: number }) => [row.suara, row.kursi])).toEqual(
                expected.partai?.map((row) => [row.suara, row.kursi]),
            );
            expect(['aman', 'waspada', 'rawan', 'kosong']).toContain(body.data.kuadran);
            expect(body.data.kuadran === 'kosong').toBe(own.kursi === 0);

            const { kursi_terakhir, kursi_pertama_yang_gagal, tabel } = body.data.pembagian_kursi;
            expect(tabel).toHaveLength(expected.jumlah_kursi + 1);
            expect(Math.ceil(kursi_terakhir.suara / kursi_terakhir.pembagi)).toBe(expected.harga_kursi_terakhir);
            expect(kursi_terakhir).toMatchObject({ peringkat: expected.jumlah_kursi, mendapat_kursi: true });
            expect(kursi_pertama_yang_gagal).toMatchObject({
                peringkat: expected.jumlah_kursi + 1,
                mendapat_kursi: false,
            });
        },
    );

    it.each(cases.map((expected) => [`${expected.tingkat} ${expected.kode_dapil}`, expected] as const))(
        'GET caleg %s gives tokoh_menonjol as in the reference',
        async (_label, expected) => {
            const { body } = await json(`/v1/2024/${expected.tingkat}/dapil/${expected.kode_dapil}/caleg?partai=pan`);
            const withoutParty = (row: Record<string, unknown>) => {
                // suara_2019 is looked up for the API only; the reference has no such figure.
                const { partai_id: _id, kode_partai: _code, suara_2019: _before, ...rest } = row;
                return rest;
            };
            expect(body.data.caleg.every((row: { kode_partai: string }) => row.kode_partai === 'pan')).toBe(true);
            expect(body.meta.data_lengkap).toBe(true);
            const everyone = await json(`/v1/2024/${expected.tingkat}/dapil/${expected.kode_dapil}/caleg`);
            expect(everyone.body.data.caleg.length).toBeGreaterThan(body.data.caleg.length);
            const winnersMarked = everyone.body.data.caleg.some((row: { kursi_ke: number }) => row.kursi_ke > 0);
            expect(body.meta.pemenang_ditandai).toBe(winnersMarked);
            if (!winnersMarked) {
                // The reference still lists the strongest "unseated" candidates here, who are the winners
                // themselves. The API names nobody.
                expect(body.data.tokoh_menonjol).toBeNull();
                expect(everyone.body.data.tokoh_menonjol).toBeNull();
                return;
            }
            expect(body.data.tokoh_menonjol.map(withoutParty)).toEqual(expected.tokoh_menonjol?.map(withoutParty));
            expect(
                everyone.body.data.tokoh_menonjol.some((row: { partai_sendiri: boolean }) => row.partai_sendiri),
            ).toBe(false);
        },
    );

    it('reports a dapil without party votes instead of calculating from nothing', async () => {
        const missing = fixture(2024, 'dprd_kabupaten_kota', (expected) => !expected.dapat_dihitung);
        const { status, body } = await json(`/v1/2024/dprd_kabupaten_kota/dapil/${missing.kode_dapil}?partai=pan`);
        expect(status).toBe(200);
        expect(body.data).toMatchObject({
            data_lengkap: false,
            total_suara_sah: null,
            suara_partai: null,
            harga_kursi_terakhir: null,
            kuadran: null,
            peluang_dekat: null,
            pembagian_kursi: null,
            partai: [],
        });
        const caleg = await json(`/v1/2024/dprd_kabupaten_kota/dapil/${missing.kode_dapil}/caleg`);
        expect(caleg.body.data.tokoh_menonjol).toBeNull();
        expect(caleg.body.meta.data_lengkap).toBe(false);
    });

    it('lists the dapil of a level with a summary', async () => {
        const { body } = await json('/v1/2024/dprd_kabupaten_kota/dapil?partai=pan');
        expect(body.data).toHaveLength(3);
        expect(body.meta).toMatchObject({
            pemilu: '2024',
            tingkat: 'dprd_kabupaten_kota',
            partai: 'pan',
            jumlah_dapil: 3,
        });
        expect(body.meta.dapil_tanpa_data).toBe(1);
        expect(body.meta.kursi_partai).toBe(1);
        const single = await json(`/v1/2024/dprd_kabupaten_kota/dapil/${body.data[0].kode_dapil}?partai=pan`);
        expect(single.body.data).toMatchObject(body.data[0]);
    });

    it('filters the list by region', async () => {
        const { body } = await json('/v1/2024/dprd_kabupaten_kota/dapil?partai=pan&provinsi=99');
        expect(body.data).toEqual([]);
        expect(body.meta.jumlah_dapil).toBe(0);
    });

    it('answers for any party, not only the one the fixtures were made for', async () => {
        const provinsi = fixture(2024, 'dprd_provinsi');
        const { body } = await json(`/v1/2024/dprd_provinsi/dapil/${provinsi.kode_dapil}?partai=pkb`);
        const pkb = provinsi.partai?.find((row) => row.partai_id === 1);
        expect(body.data).toMatchObject({ suara_partai: pkb?.suara, kursi_partai: pkb?.kursi });
    });
});

describe('padanan and alias', () => {
    it('returns the matching 2019 dapil with the 2019 figures of the same party', async () => {
        const before = fixture(2019, 'dpr_ri');
        const { status, body } = await json('/v1/2024/dpr_ri/dapil/1101/padanan?partai=pan');
        expect(status).toBe(200);
        expect(body.data.padanan).toEqual({
            kode_dapil_2019: '1101',
            nama_dapil_2019: 'ACEH I',
            sebanding: true,
            ada_di_hasil_2019: true,
            ada_di_hasil_2024: true,
        });
        expect(body.data.hasil_2019).toMatchObject({
            kode_dapil: '1101',
            jumlah_kursi: before.jumlah_kursi,
            total_suara_sah: before.total_suara_sah,
            suara_partai: before.partai_sendiri?.suara,
        });
        expect(body.meta.partai_ada_di_2019).toBe(true);
    });

    it('gives only the mapping without a party, and no 2019 figures for a party that did not run', async () => {
        expect((await json('/v1/2024/dpr_ri/dapil/1101/padanan')).body.data.hasil_2019).toBeNull();
        const gelora = await json('/v1/2024/dpr_ri/dapil/1101/padanan?partai=gelora');
        expect(gelora.body.data.hasil_2019).toBeNull();
        expect(gelora.body.meta.partai_ada_di_2019).toBe(false);
    });

    it('says so when a dapil has no 2019 match', async () => {
        const provinsi = fixture(2024, 'dprd_provinsi');
        const { status, body } = await json(`/v1/2024/dprd_provinsi/dapil/${provinsi.kode_dapil}/padanan?partai=pan`);
        expect(status).toBe(200);
        expect(body.data).toMatchObject({ padanan: null, hasil_2019: null });
    });

    it('adds the 2019 votes of a same-named candidate to the 2024 standouts', async () => {
        const earlier = fixtures.dapil.find(
            ({ expected }) =>
                expected.pemilu === 2019 && expected.tingkat === 'dpr_ri' && String(expected.kode_dapil) === '1101',
        );
        const votesByName = new Map<string, number>();
        for (const row of earlier?.input.caleg ?? []) {
            const name = normalizePersonName(row.nama);
            votesByName.set(name, Math.max(votesByName.get(name) ?? 0, Number(row.suara)));
        }
        const { body } = await json('/v1/2024/dpr_ri/dapil/1101/caleg');
        expect(body.data.tokoh_menonjol.length).toBeGreaterThan(0);
        for (const standout of body.data.tokoh_menonjol as { nama: string; suara_2019: number | null }[]) {
            expect(standout.suara_2019).toBe(votesByName.get(normalizePersonName(standout.nama)) ?? null);
        }
        const in2019 = await json('/v1/2019/dpr_ri/dapil/1101/caleg');
        expect(
            in2019.body.data.tokoh_menonjol.every((row: { suara_2019: number | null }) => row.suara_2019 === null),
        ).toBe(true);
    });

    it('marks every 2024 candidate whose name stood in the comparable 2019 dapil', async () => {
        const { body } = await json('/v1/2024/dpr_ri/dapil/1101/caleg');
        expect(body.meta.padanan_2019_tersedia).toBe(true);
        const before = await json('/v1/2019/dpr_ri/dapil/1101/caleg');
        const earlier = new Map<string, { suara: number; kode_partai: string; kursi_ke: number }>();
        for (const row of before.body.data.caleg) {
            const name = normalizePersonName(row.nama);
            if (name !== '' && row.suara >= (earlier.get(name)?.suara ?? 0)) {
                earlier.set(name, row);
            }
        }
        const marked = body.data.caleg.filter((row: { pemilu_2019: unknown }) => row.pemilu_2019 !== null);
        expect(marked.length).toBeGreaterThan(0);
        for (const row of body.data.caleg) {
            const match = earlier.get(normalizePersonName(row.nama));
            expect(row.pemilu_2019).toEqual(
                match === undefined
                    ? null
                    : { suara: match.suara, kode_partai: match.kode_partai, terpilih: match.kursi_ke > 0 },
            );
        }
        // 2019 has no earlier election here and no votes below dapil level.
        expect(before.body.meta).toMatchObject({ padanan_2019_tersedia: false, sebaran_wilayah: null });
        expect(before.body.data.caleg.every((row: { pemilu_2019: unknown }) => row.pemilu_2019 === null)).toBe(true);
        // A level without a comparable dapil says so, instead of looking like nobody stood before.
        const provinsi = fixtures.dapil.find(({ expected }) => expected.tingkat === 'dprd_provinsi');
        const without = await json(`/v1/2024/dprd_provinsi/dapil/${provinsi?.expected.kode_dapil}/caleg`);
        expect(without.body.meta.padanan_2019_tersedia).toBe(false);
    });

    it('lists the comparable pairs of a level', async () => {
        const { status, body } = await json('/v1/2024/dpr_ri/padanan');
        expect(status).toBe(200);
        expect(body.data).toEqual([{ kode_dapil: '1101', kode_dapil_2019: '1101' }]);
        expect(body.meta).toMatchObject({ tingkat: 'dpr_ri', jumlah_padanan: 1 });
        expect((await json('/v1/2019/dpr_ri/padanan')).status).toBe(404);
    });

    it('lists the aliases', async () => {
        const { body } = await json('/v1/2024/dapil-alias');
        expect(body.data).toEqual([
            { tingkat: 'dpr_ri', nama_di_aplikasi: 'SUMUT I', nama_dapil: 'SUMATERA UTARA I', kode_dapil: '1201' },
        ]);
    });
});

describe('persaingan', () => {
    it('gives the same seat margin in the list of a level as in the contest of a dapil', async () => {
        const list = await json('/v1/2024/dpr_ri/dapil?partai=pan');
        const aceh = list.body.data.find((row: { kode_dapil: string }) => row.kode_dapil === '1101');
        const contest = await json('/v1/2024/dpr_ri/dapil/1101/persaingan');
        const pan = contest.body.data.partai.find((row: { kode_partai: string }) => row.kode_partai === 'pan');
        expect(aceh.margin_kursi).toBe(pan.margin_kursi);
        // No seat, no margin.
        for (const row of list.body.data) {
            expect(row.margin_kursi === null).toBe(row.kursi_partai === null || row.kursi_partai === 0);
        }
    });

    it('calculates every party of a dapil the way the focus party is calculated', async () => {
        const { status, body } = await json('/v1/2024/dpr_ri/dapil/1101/persaingan');
        expect(status).toBe(200);
        expect(body.data.data_lengkap).toBe(true);
        const detail = await json('/v1/2024/dpr_ri/dapil/1101?partai=pan');
        expect(body.data.harga_kursi_terakhir).toBe(detail.body.data.harga_kursi_terakhir);
        const pan = body.data.partai.find((row: { kode_partai: string }) => row.kode_partai === 'pan');
        expect(pan).toMatchObject({
            suara: detail.body.data.suara_partai,
            kursi: detail.body.data.kursi_partai,
            kuadran: detail.body.data.kuadran,
            peluang_dekat: detail.body.data.peluang_dekat,
            kekurangan_kursi_berikutnya: detail.body.data.kekurangan_kursi_berikutnya,
        });
        const votes = body.data.partai.map((row: { suara: number }) => row.suara);
        expect(votes).toEqual([...votes].sort((a, b) => b - a));
    });

    it('lists the seats in the order they were won, then the first quotient that won nothing', async () => {
        const { body } = await json('/v1/2024/dpr_ri/dapil/1101/persaingan');
        const { tabel, kursi_terakhir, kursi_pertama_yang_gagal } = body.data.pembagian_kursi;
        expect(tabel).toHaveLength(body.data.jumlah_kursi + 1);
        expect(kursi_terakhir).toEqual(tabel[body.data.jumlah_kursi - 1]);
        expect(kursi_pertama_yang_gagal).toMatchObject({ mendapat_kursi: false });
        const seatsWon = new Map<string, number>();
        for (const row of tabel.filter((entry: { mendapat_kursi: boolean }) => entry.mendapat_kursi)) {
            seatsWon.set(row.kode_partai, (seatsWon.get(row.kode_partai) ?? 0) + 1);
            expect(row.kursi_partai_ke).toBe(seatsWon.get(row.kode_partai));
        }
        for (const party of body.data.partai) {
            expect(party.kursi).toBe(seatsWon.get(party.kode_partai) ?? 0);
        }
    });

    it('splits a party vote into symbol and candidates, and names the cheapest seat to take', async () => {
        const { body } = await json('/v1/2024/dpr_ri/dapil/1101/persaingan');
        for (const party of body.data.partai) {
            if (party.suara_caleg !== null) {
                expect(party.suara_caleg + party.suara_gambar).toBe(party.suara);
                expect(party.caleg_teratas.suara).toBeLessThanOrEqual(party.suara_caleg);
            }
            // A seat holder has votes to spare; a party without one has none to speak of.
            expect(party.margin_kursi === null).toBe(party.kursi === 0);
            // Under the national threshold no gain in one dapil wins a seat.
            if (!party.lolos_ambang_batas) {
                expect(party).toMatchObject({ kursi: 0, kuadran: 'kosong', kekurangan_kursi_berikutnya: null });
            }
        }
        const shortfalls = body.data.partai
            .map((row: { kekurangan_kursi_berikutnya: number | null }) => row.kekurangan_kursi_berikutnya)
            .filter((value: number | null) => value !== null);
        expect(body.data.penantang_terdekat.kekurangan).toBe(Math.min(...shortfalls));
    });

    it('sets the 2019 result of the same party beside it when the dapil is comparable', async () => {
        const before = fixture(2019, 'dpr_ri');
        const { body } = await json('/v1/2024/dpr_ri/dapil/1101/persaingan');
        expect(body.data.padanan_2019).toEqual({
            kode_dapil_2019: '1101',
            nama_dapil_2019: 'ACEH I',
            jumlah_kursi: before.jumlah_kursi,
            total_suara_sah: before.total_suara_sah,
            harga_kursi_terakhir: before.harga_kursi_terakhir,
        });
        const pan = body.data.partai.find((row: { kode_partai: string }) => row.kode_partai === 'pan');
        expect(pan.hasil_2019).toMatchObject({
            suara: before.partai_sendiri?.suara,
            kursi: before.partai_sendiri?.kursi,
        });
        // The 2019 side is calculated the same way, so it agrees with asking 2019 directly.
        const earlier = await json('/v1/2019/dpr_ri/dapil/1101/persaingan');
        const panThen = earlier.body.data.partai.find((row: { kode_partai: string }) => row.kode_partai === 'pan');
        expect(pan.hasil_2019).toEqual({
            suara: panThen.suara,
            persen_suara: panThen.persen_suara,
            kursi: panThen.kursi,
            peringkat: panThen.peringkat,
            persen_suara_gambar: panThen.persen_suara_gambar,
            caleg_terpilih: panThen.caleg_terpilih.map(
                ({ nomor_urut, nama, suara }: { nomor_urut: number; nama: string; suara: number }) => ({
                    nomor_urut,
                    nama,
                    suara,
                }),
            ),
        });
        // Gelora did not exist in 2019.
        const gelora = body.data.partai.find((row: { kode_partai: string }) => row.kode_partai === 'gelora');
        expect(gelora.hasil_2019).toBeNull();
    });

    it('has no 2019 comparison for a dapil without a match, or for 2019 itself', async () => {
        const provinsi = fixture(2024, 'dprd_provinsi');
        const unmatched = await json(`/v1/2024/dprd_provinsi/dapil/${provinsi.kode_dapil}/persaingan`);
        expect(unmatched.body.data.padanan_2019).toBeNull();
        const earlier = await json('/v1/2019/dpr_ri/dapil/1101/persaingan');
        expect(earlier.status).toBe(200);
        expect(earlier.body.data.padanan_2019).toBeNull();
        expect(earlier.body.data.partai.every((row: { hasil_2019: unknown }) => row.hasil_2019 === null)).toBe(true);
    });

    it('refuses a party parameter and an unknown dapil', async () => {
        expect((await json('/v1/2024/dpr_ri/dapil/1101/persaingan?partai=pan')).status).toBe(400);
        expect((await json('/v1/2024/dpr_ri/dapil/999999/persaingan')).body.error.code).toBe('dapil-tidak-ditemukan');
    });

    it('ranks the parties by votes and sets each seat holder against the same name in 2019', async () => {
        const { body } = await json('/v1/2024/dpr_ri/dapil/1101/persaingan');
        expect(body.data.partai.map((row: { peringkat: number }) => row.peringkat)).toEqual(
            body.data.partai.map((_: unknown, index: number) => index + 1),
        );
        const earlier = fixtures.dapil.find(
            ({ expected }) =>
                expected.pemilu === 2019 && expected.tingkat === 'dpr_ri' && String(expected.kode_dapil) === '1101',
        );
        const then = new Map<string, { suara: number; terpilih: boolean }>();
        for (const row of earlier?.input.caleg ?? []) {
            const name = normalizePersonName(row.nama);
            const known = then.get(name);
            if (known === undefined || Number(row.suara) > known.suara) {
                then.set(name, { suara: Number(row.suara), terpilih: Number(row.kursi_ke) > 0 });
            }
        }
        let holders = 0;
        for (const party of body.data.partai) {
            for (const holder of party.caleg_terpilih) {
                holders++;
                const match = then.get(normalizePersonName(holder.nama));
                expect(holder.suara_2019).toBe(match?.suara ?? null);
                expect(holder.terpilih_2019).toBe(match?.terpilih ?? false);
            }
        }
        expect(holders).toBeGreaterThan(0);
        // 2019 itself has nothing earlier to be set against.
        const before = await json('/v1/2019/dpr_ri/dapil/1101/persaingan');
        const seated = before.body.data.partai.flatMap((row: { caleg_terpilih: unknown[] }) => row.caleg_terpilih);
        expect(seated.every((row: { terpilih_2019: unknown }) => row.terpilih_2019 === null)).toBe(true);
    });
});

describe('persaingan of a whole level', () => {
    it('gives every party of every dapil with the seats it won', async () => {
        const { status, body } = await json('/v1/2024/dpr_ri/persaingan');
        expect(status).toBe(200);
        const aceh = body.data.find((row: { kode_dapil: string }) => row.kode_dapil === '1101');
        const detail = await json('/v1/2024/dpr_ri/dapil/1101/persaingan');
        expect(aceh).toMatchObject({ nama_dapil: 'ACEH I', data_lengkap: true });
        expect(aceh.total_suara_sah).toBe(detail.body.data.total_suara_sah);
        expect(aceh.pemegang_kursi_terakhir).toBe(detail.body.data.pembagian_kursi.kursi_terakhir.kode_partai);
        expect(aceh.partai).toEqual(
            detail.body.data.partai
                .filter((row: { suara: number }) => row.suara > 0)
                .map(({ kode_partai, suara, kursi }: { kode_partai: string; suara: number; kursi: number }) => ({
                    kode_partai,
                    suara,
                    kursi,
                })),
        );
        expect(body.meta).toMatchObject({ pemilu: '2024', tingkat: 'dpr_ri', jumlah_dapil: body.data.length });
    });

    it('takes no party, and region filters for 2024 only', async () => {
        expect((await json('/v1/2024/dpr_ri/persaingan?partai=pan')).status).toBe(400);
        expect((await json('/v1/2019/dpr_ri/persaingan?provinsi=11')).body.error.code).toBe('tidak-tersedia');
        expect((await json('/v1/2019/dpr_ri/persaingan')).status).toBe(200);
    });
});

describe('susunan suara', () => {
    it('splits symbol and candidates, and leaves a 2024 area without kecamatan unmapped', async () => {
        const { status, body } = await json('/v1/2024/dpr_ri/kekuatan?partai=pan');
        expect(status).toBe(200);
        expect(body.data.suara_gambar + body.data.suara_caleg).toBe(body.data.suara_terbagi);
        expect(
            body.data.pemukiman.kota + body.data.pemukiman.kabupaten + body.data.pemukiman.belum_terpetakan,
        ).toBeGreaterThan(0);
        const list = await json('/v1/2024/dpr_ri/dapil?partai=pan');
        const votes = list.body.data.reduce(
            (sum: number, row: { suara_partai: number | null }) => sum + (row.suara_partai ?? 0),
            0,
        );
        expect(body.data.pemukiman).toEqual({ kota: 0, kabupaten: 0, belum_terpetakan: votes });
    });

    it('keeps a pure dapil whole and splits a mixed one only when kelurahan do not exceed it', async () => {
        const party = await env.DB_2024.prepare("SELECT partai_id AS id FROM partai WHERE kode_partai = 'pan'").first<{
            id: number;
        }>();
        const partyId = party?.id;
        if (partyId === undefined) {
            throw new Error('pan is not seeded');
        }
        const db = env.DB_2024;
        const insert = [
            db
                .prepare(
                    'INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, kode_provinsi, kode_kabupaten, jumlah_kursi, total_suara_sah) VALUES (1, ?, ?, 98, NULL, 1, ?)',
                )
                .bind(9901, 'UJI KOTA', 100),
            db
                .prepare(
                    'INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, kode_provinsi, jumlah_kursi, total_suara_sah) VALUES (1, 9902, ?, 98, 1, 200)',
                )
                .bind('UJI KAB'),
            db
                .prepare(
                    'INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, kode_provinsi, jumlah_kursi, total_suara_sah) VALUES (1, 9903, ?, 98, 1, 300)',
                )
                .bind('UJI CAMPUR'),
            db
                .prepare(
                    'INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, kode_provinsi, jumlah_kursi, total_suara_sah) VALUES (1, 9904, ?, 98, 1, 100)',
                )
                .bind('UJI LEBIH'),
            // A city dapil that also holds a polling place abroad, whose code is not a kecamatan code.
            db
                .prepare(
                    'INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, kode_provinsi, jumlah_kursi, total_suara_sah) VALUES (1, 9905, ?, 98, 1, 100)',
                )
                .bind('UJI LUAR NEGERI'),
            db
                .prepare(
                    "INSERT INTO suara_partai (tingkat, kode_dapil, partai_id, suara, sumber) VALUES (1, 9905, ?, 100, 'uji')",
                )
                .bind(partyId),
            db.prepare(
                "INSERT INTO dapil_kecamatan (tingkat, kode_dapil, kode_kecamatan, nama_kecamatan) VALUES (1, 9905, '987104', 'KOTA'), (1, 9905, '99AA01', 'San Francisco'), (1, 9905, '990101', 'Abu Dhabi')",
            ),
            db
                .prepare(
                    'INSERT INTO kelurahan_suara_partai (tingkat, kode_dapil, kode_kelurahan, partai_id, suara) VALUES (1, 9905, 9871042001, ?, 60)',
                )
                .bind(partyId),
            db
                .prepare(
                    "INSERT INTO suara_partai (tingkat, kode_dapil, partai_id, suara, sumber) VALUES (1, 9901, ?, 100, 'uji')",
                )
                .bind(partyId),
            db
                .prepare(
                    "INSERT INTO suara_partai (tingkat, kode_dapil, partai_id, suara, sumber) VALUES (1, 9902, ?, 200, 'uji')",
                )
                .bind(partyId),
            db
                .prepare(
                    "INSERT INTO suara_partai (tingkat, kode_dapil, partai_id, suara, sumber) VALUES (1, 9903, ?, 300, 'uji')",
                )
                .bind(partyId),
            db
                .prepare(
                    "INSERT INTO suara_partai (tingkat, kode_dapil, partai_id, suara, sumber) VALUES (1, 9904, ?, 100, 'uji')",
                )
                .bind(partyId),
            db
                .prepare(
                    "INSERT INTO caleg (tingkat, kode_dapil, partai_id, nomor_urut, nama, suara, kursi_ke) VALUES (1, 9901, ?, 1, 'UJI', 30, 0)",
                )
                .bind(partyId),
            db.prepare(
                "INSERT INTO dapil_kecamatan (tingkat, kode_dapil, kode_kecamatan, nama_kecamatan) VALUES (1, 9901, '987101', 'KOTA')",
            ),
            db.prepare(
                "INSERT INTO dapil_kecamatan (tingkat, kode_dapil, kode_kecamatan, nama_kecamatan) VALUES (1, 9902, '980101', 'KAB')",
            ),
            db.prepare(
                "INSERT INTO dapil_kecamatan (tingkat, kode_dapil, kode_kecamatan, nama_kecamatan) VALUES (1, 9903, '987102', 'KOTA')",
            ),
            db.prepare(
                "INSERT INTO dapil_kecamatan (tingkat, kode_dapil, kode_kecamatan, nama_kecamatan) VALUES (1, 9903, '980102', 'KAB')",
            ),
            db.prepare(
                "INSERT INTO dapil_kecamatan (tingkat, kode_dapil, kode_kecamatan, nama_kecamatan) VALUES (1, 9904, '987103', 'KOTA')",
            ),
            db.prepare(
                "INSERT INTO dapil_kecamatan (tingkat, kode_dapil, kode_kecamatan, nama_kecamatan) VALUES (1, 9904, '980103', 'KAB')",
            ),
            db
                .prepare(
                    'INSERT INTO kelurahan_suara_partai (tingkat, kode_dapil, kode_kelurahan, partai_id, suara) VALUES (1, 9903, 9871022001, ?, 40)',
                )
                .bind(partyId),
            db
                .prepare(
                    'INSERT INTO kelurahan_suara_partai (tingkat, kode_dapil, kode_kelurahan, partai_id, suara) VALUES (1, 9903, 9801022001, ?, 50)',
                )
                .bind(partyId),
            db
                .prepare(
                    'INSERT INTO kelurahan_suara_partai (tingkat, kode_dapil, kode_kelurahan, partai_id, suara) VALUES (1, 9904, 9871032001, ?, 80)',
                )
                .bind(partyId),
            db
                .prepare(
                    'INSERT INTO kelurahan_suara_partai (tingkat, kode_dapil, kode_kelurahan, partai_id, suara) VALUES (1, 9904, 9801032001, ?, 80)',
                )
                .bind(partyId),
        ];
        try {
            await db.batch(insert);
            const { body } = await json('/v1/2024/dpr_ri/kekuatan?partai=pan&provinsi=98');
            // 9905: its 60 votes in the city's kelurahan are kota; the 40 cast abroad are neither.
            expect(body.data.pemukiman).toEqual({ kota: 200, kabupaten: 250, belum_terpetakan: 350 });
            expect(body.data).toMatchObject({
                suara_gambar: 70,
                suara_caleg: 30,
                suara_terbagi: 100,
                dapil_tanpa_pecahan: 4,
            });
        } finally {
            await db.batch([
                db.prepare('DELETE FROM kelurahan_suara_partai WHERE tingkat = 1 AND kode_dapil IN (9903, 9904, 9905)'),
                db.prepare(
                    'DELETE FROM dapil_kecamatan WHERE tingkat = 1 AND kode_dapil IN (9901, 9902, 9903, 9904, 9905)',
                ),
                db.prepare('DELETE FROM caleg WHERE tingkat = 1 AND kode_dapil = 9901'),
                db.prepare(
                    'DELETE FROM suara_partai WHERE tingkat = 1 AND kode_dapil IN (9901, 9902, 9903, 9904, 9905)',
                ),
                db.prepare('DELETE FROM dapil WHERE tingkat = 1 AND kode_dapil IN (9901, 9902, 9903, 9904, 9905)'),
            ]);
        }
    });

    it('reads a kabupaten/kota council from the dapil code', async () => {
        const party = await env.DB_2024.prepare("SELECT partai_id AS id FROM partai WHERE kode_partai = 'pan'").first<{
            id: number;
        }>();
        const partyId = party?.id ?? 0;
        const db = env.DB_2024;
        try {
            await db.batch([
                db
                    .prepare(
                        'INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, kode_provinsi, kode_kabupaten, jumlah_kursi, total_suara_sah) VALUES (3, 9905, ?, 98, 9871, 1, 80)',
                    )
                    .bind('UJI KOTA'),
                db
                    .prepare(
                        'INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, kode_provinsi, kode_kabupaten, jumlah_kursi, total_suara_sah) VALUES (3, 9906, ?, 98, 9801, 1, 20)',
                    )
                    .bind('UJI KAB'),
                db
                    .prepare(
                        "INSERT INTO suara_partai (tingkat, kode_dapil, partai_id, suara, sumber) VALUES (3, 9905, ?, 80, 'uji')",
                    )
                    .bind(partyId),
                db
                    .prepare(
                        "INSERT INTO suara_partai (tingkat, kode_dapil, partai_id, suara, sumber) VALUES (3, 9906, ?, 20, 'uji')",
                    )
                    .bind(partyId),
            ]);
            const { body } = await json('/v1/2024/dprd_kabupaten_kota/kekuatan?partai=pan&provinsi=98');
            expect(body.data.pemukiman).toEqual({ kota: 80, kabupaten: 20, belum_terpetakan: 0 });
        } finally {
            await db.batch([
                db.prepare('DELETE FROM suara_partai WHERE tingkat = 3 AND kode_dapil IN (9905, 9906)'),
                db.prepare('DELETE FROM dapil WHERE tingkat = 3 AND kode_dapil IN (9905, 9906)'),
            ]);
        }
    });

    it('has no kota split for 2019, and no province split except DPR RI', async () => {
        const national = await json('/v1/2019/dpr_ri/kekuatan?partai=pan');
        expect(national.status).toBe(200);
        expect(national.body.data.pemukiman).toBeNull();
        expect((await json('/v1/2019/dpr_ri/kekuatan?partai=pan&provinsi=11')).status).toBe(200);
        expect((await json('/v1/2019/dprd_provinsi/kekuatan?partai=pan&provinsi=11')).body.error.code).toBe(
            'tidak-tersedia',
        );
        expect((await json('/v1/2024/dpr_ri/kekuatan')).status).toBe(400);
    });
});
