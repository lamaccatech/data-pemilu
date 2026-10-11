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
            "INSERT INTO dapil (tingkat, kode_dapil, nama_dapil, jumlah_kursi, total_suara_sah) VALUES (3, 700001, 'UJI 1', 3, 300), (2, 70001, 'UJI PROV 1', 3, 0), (1, 7001, 'UJI RI', 3, 0)",
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
            },
            {
                kode_kecamatan: '700102',
                nama_kecamatan: 'KEC DUA',
                data_tersedia: false,
                jumlah_kelurahan_berdata: 0,
                suara_partai: null,
                total_suara_sah: null,
                persen_suara: null,
                partai_unggul: null,
                partai: [],
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

    it('has no kelurahan DPT for 2019', async () => {
        const { status, body } = await json('/v1/2019/dpt');
        expect(status).toBe(404);
        expect(body.error.code).toBe('tidak-tersedia');
    });
});
