import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { json } from './helpers';

// Synthetic areas, so the shapes and the gap reporting can be checked without the bulk data.
// dprd_kabupaten_kota dapil 700001: kecamatan 700101 (three kelurahan, one without votes) and 700102 (no data).
// dprd_provinsi dapil 70001: kecamatan 700101.
beforeAll(async () => {
    const db = env.DB_2024;
    await db.batch([
        db.prepare(
            "INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, kode_provinsi, nama_provinsi, jumlah_kursi, total_suara_sah) VALUES (3, 700001, 'UJI 1', 70, 'UJI', 3, 300), (2, 70001, 'UJI PROV 1', 70, 'UJI', 3, 0), (1, 7001, 'UJI RI', 70, 'UJI', 3, 0)",
        ),
        db.prepare("INSERT INTO suara_partai VALUES (3, 700001, 12, 200, 'uji'), (3, 700001, 1, 100, 'uji')"),
        db.prepare(
            "INSERT INTO caleg VALUES (3, 700001, 12, 1, 'CALEG SATU', 'P', 150, 1), (3, 700001, 12, 2, 'CALEG DUA', 'L', 20, 0), (2, 70001, 1, 1, 'CALEG PROV', 'L', 60, 1)",
        ),
        db.prepare(
            "INSERT INTO dapil_kecamatan VALUES (3, 700001, '700101', 'KEC SATU'), (3, 700001, '700102', 'KEC DUA'), (3, 700002, '700101', 'KEC SATU'), (2, 70001, '700101', 'KEC SATU'), (1, 7001, '99AA01', 'San Francisco, Amerika Serikat')",
        ),
        db.prepare(
            'INSERT INTO kelurahan_suara_partai VALUES (3, 700001, 7001011001, 12, 70), (3, 700001, 7001011001, 1, 30), (3, 700001, 7001011002, 12, 40), (3, 700001, 7001011002, 1, 60), (3, 700002, 7001011004, 1, 5)',
        ),
        db.prepare(
            "INSERT INTO kelurahan_dpt VALUES (7001011001, 'DESA A', 200, 90, 110, 10, 20, 30, 40, 50, 20, 30), (7001011002, 'DESA B', 150, 70, 80, 10, 20, 30, 30, 30, 10, 20), (7001011003, 'DESA C', 100, 50, 50, 10, 10, 10, 20, 20, 10, 20), (7001011004, 'DESA D', 90, 40, 50, 10, 10, 10, 20, 20, 10, 10)",
        ),
        db.prepare(
            'INSERT INTO kelurahan_suara_caleg VALUES (3, 700001, 7001011001, 12, 1, 55), (3, 700001, 7001011001, 12, 2, 5)',
        ),
        db.prepare('INSERT INTO kecamatan_suara_caleg VALUES (70001, 700101, 1, 1, 60)'),
        // dprd_kabupaten_kota dapil 700003: the kelurahan give its one candidate more than the dapil does.
        db.prepare(
            "INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, kode_provinsi, nama_provinsi, jumlah_kursi, total_suara_sah) VALUES (3, 700003, 'UJI 3', 70, 'UJI', 3, 100)",
        ),
        db.prepare("INSERT INTO caleg VALUES (3, 700003, 12, 1, 'CALEG GANDA', 'L', 100, 1)"),
        db.prepare("INSERT INTO dapil_kecamatan VALUES (3, 700003, '700103', 'KEC TIGA')"),
        db.prepare(
            'INSERT INTO kelurahan_suara_caleg VALUES (3, 700003, 7001031001, 12, 1, 100), (3, 700003, 7001031002, 12, 1, 90)',
        ),
    ]);
});

