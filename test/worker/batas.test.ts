import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { json } from './helpers';

const collection = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: { kode_provinsi: '11', nama_provinsi: 'ACEH' },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [95, 5],
                        [96, 5],
                        [96, 6],
                        [95, 5],
                    ],
                ],
            },
        },
    ],
};

describe('GET /v1/:pemilu/batas/provinsi', () => {
    it('returns the stored FeatureCollection in the usual envelope', async () => {
        await env.GEO.put('2024/provinsi.geojson', JSON.stringify(collection));
        const { status, body } = await json('/v1/2024/batas/provinsi');
        expect(status).toBe(200);
        expect(body).toEqual({ data: collection, meta: { pemilu: '2024', wilayah: 'provinsi' } });
    });

    it('says so when the file has not been loaded', async () => {
        const { status, body } = await json('/v1/2019/batas/provinsi');
        expect(status).toBe(503);
        expect(body.error.code).toBe('data-belum-dimuat');
    });

    it('needs a key and a known election', async () => {
        expect((await json('/v1/2024/batas/provinsi', null)).status).toBe(401);
        expect((await json('/v1/2014/batas/provinsi')).body.error.code).toBe('pemilu-tidak-ditemukan');
    });
});

describe('GET /v1/2024/:tingkat/batas/dapil', () => {
    const dapil = (kode: string, kabupaten: string | null) => ({
        type: 'Feature',
        properties: { kode_dapil: kode, nama_dapil: `UJI ${kode}`, kode_provinsi: '11', kode_kabupaten: kabupaten },
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [95, 5],
                    [96, 5],
                    [96, 6],
                    [95, 5],
                ],
            ],
        },
    });

    it('returns the dapil outlines of one province', async () => {
        const stored = { type: 'FeatureCollection', features: [dapil('1101', null), dapil('1102', null)] };
        await env.GEO.put('2024/dapil/dpr_ri/11.geojson', JSON.stringify(stored));
        const { status, body } = await json('/v1/2024/dpr_ri/batas/dapil?provinsi=11');
        expect(status).toBe(200);
        expect(body).toEqual({
            data: stored,
            meta: { pemilu: '2024', tingkat: 'dpr_ri', provinsi: '11', kabupaten: null },
        });
    });

    it('narrows to one kabupaten', async () => {
        const stored = { type: 'FeatureCollection', features: [dapil('110101', '1101'), dapil('110201', '1102')] };
        await env.GEO.put('2024/dapil/dprd_kabupaten_kota/11.geojson', JSON.stringify(stored));
        const { body } = await json('/v1/2024/dprd_kabupaten_kota/batas/dapil?provinsi=11&kabupaten=1102');
        expect(
            body.data.features.map((feature: { properties: { kode_dapil: string } }) => feature.properties.kode_dapil),
        ).toEqual(['110201']);
        expect(body.meta.kabupaten).toBe('1102');
    });

    it('requires a province, and has nothing for 2019 or an unknown province', async () => {
        expect((await json('/v1/2024/dpr_ri/batas/dapil')).body.error.code).toBe('parameter-tidak-valid');
        expect((await json('/v1/2019/dpr_ri/batas/dapil?provinsi=11')).body.error.code).toBe('tidak-tersedia');
        const unknown = await json('/v1/2024/dpr_ri/batas/dapil?provinsi=10');
        expect(unknown.status).toBe(404);
        expect(unknown.body.error.code).toBe('batas-tidak-ditemukan');
    });
});

describe('GET /v1/2024/batas/kabupaten', () => {
    it('returns the kabupaten outlines of one province', async () => {
        const stored = {
            type: 'FeatureCollection',
            features: [
                {
                    ...collection.features[0],
                    properties: {
                        kode_kabupaten: '1101',
                        nama_kabupaten: 'KABUPATEN ACEH SELATAN',
                        kode_provinsi: '11',
                    },
                },
            ],
        };
        await env.GEO.put('2024/kabupaten/11.geojson', JSON.stringify(stored));
        const { status, body } = await json('/v1/2024/batas/kabupaten?provinsi=11');
        expect(status).toBe(200);
        expect(body.data).toEqual(stored);
        expect(body.meta).toEqual({ pemilu: '2024', wilayah: 'kabupaten', provinsi: '11' });
    });

    it('needs a province, has no 2019 outlines, and says so when a province has none', async () => {
        expect((await json('/v1/2024/batas/kabupaten')).body.error.code).toBe('parameter-tidak-valid');
        expect((await json('/v1/2019/batas/kabupaten?provinsi=11')).body.error.code).toBe('tidak-tersedia');
        const unknown = await json('/v1/2024/batas/kabupaten?provinsi=99');
        expect(unknown.status).toBe(404);
        expect(unknown.body.error.code).toBe('batas-tidak-ditemukan');
    });
});

describe('GET /v1/2024/batas/kecamatan', () => {
    it('returns the kecamatan shapes of one kabupaten', async () => {
        const stored = {
            type: 'FeatureCollection',
            features: [
                {
                    ...collection.features[0],
                    properties: { kode_kecamatan: '110101', nama_kecamatan: 'BAKONGAN', kode_kabupaten: '1101' },
                },
            ],
        };
        await env.GEO.put('2024/kecamatan/1101.geojson', JSON.stringify(stored));
        const { status, body } = await json('/v1/2024/batas/kecamatan?kabupaten=1101');
        expect(status).toBe(200);
        expect(body.data).toEqual(stored);
        expect(body.meta).toEqual({ pemilu: '2024', wilayah: 'kecamatan', kabupaten: '1101' });
    });

    it('needs a kabupaten, has no 2019 shapes, and says so when a kabupaten has none', async () => {
        expect((await json('/v1/2024/batas/kecamatan')).body.error.code).toBe('parameter-tidak-valid');
        expect((await json('/v1/2019/batas/kecamatan?kabupaten=1101')).body.error.code).toBe('tidak-tersedia');
        const unknown = await json('/v1/2024/batas/kecamatan?kabupaten=1099');
        expect(unknown.status).toBe(404);
        expect(unknown.body.error.code).toBe('batas-tidak-ditemukan');
    });
});
