/**
 * Builds province boundaries for both elections from the kecamatan shapes: data/geo/<pemilu>/provinsi.geojson.
 *
 * A province is the union of its kecamatan (the first two digits of the kecamatan code). The shapes use the
 * 2024 codes, so the 34 provinces of 2019 are made by putting the provinces created in 2022 back into the
 * ones they were split from.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { PEMILU, type Pemilu } from '../src/tingkat';
import { EXPORT_DIR, GEO_DIR, GEO_SOURCE_DIR } from './tables';

/** 2024 province code -> the 2019 province it was part of. Provinces not listed are unchanged. */
const PARENT_IN_2019: Record<string, string> = {
    '93': '91', // Papua Selatan, from Papua
    '94': '91', // Papua Tengah, from Papua
    '95': '91', // Papua Pegunungan, from Papua
    '96': '92', // Papua Barat Daya, from Papua Barat
};
const EXPECTED_PROVINCES: Record<Pemilu, number> = { '2024': 38, '2019': 34 };
/** Overseas polling places are filed under a pseudo-province and have no shape. */
const OVERSEAS_PREFIX = '99';

interface Feature {
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown } | null;
}

const provinceIn = (pemilu: Pemilu, code: string) => (pemilu === '2019' ? (PARENT_IN_2019[code] ?? code) : code);

function readCsv(file: string): Record<string, string>[] {
    return parse(fs.readFileSync(path.join(EXPORT_DIR, file)), { columns: true, bom: true });
}

function main() {
    const source = path.join(GEO_SOURCE_DIR, 'kecamatan.geojson');
    const names = new Map<string, string>();
    for (const row of readCsv('dapil.csv')) {
        if (row.pemilu === '2024' && row.kode_provinsi && row.nama_provinsi) {
            names.set(row.kode_provinsi, row.nama_provinsi);
        }
    }
    // Kecamatan that belong to a dapil but have no shape leave the province outline short of them.
    const shapes: { features: Feature[] } = JSON.parse(fs.readFileSync(source, 'utf8'));
    const withShape = new Set(shapes.features.map((feature) => String(feature.properties.code)));
    const kecamatan = new Set(readCsv('dapil_kecamatan_2024.csv').map((row) => row.kode_kecamatan ?? ''));
    const missing = [...kecamatan].filter((code) => !withShape.has(code) && !code.startsWith(OVERSEAS_PREFIX));

    for (const pemilu of PEMILU) {
        const target = path.join(GEO_DIR, pemilu, 'provinsi.geojson');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const parent = pemilu === '2019' ? `(${JSON.stringify(PARENT_IN_2019)})[code.slice(0, 2)] || ` : '';
        // Gaps between kecamatan shapes are closed before and after the union; outlines are thinned to what a
        // country-wide map needs, and specks under 3 km2 are dropped.
        execFileSync(
            'pnpm',
            [
                'exec',
                'mapshaper',
                source,
                '-each',
                `kode_provinsi = ${parent}code.slice(0, 2)`,
                '-clean',
                'gap-fill-area=20000km2',
                '-dissolve',
                'kode_provinsi',
                '-simplify',
                '12%',
                'weighted',
                'keep-shapes',
                '-clean',
                'gap-fill-area=20000km2',
                '-filter-islands',
                'min-area=3km2',
                '-sort',
                'kode_provinsi',
                '-o',
                'precision=0.0001',
                target,
            ],
            { stdio: 'pipe' },
        );
        const collection: { type: string; features: Feature[] } = JSON.parse(fs.readFileSync(target, 'utf8'));
        for (const feature of collection.features) {
            const code = String(feature.properties.kode_provinsi);
            const name = names.get(code);
            if (name === undefined) {
                throw new Error(`${pemilu}: province ${code} has shapes but no name in dapil.csv`);
            }
            feature.properties = {
                kode_provinsi: code,
                nama_provinsi: name,
                kecamatan_tanpa_batas: missing.filter((kode) => provinceIn(pemilu, kode.slice(0, 2)) === code).length,
            };
        }
        if (collection.features.length !== EXPECTED_PROVINCES[pemilu]) {
            throw new Error(
                `${pemilu}: built ${collection.features.length} provinces, expected ${EXPECTED_PROVINCES[pemilu]}`,
            );
        }
        fs.writeFileSync(target, JSON.stringify(collection));
        const incomplete = collection.features.filter(
            (feature) => Number(feature.properties.kecamatan_tanpa_batas) > 0,
        );
        console.log(
            `${pemilu}: ${collection.features.length} provinces, ${(fs.statSync(target).size / 1024).toFixed(0)} KB -> ${path.relative('.', target)}`,
        );
        for (const feature of incomplete) {
            const { kode_provinsi, nama_provinsi, kecamatan_tanpa_batas } = feature.properties;
            console.log(`  ${kode_provinsi} ${nama_provinsi}: ${kecamatan_tanpa_batas} kecamatan without a shape`);
        }
    }
}

main();
