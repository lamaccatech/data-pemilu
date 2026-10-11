import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { json } from './helpers';

const collection = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: { kode_provinsi: '11', nama_provinsi: 'ACEH', kecamatan_tanpa_batas: 0 },
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
