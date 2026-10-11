/**
 * Builds province boundaries for both elections: data/geo/<pemilu>/provinsi.geojson.
 *
 * The outlines come from Badan Informasi Geospasial (BIG) by way of a public repository (see SOURCE). That
 * file has the 38 provinces of 2024. The 34 provinces of 2019 are made by joining the provinces created in
 * 2022 back onto the ones they were split from.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { PEMILU, type Pemilu } from '../src/tingkat';
import { EXPORT_DIR, GEO_DIR } from './tables';

/** Pinned to one commit, so a rebuild cannot change under us. MIT licence; data from geoservice.big.go.id. */
const SOURCE = {
    repository: 'https://github.com/ardian28/GeoJson-Indonesia-38-Provinsi',
    url: 'https://raw.githubusercontent.com/ardian28/GeoJson-Indonesia-38-Provinsi/486e89ca57c9f9910991dbf00afca26297b3baa3/Provinsi/38%20Provinsi%20Indonesia%20-%20Provinsi.json',
    file: path.join(GEO_DIR, 'source', 'provinsi-big.geojson'),
};
/** 2024 province code -> the 2019 province it was part of. Provinces not listed are unchanged. */
const PARENT_IN_2019: Record<string, string> = {
    '93': '91', // Papua Selatan, from Papua
    '94': '91', // Papua Tengah, from Papua
    '95': '91', // Papua Pegunungan, from Papua
    '96': '92', // Papua Barat Daya, from Papua Barat
};
const EXPECTED_PROVINCES: Record<Pemilu, number> = { '2024': 38, '2019': 34 };

interface Feature {
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown } | null;
}
interface Collection {
    type: 'FeatureCollection';
    features: Feature[];
}

async function fetchSource(): Promise<Collection> {
    if (!fs.existsSync(SOURCE.file)) {
        console.log(`Downloading ${SOURCE.url}`);
        const response = await fetch(SOURCE.url);
        if (!response.ok) {
            throw new Error(`Download failed: ${response.status} ${response.statusText}`);
        }
        fs.mkdirSync(path.dirname(SOURCE.file), { recursive: true });
        fs.writeFileSync(SOURCE.file, Buffer.from(await response.arrayBuffer()));
    }
    return JSON.parse(fs.readFileSync(SOURCE.file, 'utf8'));
}

/** Province names and codes of 2024 as the election data has them: NAMA -> kode. */
function readProvinces(): Map<string, string> {
    const rows: Record<string, string>[] = parse(fs.readFileSync(path.join(EXPORT_DIR, 'dapil.csv')), {
        columns: true,
    });
    const codes = new Map<string, string>();
    for (const row of rows) {
        if (row.pemilu === '2024' && row.kode_provinsi && row.nama_provinsi) {
            codes.set(row.nama_provinsi, row.kode_provinsi);
        }
    }
    return codes;
}

async function main() {
    const source = await fetchSource();
    const codes = readProvinces();
    const names = new Map([...codes].map(([name, code]) => [code, name]));
    // The source still files the new Papua provinces under codes 91 and 92, so codes are taken from the
    // election data by name. Every name must be found there.
    const coded: Collection = {
        type: 'FeatureCollection',
        features: source.features.map((feature) => {
            const name = String(feature.properties.PROVINSI).toUpperCase();
            const code = codes.get(name);
            if (code === undefined || feature.geometry === null) {
                throw new Error(`Province "${name}" of the boundary file is not in dapil.csv, or has no shape`);
            }
            return { ...feature, properties: { kode_2024: code } };
        }),
    };
    const input = path.join(GEO_DIR, 'source', 'provinsi-berkode.geojson');
    fs.writeFileSync(input, JSON.stringify(coded));

    for (const pemilu of PEMILU) {
        const target = path.join(GEO_DIR, pemilu, 'provinsi.geojson');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const code = pemilu === '2019' ? `(${JSON.stringify(PARENT_IN_2019)})[kode_2024] || kode_2024` : 'kode_2024';
        // Joins the shapes that share a code; coordinates are kept to about 10 m, which is all a map needs.
        execFileSync(
            'pnpm',
            [
                'exec',
                'mapshaper',
                input,
                '-each',
                `kode_provinsi = ${code}`,
                '-dissolve',
                'kode_provinsi',
                '-sort',
                'kode_provinsi',
                '-o',
                'precision=0.0001',
                target,
            ],
            { stdio: 'pipe' },
        );
        const collection: Collection = JSON.parse(fs.readFileSync(target, 'utf8'));
        for (const feature of collection.features) {
            const kode = String(feature.properties.kode_provinsi);
            feature.properties = { kode_provinsi: kode, nama_provinsi: names.get(kode) };
        }
        if (collection.features.length !== EXPECTED_PROVINCES[pemilu]) {
            throw new Error(
                `${pemilu}: built ${collection.features.length} provinces, expected ${EXPECTED_PROVINCES[pemilu]}`,
            );
        }
        fs.writeFileSync(target, JSON.stringify(collection));
        console.log(
            `${pemilu}: ${collection.features.length} provinces, ${(fs.statSync(target).size / 1024).toFixed(0)} KB -> ${path.relative('.', target)}`,
        );
    }
    console.log(`Source: ${SOURCE.repository} (BIG)`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
