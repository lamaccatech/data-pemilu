/**
 * Builds the 2024 dapil outlines: data/geo/2024/dapil/<tingkat>/<kode_provinsi>.geojson.
 *
 * A dapil is the union of its kecamatan shapes (dapil_kecamatan_2024.csv says which). Where one kecamatan is
 * shared by two dapil, its kelurahan shapes are used instead, each given to the dapil it has votes in.
 * 2019 has no kecamatan list, so there are no 2019 dapil outlines.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { parse as parseSync } from 'csv-parse/sync';
import { TINGKAT_NAMES, type Tingkat } from '../src/tingkat';
import { EXPORT_DIR, GEO_DIR, GEO_SOURCE_DIR } from './tables';

interface Feature {
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown } | null;
}
interface Collection {
    type: 'FeatureCollection';
    features: Feature[];
}

/** Overseas polling places are listed as kecamatan of DKI JAKARTA II and have no shape. */
const OVERSEAS_PREFIX = '99';
const WORK_DIR = path.join(GEO_DIR, 'source', 'dapil');

const GAP_FILL = '15km2';
/** A turn sharper than about 177 degrees is a spike, not a border. */
const SPIKE_COSINE = -0.9985;

type Ring = [number, number][];

/** Drops repeated points and spikes: places where the line runs out to a point and straight back. */
function trimRing(ring: Ring): Ring {
    const points = ring.slice(0, -1);
    let changed = true;
    while (changed && points.length > 3) {
        changed = false;
        for (let index = 0; index < points.length && points.length > 3; index++) {
            const before = points[(index - 1 + points.length) % points.length] as [number, number];
            const here = points[index] as [number, number];
            const after = points[(index + 1) % points.length] as [number, number];
            // Out along one line and back along almost the same one: the turn is a near reversal.
            const outX = here[0] - before[0];
            const outY = here[1] - before[1];
            const backX = after[0] - here[0];
            const backY = after[1] - here[1];
            const lengths = Math.hypot(outX, outY) * Math.hypot(backX, backY);
            const reversal = lengths === 0 || (outX * backX + outY * backY) / lengths < SPIKE_COSINE;
            if (reversal) {
                points.splice(index, 1);
                index = Math.max(index - 2, -1);
                changed = true;
            }
        }
    }
    return [...points, points[0] as [number, number]];
}

function withoutSpikes(geometry: Feature['geometry']): Feature['geometry'] {
    if (geometry === null) {
        return null;
    }
    const polygons = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates) as Ring[][];
    // A ring needs four points; anything smaller was a spike or a speck.
    const cleaned = polygons
        .map((rings) => rings.map(trimRing).filter((ring) => ring.length >= 4))
        .filter(
            (rings, index) =>
                rings.length > 0 && polygons[index]?.[0] !== undefined && trimRing(polygons[index][0]).length >= 4,
        );
    return geometry.type === 'Polygon'
        ? { type: 'Polygon', coordinates: cleaned[0] ?? [] }
        : { type: 'MultiPolygon', coordinates: cleaned };
}

const readCsv = (file: string): Record<string, string>[] =>
    parseSync(fs.readFileSync(path.join(EXPORT_DIR, file)), { columns: true, bom: true });

const readShapes = (file: string): Feature[] =>
    (JSON.parse(fs.readFileSync(path.join(GEO_SOURCE_DIR, file), 'utf8')) as Collection).features;

/** For the kecamatan shared by two dapil: kode_kelurahan -> kode_dapil, from where the kelurahan has votes. */
async function dapilOfKelurahan(tingkat: Tingkat, sharedKecamatan: Set<string>): Promise<Map<string, string>> {
    const dapil = new Map<string, string>();
    if (sharedKecamatan.size === 0) {
        return dapil;
    }
    const rows = fs
        .createReadStream(path.join(EXPORT_DIR, 'kelurahan_suara_partai_2024.csv'))
        .pipe(parse({ columns: true, bom: true }));
    for await (const row of rows as AsyncIterable<Record<string, string>>) {
        if (row.tingkat === tingkat && row.kode_kelurahan && sharedKecamatan.has(row.kode_kelurahan.slice(0, 6))) {
            dapil.set(row.kode_kelurahan, row.kode_dapil ?? '');
        }
    }
    return dapil;
}

