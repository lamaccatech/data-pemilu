import type { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import { type AppEnv, ok } from '../http/context';
import { electionOf, parseParams } from '../http/params';

export interface PaslonRow {
    nomor_urut: number;
    nama_lengkap: string;
    nama_singkat: string;
    capres: string;
    cawapres: string;
    warna: string;
    foto: string | null;
    partai_pengusung: string | null;
}

export interface SuaraPilpresRow {
    tingkat: number;
    kode_wilayah: string;
    nama_wilayah: string;
    parent_kode: string | null;
    total_suara_sah: number;
    nomor_urut: number;
    suara: number;
    persentase: number;
}

interface PaslonResult {
    nomor_urut: number;
    suara: number;
    persentase: number;
}

interface WilayahResult {
    kode: string;
    nama: string;
    total_suara_sah: number;
    paslon: PaslonResult[];
    nomor_urut_unggul: number;
    persentase_unggul: number;
    selisih: number;
}

function groupWilayah(rows: SuaraPilpresRow[]): WilayahResult[] {
    const map = new Map<string, { kode: string; nama: string; total_suara_sah: number; paslon: PaslonResult[] }>();

    for (const row of rows) {
        let entry = map.get(row.kode_wilayah);
        if (entry === undefined) {
            entry = {
                kode: row.kode_wilayah,
                nama: row.nama_wilayah,
                total_suara_sah: row.total_suara_sah,
                paslon: [],
            };
            map.set(row.kode_wilayah, entry);
        }
        entry.paslon.push({
            nomor_urut: row.nomor_urut,
            suara: row.suara,
            persentase: Number(row.persentase.toFixed(2)),
        });
    }

    const results: WilayahResult[] = [];
    for (const entry of map.values()) {
        entry.paslon.sort((a, b) => b.suara - a.suara);
        const top = entry.paslon[0];
        const second = entry.paslon[1];
        const selisih =
            top && second ? Number((top.persentase - second.persentase).toFixed(2)) : (top?.persentase ?? 0);

        results.push({
            kode: entry.kode,
            nama: entry.nama,
            total_suara_sah: entry.total_suara_sah,
            paslon: entry.paslon.sort((a, b) => a.nomor_urut - b.nomor_urut),
            nomor_urut_unggul: top ? top.nomor_urut : 0,
            persentase_unggul: top ? top.persentase : 0,
            selisih,
        });
    }

    return results;
}

export function registerPilpresRoutes(app: Hono<AppEnv>) {
    // 1. Daftar Paslon
    app.get('/v1/:pemilu/pilpres/paslon', async (c) => {
        const { pemilu, db } = await electionOf(c);
        const result = await db.prepare('SELECT * FROM paslon ORDER BY nomor_urut').all<PaslonRow>();
        const rows = (result.results ?? []).map((row) => ({
            ...row,
            partai_pengusung: row.partai_pengusung ? JSON.parse(row.partai_pengusung) : [],
        }));

        return ok(c, rows, { pemilu, total: rows.length });
    });

    // 2. Ringkasan Nasional
    app.get('/v1/:pemilu/pilpres/nasional', async (c) => {
        const { pemilu, db } = await electionOf(c);

        const [nasionalResult, provinsiResult, paslonResult] = await db.batch([
            db.prepare('SELECT * FROM suara_pilpres WHERE tingkat = 0 AND kode_wilayah = "00" ORDER BY nomor_urut'),
            db.prepare('SELECT * FROM suara_pilpres WHERE tingkat = 1 ORDER BY kode_wilayah, nomor_urut'),
            db.prepare('SELECT * FROM paslon ORDER BY nomor_urut'),
        ]);

        const nasRows = (nasionalResult?.results ?? []) as unknown as SuaraPilpresRow[];
        const provRows = (provinsiResult?.results ?? []) as unknown as SuaraPilpresRow[];
        const paslonRows = (paslonResult?.results ?? []) as unknown as PaslonRow[];

        if (nasRows.length === 0) {
            throw new ApiError(503, 'data-belum-dimuat', `Data Pilpres ${pemilu} belum dimuat.`);
        }

        const totalSuaraSah = nasRows[0]?.total_suara_sah ?? 0;
        const provinces = groupWilayah(provRows);

        // Hitung persebaran provinsi & uji syarat Pasal 6A UUD 1945
        // (1) > 50% suara nasional
        // (2) >= 20% suara di lebih dari separuh jumlah provinsi
        const totalProvinsi = provinces.filter((p) => p.kode !== '99').length; // exclude luar negeri
        const minProvinsiSeperdua = Math.floor(totalProvinsi / 2) + 1;

        const paslonSummary = nasRows.map((row) => {
            const paslonMeta = paslonRows.find((p) => p.nomor_urut === row.nomor_urut);
            let provMenang = 0;
            let provDuaPuluhPersen = 0;

            for (const prov of provinces) {
                if (prov.kode === '99') continue; // evaluasi konstitusional dihitung per provinsi dalam negeri
                if (prov.nomor_urut_unggul === row.nomor_urut) {
                    provMenang += 1;
                }
                const paslonProv = prov.paslon.find((p) => p.nomor_urut === row.nomor_urut);
                if (paslonProv && paslonProv.persentase >= 20.0) {
                    provDuaPuluhPersen += 1;
                }
            }

            const passes50 = row.persentase > 50.0;
            const passesSpread = provDuaPuluhPersen >= minProvinsiSeperdua;

            return {
                nomor_urut: row.nomor_urut,
                nama_singkat: paslonMeta?.nama_singkat ?? `Paslon ${row.nomor_urut}`,
                capres: paslonMeta?.capres ?? '',
                cawapres: paslonMeta?.cawapres ?? '',
                warna: paslonMeta?.warna ?? '#888888',
                foto: paslonMeta?.foto ?? null,
                partai_pengusung: paslonMeta?.partai_pengusung ? JSON.parse(paslonMeta.partai_pengusung) : [],
                suara: row.suara,
                persentase: Number(row.persentase.toFixed(2)),
                provinsi_menang: provMenang,
                provinsi_sebaran_20_persen: provDuaPuluhPersen,
                lolos_syarat_50_persen: passes50,
                lolos_syarat_sebaran: passesSpread,
                menang_satu_putaran: passes50 && passesSpread,
            };
        });

        const winnerOneRound = paslonSummary.find((p) => p.menang_satu_putaran);

        return ok(
            c,
            {
                total_suara_sah: totalSuaraSah,
                paslon: paslonSummary,
                konstitusi_satu_putaran: {
                    total_provinsi: totalProvinsi,
                    syarat_minimal_provinsi: minProvinsiSeperdua,
                    terpenuhi: winnerOneRound !== undefined,
                    pemenang: winnerOneRound ? winnerOneRound.nomor_urut : null,
                },
                provinsi: provinces,
            },
            { pemilu, total_provinsi: provinces.length },
        );
    });

    // 3. Rekapitulasi Tingkat Provinsi
    app.get('/v1/:pemilu/pilpres/provinsi/:kode', async (c) => {
        const { pemilu, db } = await electionOf(c);
        const { kode } = parseParams(c, { kode: z.string().regex(/^[0-9A-Z]{2}$/) });

        const [provResult, kabResult] = await db.batch([
            db
                .prepare('SELECT * FROM suara_pilpres WHERE tingkat = 1 AND kode_wilayah = ? ORDER BY nomor_urut')
                .bind(kode),
            db
                .prepare(
                    'SELECT * FROM suara_pilpres WHERE tingkat = 2 AND parent_kode = ? ORDER BY kode_wilayah, nomor_urut',
                )
                .bind(kode),
        ]);

        const provRows = (provResult?.results ?? []) as unknown as SuaraPilpresRow[];
        const kabRows = (kabResult?.results ?? []) as unknown as SuaraPilpresRow[];

        if (provRows.length === 0) {
            throw notFound('provinsi-tidak-ditemukan', `Provinsi dengan kode "${kode}" tidak ditemukan.`);
        }

        const provDetail = groupWilayah(provRows)[0];
        const kabList = groupWilayah(kabRows);

        return ok(
            c,
            {
                ...provDetail,
                kabupaten: kabList,
            },
            { pemilu, total_kabupaten: kabList.length },
        );
    });

    // 4. Rekapitulasi Tingkat Kabupaten (2024 only)
    app.get('/v1/2024/pilpres/kabupaten/:kode', async (c) => {
        const { kode } = parseParams(c, { kode: z.string().regex(/^[0-9A-Z]{4}$/) });
        const db = c.env.DB_2024;

        const [kabResult, kecResult] = await db.batch([
            db
                .prepare('SELECT * FROM suara_pilpres WHERE tingkat = 2 AND kode_wilayah = ? ORDER BY nomor_urut')
                .bind(kode),
            db
                .prepare(
                    'SELECT * FROM suara_pilpres WHERE tingkat = 3 AND parent_kode = ? ORDER BY kode_wilayah, nomor_urut',
                )
                .bind(kode),
        ]);

        const kabRows = (kabResult?.results ?? []) as unknown as SuaraPilpresRow[];
        const kecRows = (kecResult?.results ?? []) as unknown as SuaraPilpresRow[];

        if (kabRows.length === 0) {
            throw notFound('kabupaten-tidak-ditemukan', `Kabupaten dengan kode "${kode}" tidak ditemukan.`);
        }

        const kabDetail = groupWilayah(kabRows)[0];
        const kecList = groupWilayah(kecRows);

        return ok(
            c,
            {
                ...kabDetail,
                kecamatan: kecList,
            },
            { pemilu: '2024', total_kecamatan: kecList.length },
        );
    });

    // 5. Rekapitulasi Tingkat Kecamatan (2024 only)
    app.get('/v1/2024/pilpres/kecamatan/:kode', async (c) => {
        const { kode } = parseParams(c, { kode: z.string().regex(/^[0-9A-Z]{6}$/) });
        const db = c.env.DB_2024;

        const [kecResult, kelResult] = await db.batch([
            db
                .prepare('SELECT * FROM suara_pilpres WHERE tingkat = 3 AND kode_wilayah = ? ORDER BY nomor_urut')
                .bind(kode),
            db
                .prepare(
                    'SELECT * FROM suara_pilpres WHERE tingkat = 4 AND parent_kode = ? ORDER BY kode_wilayah, nomor_urut',
                )
                .bind(kode),
        ]);

        const kecRows = (kecResult?.results ?? []) as unknown as SuaraPilpresRow[];
        const kelRows = (kelResult?.results ?? []) as unknown as SuaraPilpresRow[];

        if (kecRows.length === 0) {
            throw notFound('kecamatan-tidak-ditemukan', `Kecamatan dengan kode "${kode}" tidak ditemukan.`);
        }

        const kecDetail = groupWilayah(kecRows)[0];
        const kelList = groupWilayah(kelRows);

        return ok(
            c,
            {
                ...kecDetail,
                kelurahan: kelList,
            },
            { pemilu: '2024', total_kelurahan: kelList.length },
        );
    });

    // 6. Data Peta Ringkas (Choropleth Payload)
    app.get('/v1/:pemilu/pilpres/peta', async (c) => {
        const { pemilu, db } = await electionOf(c);
        const { tingkat, parent } = parseParams(c, {
            tingkat: z.enum(['provinsi', 'kabupaten', 'kecamatan']),
            parent: z.string().optional(),
        });

        const tingkatNum = tingkat === 'provinsi' ? 1 : tingkat === 'kabupaten' ? 2 : 3;

        let query =
            'SELECT kode_wilayah, nama_wilayah, total_suara_sah, nomor_urut, suara, persentase FROM suara_pilpres WHERE tingkat = ?';
        const params: unknown[] = [tingkatNum];

        if (parent !== undefined) {
            query += ' AND parent_kode = ?';
            params.push(parent);
        }
        query += ' ORDER BY kode_wilayah, nomor_urut';

        const stmt = db.prepare(query);
        const rows = (await stmt.bind(...params).all<SuaraPilpresRow>()).results ?? [];
        const wilayahList = groupWilayah(rows);

        const mapData: Record<
            string,
            {
                nama: string;
                total_sah: number;
                unggul: number;
                persen_unggul: number;
                selisih: number;
                paslon: Record<number, number>;
            }
        > = {};

        for (const w of wilayahList) {
            const paslonMap: Record<number, number> = {};
            for (const p of w.paslon) {
                paslonMap[p.nomor_urut] = p.persentase;
            }
            mapData[w.kode] = {
                nama: w.nama,
                total_sah: w.total_suara_sah,
                unggul: w.nomor_urut_unggul,
                persen_unggul: w.persentase_unggul,
                selisih: w.selisih,
                paslon: paslonMap,
            };
        }

        return ok(c, mapData, { pemilu, tingkat, count: Object.keys(mapData).length });
    });
}