describe('kecamatan and kelurahan endpoints', () => {
    it('sums party votes per kecamatan and reports the kecamatan without data', async () => {
        const { status, body } = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/kecamatan?partai=pan');
        expect(status).toBe(200);
        expect(body.data).toEqual([
            {
                kode_kecamatan: '700101',
                nama_kecamatan: 'KEC SATU',
                dapil_lain: ['700002'],
                data_tersedia: true,
                jumlah_kelurahan_berdata: 2,
                suara_partai: 110,
                total_suara_sah: 200,
                persen_suara: 55,
                partai_unggul: { kode_partai: 'pan', suara: 110 },
                partai: [
                    { kode_partai: 'pan', suara: 110 },
                    { kode_partai: 'pkb', suara: 90 },
                ],
                // DESA C has votes in neither dapil that holds this kecamatan, so it is in neither roll.
                dpt: { dpt: 350, di_bawah_30: 120 },
            },
            {
                kode_kecamatan: '700102',
                nama_kecamatan: 'KEC DUA',
                dapil_lain: [],
                data_tersedia: false,
                jumlah_kelurahan_berdata: 0,
                suara_partai: null,
                total_suara_sah: null,
                persen_suara: null,
                partai_unggul: null,
                partai: [],
                dpt: null,
            },
        ]);
        expect(body.meta).toMatchObject({
            jumlah_kecamatan: 2,
            kecamatan_tanpa_data: 1,
            suara_partai_dari_kelurahan: 110,
            suara_partai_dapil: 200,
            selisih: 90,
        });
    });

    it('lists the kelurahan of a kecamatan, leaving out those that vote in another dapil', async () => {
        const { body } = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/kelurahan?partai=pkb&kecamatan=700101');
        expect(body.data.map((row: { kode_kelurahan: string }) => row.kode_kelurahan)).toEqual([
            '7001011001',
            '7001011002',
            '7001011003',
        ]);
        expect(body.data[0]).toEqual({
            kode_kelurahan: '7001011001',
            nama_kelurahan: 'DESA A',
            data_tersedia: true,
            suara_partai: 30,
            total_suara_sah: 100,
            persen_suara: 30,
            partai_unggul: { kode_partai: 'pan', suara: 70 },
            partai: [
                { kode_partai: 'pan', suara: 70 },
                { kode_partai: 'pkb', suara: 30 },
            ],
            dpt: {
                dpt: 200,
                dpt_l: 90,
                dpt_p: 110,
                usia_kurang21: 10,
                usia_u21_25: 20,
                usia_u26_30: 30,
                usia_u31_40: 40,
                usia_u41_50: 50,
                usia_u51_55: 20,
                usia_lebih55: 30,
            },
        });
        expect(body.data[2]).toMatchObject({
            nama_kelurahan: 'DESA C',
            data_tersedia: false,
            suara_partai: null,
            partai_unggul: null,
        });
        expect(body.data[2].dpt.dpt).toBe(100);
        expect(body.meta).toMatchObject({
            nama_kecamatan: 'KEC SATU',
            jumlah_kelurahan: 3,
            kelurahan_tanpa_data: 1,
            dapil_lain: ['700002'],
        });
    });

    it('requires kecamatan and checks that it belongs to the dapil', async () => {
        const missing = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/kelurahan?partai=pan');
        expect(missing.status).toBe(400);
        expect(missing.body.error.message).toContain('kecamatan wajib diisi');
        const other = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/kelurahan?partai=pan&kecamatan=710101');
        expect(other.status).toBe(404);
        expect(other.body.error.code).toBe('kecamatan-tidak-ditemukan');
    });

    it('answers for an overseas kecamatan, which has no kelurahan', async () => {
        const { status, body } = await json('/v1/2024/dpr_ri/dapil/7001/kelurahan?partai=pan&kecamatan=99AA01');
        expect(status).toBe(200);
        expect(body.data).toEqual([]);
        expect(body.meta.nama_kecamatan).toBe('San Francisco, Amerika Serikat');
    });

    it('returns candidate votes in a kelurahan', async () => {
        const { body } = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/kelurahan/7001011001/caleg?partai=pan');
        expect(body.data).toEqual({
            kode_kelurahan: '7001011001',
            nama_kelurahan: 'DESA A',
            kode_kecamatan: '700101',
            nama_kecamatan: 'KEC SATU',
            data_tersedia: true,
            caleg: [
                {
                    kode_partai: 'pan',
                    nomor_urut: 1,
                    nama: 'CALEG SATU',
                    jenis_kelamin: 'P',
                    suara: 55,
                    suara_dapil: 150,
                    kursi_ke: 1,
                },
                {
                    kode_partai: 'pan',
                    nomor_urut: 2,
                    nama: 'CALEG DUA',
                    jenis_kelamin: 'L',
                    suara: 5,
                    suara_dapil: 20,
                    kursi_ke: 0,
                },
            ],
        });
        const otherParty = await json(
            '/v1/2024/dprd_kabupaten_kota/dapil/700001/kelurahan/7001011001/caleg?partai=pkb',
        );
        expect(otherParty.body.data).toMatchObject({ data_tersedia: true, caleg: [] });
        const noData = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/kelurahan/7001011003/caleg');
        expect(noData.body.data).toMatchObject({ data_tersedia: false, caleg: [] });
        const outside = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/kelurahan/7101011001/caleg');
        expect(outside.body.error.code).toBe('kelurahan-tidak-ditemukan');
    });

    it('says candidate votes of dprd_provinsi stop at kecamatan', async () => {
        const { status, body } = await json('/v1/2024/dprd_provinsi/dapil/70001/kelurahan/7001011001/caleg');
        expect(status).toBe(404);
        expect(body.error.code).toBe('tidak-tersedia');
        expect(body.error.message).toContain('kecamatan');
    });

    it('returns candidate votes in a kecamatan for dprd_provinsi only', async () => {
        const { body } = await json('/v1/2024/dprd_provinsi/dapil/70001/kecamatan/700101/caleg');
        expect(body.data).toEqual({
            kode_kecamatan: '700101',
            nama_kecamatan: 'KEC SATU',
            data_tersedia: true,
            caleg: [
                {
                    kode_partai: 'pkb',
                    nomor_urut: 1,
                    nama: 'CALEG PROV',
                    jenis_kelamin: 'L',
                    suara: 60,
                    suara_dapil: 60,
                    kursi_ke: 1,
                },
            ],
        });
        const otherLevel = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/kecamatan/700101/caleg');
        expect(otherLevel.status).toBe(404);
        expect(otherLevel.body.error.code).toBe('tidak-tersedia');
        const outside = await json('/v1/2024/dprd_provinsi/dapil/70001/kecamatan/700199/caleg');
        expect(outside.body.error.code).toBe('kecamatan-tidak-ditemukan');
    });

    it('has no kelurahan data for 2019', async () => {
        const { status, body } = await json('/v1/2019/dpr_ri/dapil/1101/kecamatan?partai=pan');
        expect(status).toBe(404);
        expect(body.error.code).toBe('tidak-tersedia');
    });

    it('lists every kelurahan DPT row', async () => {
        const { status, body } = await json('/v1/2024/dpt');
        expect(status).toBe(200);
        const byCode = new Map(
            body.data.map((row: { kode_kelurahan: string; dpt: number }) => [row.kode_kelurahan, row.dpt]),
        );
        expect(byCode.get('7001011001')).toBe(200);
        expect(byCode.get('7001011002')).toBe(150);
        expect(byCode.get('7001011003')).toBe(100);
        expect(byCode.get('7001011004')).toBe(90);
        expect(body.meta.jumlah).toBe(body.data.length);
        expect(body.meta.total_dpt).toBe(body.data.reduce((sum: number, row: { dpt: number }) => sum + row.dpt, 0));
    });

    it('sums the national roll and each province, and the dapil of a province', async () => {
        const national = await json('/v1/2024/dpt/nasional');
        expect(national.status).toBe(200);
        expect(national.body.data.dpt).toBe(540);
        expect(national.body.data.dpt_l).toBe(250);

        const provinces = await json('/v1/2024/dpt/provinsi');
        expect(provinces.status).toBe(200);
        expect(provinces.body.data).toEqual([{ kode: '70', dpt: 540, di_bawah_30: 180 }]);

        const dapil = await json('/v1/2024/dprd_kabupaten_kota/provinsi/70/dpt');
        expect(dapil.status).toBe(200);
        // The one dapil with a roll shares its kecamatan, and a kelurahan there belongs to no dapil: no roll.
        expect(dapil.body.data).toEqual([]);

        const old = await json('/v1/2019/dpt/nasional');
        expect(old.status).toBe(404);
        expect(old.body.error.code).toBe('tidak-tersedia');
    });

    it('sums the province voter roll from the kelurahan codes', async () => {
        const { status, body } = await json('/v1/2024/provinsi/70/dpt');
        expect(status).toBe(200);
        expect(body.data).toEqual({
            dpt: 540,
            dpt_l: 250,
            dpt_p: 290,
            usia_kurang21: 40,
            usia_u21_25: 60,
            usia_u26_30: 80,
            usia_u31_40: 110,
            usia_u41_50: 120,
            usia_u51_55: 50,
            usia_lebih55: 80,
        });
        expect(body.meta.kode_provinsi).toBe('70');
        const missing = await json('/v1/2024/provinsi/10/dpt');
        expect(missing.status).toBe(404);
        expect(missing.body.error.code).toBe('provinsi-tidak-ditemukan');
    });

    it('sums the dapil voter roll, leaving out what votes in another dapil and what can be given to none', async () => {
        const { status, body } = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/dpt');
        expect(status).toBe(200);
        expect(body.data).toEqual({
            dpt: 350,
            dpt_l: 160,
            dpt_p: 190,
            usia_kurang21: 20,
            usia_u21_25: 40,
            usia_u26_30: 60,
            usia_u31_40: 70,
            usia_u41_50: 80,
            usia_u51_55: 30,
            usia_lebih55: 50,
            kecamatan: [{ kode_kecamatan: '700101', dpt: 350 }],
            // DESA D votes in dapil 700002 and is left out. DESA C has votes in neither dapil of the
            // kecamatan: its 100 voters are reported as undivided, and the roll is incomplete.
            belum_terbagi: { kelurahan: 1, dpt: 100 },
        });
    });

    it('has no kelurahan DPT for 2019', async () => {
        const { status, body } = await json('/v1/2019/dpt');
        expect(status).toBe(404);
        expect(body.error.code).toBe('tidak-tersedia');
        const dapil = await json('/v1/2019/dpr_ri/dapil/1101/dpt');
        expect(dapil.status).toBe(404);
        expect(dapil.body.error.code).toBe('tidak-tersedia');
        const province = await json('/v1/2019/provinsi/70/dpt');
        expect(province.status).toBe(404);
        expect(province.body.error.code).toBe('tidak-tersedia');
    });
});

