import type { Hono } from 'hono';
import {
    type DapilDptBand,
    readAllKelurahanDpt,
    readDapilDpt,
    readDapilRolls,
    readNationalDpt,
    readProvinceDpt,
    readProvinceRolls,
} from '../db/wilayah';
import { notFound } from '../errors';
import { type AppEnv, ok } from '../http/context';
import { dapilNotFound, election2024, fields, parseParams } from '../http/params';

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

    // Gender and age of the whole country, one row.
    app.get('/v1/:pemilu/dpt/nasional', async (c) => {
        const { pemilu, db } = await election2024(c, 'DPT kelurahan');
        parseParams(c, {});
        const roll = await readNationalDpt(db);
        if (roll === null) {
            throw notFound('tidak-tersedia', `DPT Pemilu ${pemilu} belum dimuat.`);
        }
        return ok(c, roll, { pemilu });
    });

    // Gender and age are not needed here: each province's total, and how many are under 30.
    app.get('/v1/:pemilu/dpt/provinsi', async (c) => {
        const { pemilu, db } = await election2024(c, 'DPT kelurahan');
        parseParams(c, {});
        const rolls = await readProvinceRolls(db);
        return ok(c, rolls, { pemilu, jumlah: rolls.length });
    });

    // The same two figures for every dapil of one province, for colouring the map.
    app.get('/v1/:pemilu/:tingkat/provinsi/:kode/dpt', async (c) => {
        const { pemilu, db } = await election2024(c, 'DPT kelurahan');
        const { tingkat, kode } = parseParams(c, { tingkat: fields.tingkat, kode: fields.provinsi });
        const rolls = await readDapilRolls(db, tingkat, kode);
        return ok(c, rolls, { pemilu, tingkat, kode_provinsi: String(kode).padStart(2, '0'), jumlah: rolls.length });
    });

    // Gender and age of one province. The roll is the villages whose code starts with the province.
    app.get('/v1/:pemilu/provinsi/:kode/dpt', async (c) => {
        const { pemilu, db } = await election2024(c, 'DPT kelurahan');
        const { kode } = parseParams(c, { kode: fields.provinsi });
        const roll = await readProvinceDpt(db, kode);
        if (roll === null) {
            throw notFound('provinsi-tidak-ditemukan', `Provinsi ${kode} tidak memiliki DPT pada Pemilu ${pemilu}.`);
        }
        return ok(c, roll, { pemilu, kode_provinsi: String(kode).padStart(2, '0') });
    });

    // Gender and age of one dapil, plus each kecamatan's total. 2024 only.
    app.get('/v1/:pemilu/:tingkat/dapil/:kode_dapil/dpt', async (c) => {
        const { pemilu, db } = await election2024(c, 'DPT kelurahan');
        const { tingkat, kode_dapil } = parseParams(c, { tingkat: fields.tingkat, kode_dapil: fields.kode_dapil });
        const found = await readDapilDpt(db, tingkat, kode_dapil);
        if (found.dapil === null) {
            throw dapilNotFound(tingkat, kode_dapil, pemilu);
        }
        return ok(
            c,
            {
                ...summariseDapilDpt(found.bands),
                // Voters of a kecamatan shared with another dapil whose kelurahan have votes in neither. They
                // are in no dapil's roll, so above zero this roll is incomplete and should not be read as the
                // dapil's.
                belum_terbagi: found.unplaced,
            },
            {
                pemilu,
                tingkat,
                kode_dapil: String(found.dapil.kode_dapil),
                nama_dapil: found.dapil.nama_dapil,
            },
        );
    });
}

const EMPTY_DPT = {
    dpt: 0,
    dpt_l: 0,
    dpt_p: 0,
    usia_kurang21: 0,
    usia_u21_25: 0,
    usia_u26_30: 0,
    usia_u31_40: 0,
    usia_u41_50: 0,
    usia_u51_55: 0,
    usia_lebih55: 0,
};

function summariseDapilDpt(bands: readonly DapilDptBand[]) {
    const total = { ...EMPTY_DPT };
    for (const band of bands) {
        total.dpt += band.dpt;
        total.dpt_l += band.dpt_l;
        total.dpt_p += band.dpt_p;
        total.usia_kurang21 += band.usia_kurang21;
        total.usia_u21_25 += band.usia_u21_25;
        total.usia_u26_30 += band.usia_u26_30;
        total.usia_u31_40 += band.usia_u31_40;
        total.usia_u41_50 += band.usia_u41_50;
        total.usia_u51_55 += band.usia_u51_55;
        total.usia_lebih55 += band.usia_lebih55;
    }
    return {
        ...total,
        kecamatan: bands.map((band) => ({ kode_kecamatan: band.kode_kecamatan, dpt: band.dpt })),
    };
}
