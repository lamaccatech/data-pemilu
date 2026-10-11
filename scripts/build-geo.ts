/**
 * Builds province boundaries for both elections: data/geo/<pemilu>/provinsi.geojson.
 *
 * Each election gets the provinces as they stood then, from a published source pinned to one commit:
 * 38 provinces for 2024 and 34 for 2019, before Papua and Papua Barat were divided. Province codes are the
 * Kemendagri codes of the election data, matched by province name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { PEMILU, type Pemilu } from '../src/tingkat';
import { EXPORT_DIR, GEO_DIR } from './tables';

interface Feature {
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown } | null;
}
interface Collection {
    type: 'FeatureCollection';
    features: Feature[];
}
interface Source {
    /** Shown in the README and printed after a build. */
    credit: string;
    expectedProvinces: number;
    /** The property that holds the province name. */
    nameProperty: string;
    load(): Promise<Feature[]>;
}

const SOURCE_DIR = path.join(GEO_DIR, 'source');
const RAW = 'https://raw.githubusercontent.com';
const REPO_2024 = 'mashadinoor/Indonesia-Geojson-2026';
const COMMIT_2024 = 'c95911f3f23af6e01c3bf706c80e36a9f3958588';
const REPO_2019 = 'habibrosyad/indonesia-geojson';
const COMMIT_2019 = '3236ec94c4e3be484c9888e3efa5e500245d6be9';

/** Downloads once into data/geo/source and reads from there afterwards. */
async function cached(name: string, url: string): Promise<string> {
    const file = path.join(SOURCE_DIR, name);
    if (!fs.existsSync(file)) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Download failed (${response.status}): ${url}`);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    return fs.readFileSync(file, 'utf8');
}

const SOURCES: Record<Pemilu, Source> = {
    '2024': {
        credit: `Badan Informasi Geospasial, via github.com/${REPO_2024} (MIT)`,
        expectedProvinces: 38,
        nameProperty: 'PROVINSI',
        // One file per province.
        async load() {
            const listing = await cached(
                '2024/listing.json',
                `https://api.github.com/repos/${REPO_2024}/contents/Provinsi?ref=${COMMIT_2024}`,
            );
            const files: { name: string }[] = JSON.parse(listing);
            const features: Feature[] = [];
            for (const { name } of files) {
                const url = `${RAW}/${REPO_2024}/${COMMIT_2024}/Provinsi/${encodeURIComponent(name)}`;
                const collection: Collection = JSON.parse(await cached(`2024/${name}`, url));
                features.push(...collection.features);
            }
            return features;
        },
    },
    '2019': {
        credit: `Badan Pusat Statistik 2019, published by OCHA on HDX (CC BY-IGO), via github.com/${REPO_2019}`,
        expectedProvinces: 34,
        nameProperty: 'ADM1_ID',
        async load() {
            const url = `${RAW}/${REPO_2019}/${COMMIT_2019}/idn_adm1_bps_2019.json`;
            const collection: Collection = JSON.parse(await cached('2019/idn_adm1_bps_2019.json', url));
            return collection.features;
        },
    },
};

/** Province names and codes as the election data has them: NAMA -> kode. */
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

/** Coordinates to four decimals, about 10 m: all a map needs, and roughly half the bytes. */
function round(coordinates: unknown): unknown {
    if (typeof coordinates === 'number') {
        return Math.round(coordinates * 10_000) / 10_000;
    }
    return (coordinates as unknown[]).map(round);
}

async function main() {
    const codes = readProvinces();
    for (const pemilu of PEMILU) {
        const source = SOURCES[pemilu];
        const features = (await source.load()).map((feature): Feature => {
            // The sources use their own codes (BPS numbers Papua and Papua Barat differently from Kemendagri),
            // so the code comes from the election data by name. Every name must be found there.
            const name = String(feature.properties[source.nameProperty]).toUpperCase();
            const code = codes.get(name);
            if (code === undefined || feature.geometry === null) {
                throw new Error(`${pemilu}: province "${name}" is not in dapil.csv, or has no shape`);
            }
            return {
                type: 'Feature',
                properties: { kode_provinsi: code, nama_provinsi: name },
                geometry: { type: feature.geometry.type, coordinates: round(feature.geometry.coordinates) },
            };
        });
        features.sort((a, b) => String(a.properties.kode_provinsi).localeCompare(String(b.properties.kode_provinsi)));
        const distinct = new Set(features.map((feature) => feature.properties.kode_provinsi)).size;
        if (features.length !== source.expectedProvinces || distinct !== features.length) {
            throw new Error(
                `${pemilu}: ${features.length} provinces (${distinct} distinct), expected ${source.expectedProvinces}`,
            );
        }
        const target = path.join(GEO_DIR, pemilu, 'provinsi.geojson');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify({ type: 'FeatureCollection', features }));
        const size = (fs.statSync(target).size / 1024).toFixed(0);
        console.log(`${pemilu}: ${features.length} provinces, ${size} KB -> ${path.relative('.', target)}`);
        console.log(`  source: ${source.credit}`);
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
