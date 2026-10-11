import type { Hono } from 'hono';
import { ApiError } from '../errors';
import { type AppEnv, CACHE_CONTROL } from '../http/context';
import { electionOf, parseParams } from '../http/params';

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
}
