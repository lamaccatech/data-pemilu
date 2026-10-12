/**
 * Builds the 2024 kabupaten outlines, one file per province: data/geo/2024/kabupaten/<kode_provinsi>.geojson.
 *
 * They come from the same publication as the 2024 province boundaries, so the two fit when drawn together.
 * Run after build-geo, which downloads the province files this reads the province names from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
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

const SOURCE_DIR = path.join(GEO_DIR, 'source', '2024');
const REPO = 'mashadinoor/Indonesia-Geojson-2026';
const COMMIT = 'c95911f3f23af6e01c3bf706c80e36a9f3958588';
const RAW = `https://raw.githubusercontent.com/${REPO}/${COMMIT}`;
const EXPECTED_PROVINCES = 38;
const DOWNLOADS_AT_ONCE = 8;
/** `Kabupaten/<province>/<kabupaten>.json` */
const KABUPATEN_PATH = /^Kabupaten\/([^/]+)\/([^/]+)\.json$/;
/** The source writes the Kemendagri code as `17.08`. */
const DOTTED_CODE = /^\d{2}\.\d{2}$/;

/** Four decimals is roughly 10 m, the same as the other boundary files. */
const PRECISION = 1e4;

function rounded(coordinates: unknown): unknown {
    if (typeof coordinates === 'number') {
        return Math.round(coordinates * PRECISION) / PRECISION;
    }
    return Array.isArray(coordinates) ? coordinates.map(rounded) : coordinates;
}

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

/**
 * The Kemendagri code of the province a source directory holds. The directory is named like the province
 * file build-geo downloaded, and the code goes by the province name in it, as in build-geo.
 */
function provinceCodeOf(directory: string, codes: Map<string, string>): string {
    const file = path.join(SOURCE_DIR, `${directory}.json`);
    if (!fs.existsSync(file)) {
        throw new Error(`2024: no province file for "${directory}". Run build-geo first.`);
    }
    const province = (JSON.parse(fs.readFileSync(file, 'utf8')) as Collection).features[0];
    const name = String(province?.properties.PROVINSI).toUpperCase();
    const code = codes.get(name);
    if (code === undefined) {
        throw new Error(`2024: province "${name}" is not in dapil.csv`);
    }
    return code;
}

/** `17.08` becomes `1708`. A code that is missing, or of another province, is left out. */
function kabupatenCodeOf(shape: Feature, provinceCode: string): string | null {
    const dotted = shape.properties.KDPKAB;
    if (typeof dotted !== 'string' || !DOTTED_CODE.test(dotted) || !dotted.startsWith(provinceCode)) {
        return null;
    }
    return dotted.replace('.', '');
}

async function main() {
    const codes = readProvinces();
    const tree: { tree: { path: string }[] } = JSON.parse(
        await cached('kabupaten-listing.json', `https://api.github.com/repos/${REPO}/git/trees/${COMMIT}?recursive=1`),
    );
    const sources = tree.tree.flatMap(({ path: sourcePath }) => {
        const [, directory, name] = KABUPATEN_PATH.exec(sourcePath) ?? [];
        return directory === undefined || name === undefined ? [] : [{ directory, name, sourcePath }];
    });

    const byProvince = new Map<string, Feature[]>();
    let withoutCode = 0;
    let withoutShape = 0;
    for (let start = 0; start < sources.length; start += DOWNLOADS_AT_ONCE) {
        const batch = sources.slice(start, start + DOWNLOADS_AT_ONCE);
        const collections = await Promise.all(
            batch.map(({ directory, name, sourcePath }) =>
                cached(`kabupaten/${directory}/${name}.json`, `${RAW}/${encodeURI(sourcePath)}`),
            ),
        );
        for (const [index, text] of collections.entries()) {
            const { directory, name } = batch[index] as (typeof batch)[number];
            const province = provinceCodeOf(directory, codes);
            const features = byProvince.get(province) ?? [];
            for (const shape of (JSON.parse(text) as Collection).features) {
                if (shape.geometry === null) {
                    withoutShape++;
                    continue;
                }
                const code = kabupatenCodeOf(shape, province);
                if (code === null) {
                    withoutCode++;
                }
                features.push({
                    type: 'Feature',
                    properties: {
                        kode_kabupaten: code,
                        // The file name says kabupaten or kota; the properties inside do not.
                        nama_kabupaten: name.replaceAll('_', ' ').toUpperCase(),
                        kode_provinsi: province,
                    },
                    geometry: { type: shape.geometry.type, coordinates: rounded(shape.geometry.coordinates) },
                });
            }
            byProvince.set(province, features);
        }
    }
    if (byProvince.size !== EXPECTED_PROVINCES) {
        throw new Error(`2024: kabupaten in ${byProvince.size} provinces, expected ${EXPECTED_PROVINCES}`);
    }

    const directory = path.join(GEO_DIR, '2024', 'kabupaten');
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    let bytes = 0;
    let largest = 0;
    let kabupaten = 0;
    for (const [province, features] of byProvince) {
        features.sort((a, b) => String(a.properties.nama_kabupaten).localeCompare(String(b.properties.nama_kabupaten)));
        const file = path.join(directory, `${province}.geojson`);
        fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }));
        const size = fs.statSync(file).size;
        bytes += size;
        largest = Math.max(largest, size);
        kabupaten += features.length;
    }
    console.log(
        `kabupaten: ${kabupaten} shapes in ${byProvince.size} files, ${(bytes / 1e6).toFixed(1)} MB ` +
            `(largest ${(largest / 1024).toFixed(0)} KB); ${withoutCode} without a code, ${withoutShape} without a shape`,
    );
    console.log(`  source: Badan Informasi Geospasial, via github.com/${REPO} (MIT)`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
