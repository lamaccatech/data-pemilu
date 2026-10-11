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
            expect(body.data.tokoh_menonjol.map(withoutParty)).toEqual(expected.tokoh_menonjol?.map(withoutParty));
            expect(body.data.caleg.every((row: { kode_partai: string }) => row.kode_partai === 'pan')).toBe(true);
            expect(body.meta.data_lengkap).toBe(true);

            const everyone = await json(`/v1/2024/${expected.tingkat}/dapil/${expected.kode_dapil}/caleg`);
            expect(everyone.body.data.caleg.length).toBeGreaterThan(body.data.caleg.length);
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
        expect(body.data.padanan_2019).toEqual({ kode_dapil_2019: '1101', nama_dapil_2019: 'ACEH I' });
        const pan = body.data.partai.find((row: { kode_partai: string }) => row.kode_partai === 'pan');
        expect(pan.hasil_2019).toMatchObject({
            suara: before.partai_sendiri?.suara,
            kursi: before.partai_sendiri?.kursi,
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
});
