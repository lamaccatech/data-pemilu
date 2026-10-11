import type { Hono } from 'hono';
import { readAllKelurahanDpt } from '../db/wilayah';
import { type AppEnv, ok } from '../http/context';
import { election2024, parseParams } from '../http/params';

export function registerDptRoutes(app: Hono<AppEnv>): void {
    // The full 2024 roll, one row per kelurahan. Callers add it up for a dapil or a region.
    app.get('/v1/:pemilu/dpt', async (c) => {
        const { pemilu, db } = await election2024(c, 'DPT kelurahan');
        parseParams(c, {});
        const records = await readAllKelurahanDpt(db);
        let totalDpt = 0;
        const data = records.map((record) => {
            totalDpt += record.dpt;
            return { kode_kelurahan: String(record.kode_kelurahan).padStart(10, '0'), dpt: record.dpt };
        });
        return ok(c, data, { pemilu, jumlah: data.length, total_dpt: totalDpt });
    });
}
