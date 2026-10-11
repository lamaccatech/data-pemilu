import type { Hono } from 'hono';
import { ApiError, notFound } from '../errors';
import { type AppEnv, CACHE_CONTROL } from '../http/context';
import { election2024, electionOf, fields, parseParams } from '../http/params';

export function registerBatasRoutes(app: Hono<AppEnv>): void {
    // Province boundaries as they stood at the election: 38 provinces in 2024, 34 in 2019.
    app.get('/v1/:pemilu/batas/provinsi', async (c) => {
        const { pemilu } = await electionOf(c);
        parseParams(c, {});
        const object = await c.env.GEO.get(`${pemilu}/provinsi.geojson`);
        if (object === null) {
            throw new ApiError(503, 'data-belum-dimuat', `Batas provinsi Pemilu ${pemilu} belum dimuat.`);
        }
        // The stored file is a GeoJSON FeatureCollection. It is placed in the envelope as text, unparsed.
        const meta = JSON.stringify({ pemilu, wilayah: 'provinsi' });
        return c.body(`{"data":${await object.text()},"meta":${meta}}`, 200, {
            'Content-Type': 'application/json',
            'Cache-Control': CACHE_CONTROL,
        });
    });

    // Dapil outlines of one province, for drawing the dapil once a province is chosen. 2024 only: there is no
    // list of which kecamatan made up a 2019 dapil.
    app.get('/v1/:pemilu/:tingkat/batas/dapil', async (c) => {
        const { pemilu } = await election2024(c, 'Batas dapil');
        const { tingkat, provinsi, kabupaten } = parseParams(c, {
            tingkat: fields.tingkat,
            provinsi: fields.provinsi,
            kabupaten: fields.kabupaten.optional(),
        });
        const object = await c.env.GEO.get(`${pemilu}/dapil/${tingkat}/${provinsi}.geojson`);
        if (object === null) {
            throw notFound(
                'batas-tidak-ditemukan',
                `Batas dapil ${tingkat} untuk provinsi ${provinsi} tidak tersedia pada Pemilu ${pemilu}.`,
            );
        }
        const meta = {
            pemilu,
            tingkat,
            provinsi: String(provinsi),
            kabupaten: kabupaten === undefined ? null : String(kabupaten),
        };
        c.header('Cache-Control', CACHE_CONTROL);
        if (kabupaten === undefined) {
            // The stored FeatureCollection goes into the envelope as text, unparsed.
            return c.body(`{"data":${await object.text()},"meta":${JSON.stringify(meta)}}`, 200, {
                'Content-Type': 'application/json',
            });
        }
        const collection = await object.json<{
            type: string;
            features: { properties: { kode_kabupaten: string | null } }[];
        }>();
        const features = collection.features.filter(
            (feature) => feature.properties.kode_kabupaten === String(kabupaten),
        );
        return c.json({ data: { type: collection.type, features }, meta });
    });
}