async function build(tingkat: Tingkat, kecamatanShapes: Feature[]) {
    const dapilRows = readCsv('dapil.csv').filter((row) => row.pemilu === '2024' && row.tingkat === tingkat);
    const members = readCsv('dapil_kecamatan_2024.csv').filter((row) => row.tingkat === tingkat);
    const dapilOfKecamatan = new Map<string, string[]>();
    for (const row of members) {
        const code = row.kode_kecamatan ?? '';
        dapilOfKecamatan.set(code, [...(dapilOfKecamatan.get(code) ?? []), row.kode_dapil ?? '']);
    }
    const shared = new Set([...dapilOfKecamatan].filter(([, dapil]) => dapil.length > 1).map(([code]) => code));
    const kelurahanDapil = await dapilOfKelurahan(tingkat, shared);

    // Every piece of land with the dapil it belongs to.
    const pieces: Feature[] = [];
    const withShape = new Set<string>();
    for (const shape of kecamatanShapes) {
        const code = String(shape.properties.code);
        const dapil = dapilOfKecamatan.get(code);
        if (dapil === undefined || shape.geometry === null) {
            continue;
        }
        withShape.add(code);
        if (dapil.length === 1) {
            pieces.push({ type: 'Feature', properties: { kode_dapil: dapil[0] }, geometry: shape.geometry });
        }
    }
    let kelurahanUnplaced = 0;
    for (const kabupaten of new Set([...shared].map((code) => code.slice(0, 4)))) {
        for (const shape of readShapes(`kelurahan/${kabupaten}.geojson`)) {
            if (!shared.has(String(shape.properties.parent_code)) || shape.geometry === null) {
                continue;
            }
            const dapil = kelurahanDapil.get(String(shape.properties.code));
            if (dapil === undefined) {
                // No votes recorded anywhere: nothing says which of the two dapil it is in.
                kelurahanUnplaced++;
                continue;
            }
            pieces.push({ type: 'Feature', properties: { kode_dapil: dapil }, geometry: shape.geometry });
        }
    }

    fs.mkdirSync(WORK_DIR, { recursive: true });
    const input = path.join(WORK_DIR, `${tingkat}-potongan.geojson`);
    const output = path.join(WORK_DIR, `${tingkat}.geojson`);
    fs.writeFileSync(input, JSON.stringify({ type: 'FeatureCollection', features: pieces }));
    // Kecamatan shapes do not meet perfectly: gaps under 15 km2 are closed before and after the union. A
    // kecamatan without a shape is larger than that and stays open.
    const clean = ['-clean', `gap-fill-area=${GAP_FILL}`];
    execFileSync(
        'pnpm',
        [
            'exec',
            'mapshaper',
            input,
            'snap',
            ...clean,
            '-dissolve',
            'kode_dapil',
            ...clean,
            '-o',
            'precision=0.0001',
            output,
        ],
        { stdio: 'pipe' },
    );
    const outlines = new Map<string, Feature['geometry']>();
    for (const feature of (JSON.parse(fs.readFileSync(output, 'utf8')) as Collection).features) {
        outlines.set(String(feature.properties.kode_dapil), withoutSpikes(feature.geometry));
    }

    const missing = new Map<string, number>();
    for (const row of members) {
        const code = row.kode_kecamatan ?? '';
        if (!withShape.has(code) && !code.startsWith(OVERSEAS_PREFIX)) {
            missing.set(row.kode_dapil ?? '', (missing.get(row.kode_dapil ?? '') ?? 0) + 1);
        }
    }
    const byProvince = new Map<string, Feature[]>();
    let withoutOutline = 0;
    for (const row of dapilRows.sort((a, b) => Number(a.kode_dapil) - Number(b.kode_dapil))) {
        const geometry = outlines.get(row.kode_dapil ?? '') ?? null;
        if (geometry === null) {
            withoutOutline++;
        }
        const province = row.kode_provinsi ?? '';
        const features = byProvince.get(province) ?? [];
        features.push({
            type: 'Feature',
            properties: {
                kode_dapil: row.kode_dapil,
                nama_dapil: row.nama_dapil,
                kode_provinsi: province,
                kode_kabupaten: row.kode_kabupaten || null,
                jumlah_kursi: row.jumlah_kursi ? Number(row.jumlah_kursi) : null,
                // Kecamatan of the dapil that have no shape; the outline falls short by them.
                kecamatan_tanpa_batas: missing.get(row.kode_dapil ?? '') ?? 0,
            },
            geometry,
        });
        byProvince.set(province, features);
    }
    const directory = path.join(GEO_DIR, '2024', 'dapil', tingkat);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    let bytes = 0;
    let largest = 0;
    for (const [province, features] of byProvince) {
        const file = path.join(directory, `${province}.geojson`);
        fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }));
        bytes += fs.statSync(file).size;
        largest = Math.max(largest, fs.statSync(file).size);
    }
    const incomplete = [...missing.values()].length;
    console.log(
        `${tingkat}: ${dapilRows.length} dapil in ${byProvince.size} files, ${(bytes / 1e6).toFixed(1)} MB (largest ${(largest / 1024).toFixed(0)} KB); ` +
            `${withoutOutline} without any outline, ${incomplete} missing some kecamatan; ` +
            `${shared.size} shared kecamatan, ${kelurahanUnplaced} of their kelurahan could not be placed`,
    );
}

async function main() {
    const kecamatanShapes = readShapes('kecamatan.geojson');
    for (const tingkat of TINGKAT_NAMES) {
        await build(tingkat, kecamatanShapes);
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