describe('one party across the three levels', () => {
    beforeAll(async () => {
        const db = env.DB_2024;
        await db.batch([
            // A dpr_ri dapil of its own over the same kecamatan, so the tests above keep their figures.
            db.prepare(
                "INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, jumlah_kursi, total_suara_sah) VALUES (1, 7002, 'UJI RI 2', 3, 0)",
            ),
            db.prepare("INSERT INTO dapil_kecamatan VALUES (1, 7002, '700101', 'KEC SATU')"),
            db.prepare(
                'INSERT INTO kelurahan_suara_partai VALUES (1, 7002, 7001011001, 12, 20), (1, 7002, 7001011001, 1, 80), (2, 70001, 7001011001, 12, 50), (2, 70001, 7001011001, 1, 50)',
            ),
        ]);
    });

    it('reads each kecamatan whole at every level and leaves a level without votes empty', async () => {
        const { status, body } = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/lintas-tingkat?partai=pan');
        expect(status).toBe(200);
        expect(body.data).toEqual([
            {
                kode_kecamatan: '700101',
                nama_kecamatan: 'KEC SATU',
                tingkat: {
                    dpr_ri: { suara_partai: 20, total_suara_sah: 100, persen_suara: 20 },
                    dprd_provinsi: { suara_partai: 50, total_suara_sah: 100, persen_suara: 50 },
                    // Both dapil that share the kecamatan: 200 votes in 700001 and 5 in 700002.
                    dprd_kabupaten_kota: { suara_partai: 110, total_suara_sah: 205, persen_suara: 53.66 },
                },
            },
            {
                kode_kecamatan: '700102',
                nama_kecamatan: 'KEC DUA',
                tingkat: { dpr_ri: null, dprd_provinsi: null, dprd_kabupaten_kota: null },
            },
        ]);
    });

    it('is for 2024 only and needs a party', async () => {
        expect((await json('/v1/2019/dpr_ri/dapil/1101/lintas-tingkat?partai=pan')).status).toBe(404);
        expect((await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/lintas-tingkat')).status).toBe(400);
    });
});

describe('ruang suara', () => {
    it('ranks the kelurahan where the party polled under its own average, in votes', async () => {
        // pkb has 90 of the 200 votes of dapil 700001: 45%. In DESA A it has 30 of 100, in DESA B 60 of 100.
        const { status, body } = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/ruang-suara?partai=pkb');
        expect(status).toBe(200);
        expect(body.data).toEqual([
            {
                kode_kelurahan: '7001011001',
                nama_kelurahan: 'DESA A',
                kode_kecamatan: '700101',
                nama_kecamatan: 'KEC SATU',
                suara_partai: 30,
                total_suara_sah: 100,
                persen_suara: 30,
                ruang_suara: 15,
                partai_unggul: { kode_partai: 'pan', suara: 70, persen_suara: 70 },
                dpt: { dpt: 200, di_bawah_30: 60 },
            },
        ]);
        expect(body.meta).toMatchObject({
            persen_patokan: 45,
            jumlah_kelurahan_berdata: 2,
            jumlah_kelurahan_di_bawah_patokan: 1,
            total_ruang_suara: 15,
        });
    });

    it('is empty for a dapil without kelurahan votes, and needs a party', async () => {
        const empty = await json('/v1/2024/dpr_ri/dapil/7001/ruang-suara?partai=pan');
        expect(empty.status).toBe(200);
        expect(empty.body.data).toEqual([]);
        expect(empty.body.meta).toMatchObject({ persen_patokan: 0, total_ruang_suara: 0 });
        expect((await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/ruang-suara')).status).toBe(400);
    });

    it('sets a candidate beside the party in every kecamatan, and in the kelurahan of one', async () => {
        const path = '/v1/2024/dprd_kabupaten_kota/dapil/700001/caleg/pan/1/wilayah';
        const { status, body } = await json(path);
        expect(status).toBe(200);
        expect(body.data).toEqual({
            caleg: {
                kode_partai: 'pan',
                nomor_urut: 1,
                nama: 'CALEG SATU',
                jenis_kelamin: 'P',
                suara: 150,
                kursi_ke: 1,
            },
            pemenang_ditandai: true,
            suara_tercatat: 55,
            wilayah: [
                {
                    kode_kecamatan: '700101',
                    nama_kecamatan: 'KEC SATU',
                    data_tersedia: true,
                    suara: 55,
                    suara_partai: 110,
                    persen_dari_partai: 50,
                },
                {
                    kode_kecamatan: '700102',
                    nama_kecamatan: 'KEC DUA',
                    data_tersedia: false,
                    suara: null,
                    suara_partai: null,
                    persen_dari_partai: null,
                },
            ],
        });
        expect(body.meta).toMatchObject({
            tingkat_wilayah: 'kecamatan',
            sebaran_wilayah: {
                status: 'sesuai',
                tingkat_wilayah: 'kelurahan',
                suara_caleg_dapil: 170,
                suara_caleg_wilayah: 60,
                kelebihan: 0,
                persen_kelebihan: 0,
                batas_persen: 1,
            },
        });
        const inside = await json(`${path}?kecamatan=700101`);
        expect(inside.body.meta).toMatchObject({ tingkat_wilayah: 'kelurahan', nama_kecamatan: 'KEC SATU' });
        // DESA B has party votes and no candidate rows at all: a gap, not zero votes.
        expect(inside.body.data.wilayah).toEqual([
            {
                kode_kelurahan: '7001011001',
                nama_kelurahan: 'DESA A',
                data_tersedia: true,
                suara: 55,
                suara_partai: 70,
                persen_dari_partai: 78.57,
            },
            {
                kode_kelurahan: '7001011002',
                nama_kelurahan: 'DESA B',
                data_tersedia: false,
                suara: null,
                suara_partai: 40,
                persen_dari_partai: null,
            },
        ]);
    });

    it('withholds the areas of a dapil whose kelurahan give candidates more votes than the dapil', async () => {
        const { status, body } = await json('/v1/2024/dprd_kabupaten_kota/dapil/700003/caleg/pan/1/wilayah');
        expect(status).toBe(200);
        expect(body.data).toMatchObject({ suara_tercatat: 190, wilayah: null });
        expect(body.meta.sebaran_wilayah).toMatchObject({
            status: 'tidak_sesuai',
            suara_caleg_dapil: 100,
            suara_caleg_wilayah: 190,
            kelebihan: 90,
            persen_kelebihan: 90,
        });
        const list = await json('/v1/2024/dprd_kabupaten_kota/dapil/700003/caleg');
        expect(list.body.meta.sebaran_wilayah.status).toBe('tidak_sesuai');
    });

    it('reads the candidates of dprd_provinsi per kecamatan and refuses kelurahan', async () => {
        const path = '/v1/2024/dprd_provinsi/dapil/70001/caleg/pkb/1/wilayah';
        const { body } = await json(path);
        expect(body.meta.sebaran_wilayah).toMatchObject({ status: 'sesuai', tingkat_wilayah: 'kecamatan' });
        expect(body.data.wilayah).toEqual([
            {
                kode_kecamatan: '700101',
                nama_kecamatan: 'KEC SATU',
                data_tersedia: true,
                suara: 60,
                // The party rows come from another table and can fall short of the candidate. Served as they are.
                suara_partai: 50,
                persen_dari_partai: 120,
            },
        ]);
        const inside = await json(`${path}?kecamatan=700101`);
        expect(inside.status).toBe(404);
        expect(inside.body.error.code).toBe('tidak-tersedia');
    });

    it('answers 404 for a candidate, a kecamatan or an election it does not have', async () => {
        const base = '/v1/2024/dprd_kabupaten_kota/dapil/700001/caleg';
        expect((await json(`${base}/pan/9/wilayah`)).body.error.code).toBe('caleg-tidak-ditemukan');
        expect((await json(`${base}/pan/1/wilayah?kecamatan=710101`)).body.error.code).toBe(
            'kecamatan-tidak-ditemukan',
        );
        expect((await json(`${base}/tidak_ada/1/wilayah`)).body.error.code).toBe('partai-tidak-ditemukan');
        expect((await json('/v1/2019/dpr_ri/dapil/1101/caleg/pan/1/wilayah')).body.error.code).toBe('tidak-tersedia');
        // A dapil without rows below it cannot be checked.
        const none = await json('/v1/2024/dpr_ri/dapil/1101/caleg/pan/1/wilayah');
        expect(none.body.data).toMatchObject({ suara_tercatat: null, wilayah: null });
        expect(none.body.meta.sebaran_wilayah.status).toBe('tidak_tersedia');
    });

    it('withholds party votes where the kelurahan give the parties more than the dapil', async () => {
        const db = env.DB_2024;
        // dprd_kabupaten_kota dapil 700004: every kelurahan carries double the party votes.
        await db.batch([
            db.prepare(
                "INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, kode_provinsi, nama_provinsi, jumlah_kursi, total_suara_sah) VALUES (3, 700004, 'UJI 4', 70, 'UJI', 3, 100)",
            ),
            db.prepare("INSERT INTO suara_partai VALUES (3, 700004, 12, 60, 'uji'), (3, 700004, 1, 40, 'uji')"),
            db.prepare("INSERT INTO caleg VALUES (3, 700004, 12, 1, 'CALEG EMPAT', 'L', 30, 0)"),
            db.prepare("INSERT INTO dapil_kecamatan VALUES (3, 700004, '700104', 'KEC EMPAT')"),
            db.prepare(
                'INSERT INTO kelurahan_suara_partai VALUES (3, 700004, 7001041001, 12, 120), (3, 700004, 7001041001, 1, 80)',
            ),
            db.prepare('INSERT INTO kelurahan_suara_caleg VALUES (3, 700004, 7001041001, 12, 1, 30)'),
            db.prepare(
                "INSERT INTO kelurahan_dpt VALUES (7001041001, 'DESA E', 150, 70, 80, 10, 20, 30, 30, 30, 10, 20)",
            ),
        ]);
        const base = '/v1/2024/dprd_kabupaten_kota/dapil/700004';
        const kecamatan = await json(`${base}/kecamatan?partai=pan`);
        expect(kecamatan.body.meta.sebaran_partai).toEqual({
            status: 'tidak_sesuai',
            suara_dapil: 100,
            suara_wilayah: 200,
            kelebihan: 100,
            persen_kelebihan: 100,
            batas_persen: 1,
        });
        // The roll stays; the votes do not.
        expect(kecamatan.body.data).toEqual([
            {
                kode_kecamatan: '700104',
                nama_kecamatan: 'KEC EMPAT',
                dapil_lain: [],
                data_tersedia: false,
                jumlah_kelurahan_berdata: 0,
                suara_partai: null,
                total_suara_sah: null,
                persen_suara: null,
                partai_unggul: null,
                partai: [],
                dpt: { dpt: 150, di_bawah_30: 60 },
            },
        ]);
        const kelurahan = await json(`${base}/kelurahan?partai=pan&kecamatan=700104`);
        expect(kelurahan.body.meta.sebaran_partai.status).toBe('tidak_sesuai');
        expect(kelurahan.body.data).toHaveLength(1);
        expect(kelurahan.body.data[0]).toMatchObject({
            kode_kelurahan: '7001041001',
            data_tersedia: false,
            suara_partai: null,
            partai: [],
        });
        const room = await json(`${base}/ruang-suara?partai=pan`);
        expect(room.body.data).toEqual([]);
        expect(room.body.meta).toMatchObject({ total_ruang_suara: 0, sebaran_partai: { status: 'tidak_sesuai' } });
        const levels = await json(`${base}/lintas-tingkat?partai=pan`);
        expect(levels.body.data[0].tingkat.dprd_kabupaten_kota).toBeNull();
        expect(levels.body.meta.kecamatan_tidak_sesuai).toEqual({
            dpr_ri: 0,
            dprd_provinsi: 0,
            dprd_kabupaten_kota: 1,
        });
        // The candidate's own votes pass their check; only the party's side is left out.
        const spread = await json(`${base}/caleg/pan/1/wilayah`);
        expect(spread.body.meta.sebaran_partai.status).toBe('tidak_sesuai');
        expect(spread.body.data).toMatchObject({ pemenang_ditandai: false });
        expect(spread.body.data.wilayah).toEqual([
            {
                kode_kecamatan: '700104',
                nama_kecamatan: 'KEC EMPAT',
                data_tersedia: true,
                suara: 30,
                suara_partai: null,
                persen_dari_partai: null,
            },
        ]);
        // A dapil whose kelurahan agree is untouched.
        const fine = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/kecamatan?partai=pan');
        expect(fine.body.meta.sebaran_partai.status).toBe('sesuai');
        const fineLevels = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/lintas-tingkat?partai=pan');
        expect(fineLevels.body.meta.kecamatan_tidak_sesuai).toEqual({
            dpr_ri: 0,
            dprd_provinsi: 0,
            dprd_kabupaten_kota: 0,
        });
    });

    it('says when a dapil marks no winner instead of calling everyone unseated', async () => {
        const caleg = await json('/v1/2024/dprd_kabupaten_kota/dapil/700004/caleg');
        expect(caleg.body.meta).toMatchObject({ data_lengkap: true, pemenang_ditandai: false });
        expect(caleg.body.data.tokoh_menonjol).toBeNull();
        const contest = await json('/v1/2024/dprd_kabupaten_kota/dapil/700004/persaingan');
        expect(contest.body.data.pemenang_ditandai).toBe(false);
        const pan = contest.body.data.partai.find((row: { kode_partai: string }) => row.kode_partai === 'pan');
        expect(pan.caleg_teratas).toMatchObject({ nama: 'CALEG EMPAT', terpilih: null });
        const marked = await json('/v1/2024/dprd_kabupaten_kota/dapil/700001/persaingan');
        expect(marked.body.data.pemenang_ditandai).toBe(true);
    });
});
