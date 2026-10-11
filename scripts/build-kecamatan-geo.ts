/**
 * Builds the 2024 kecamatan shapes, one file per kabupaten: data/geo/2024/kecamatan/<kode_kabupaten>.geojson.
 *
 * They are the shapes the dapil outlines are made of, kept apart so the inside of a dapil can be drawn.
 * 2019 has none: nothing lists which kecamatan existed then.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GEO_DIR, GEO_SOURCE_DIR } from './tables';

interface Feature {
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown } | null;
}

/** Four decimals is roughly 10 m, the same as the other boundary files. */
const PRECISION = 1e4;

function rounded(coordinates: unknown): unknown {
    if (typeof coordinates === 'number') {
        return Math.round(coordinates * PRECISION) / PRECISION;
    }
    return Array.isArray(coordinates) ? coordinates.map(rounded) : coordinates;
}

function main() {
    const source = JSON.parse(fs.readFileSync(path.join(GEO_SOURCE_DIR, 'kecamatan.geojson'), 'utf8')) as {
        features: Feature[];
    };
    const byKabupaten = new Map<string, Feature[]>();
    let withoutShape = 0;
    for (const shape of source.features) {
        if (shape.geometry === null) {
            withoutShape++;
            continue;
        }
        const kabupaten = String(shape.properties.parent_code);
        const features = byKabupaten.get(kabupaten) ?? [];
        features.push({
            type: 'Feature',
            properties: {
                kode_kecamatan: String(shape.properties.code),
                nama_kecamatan: String(shape.properties.name).toUpperCase(),
                kode_kabupaten: kabupaten,
            },
            geometry: { type: shape.geometry.type, coordinates: rounded(shape.geometry.coordinates) },
        });
        byKabupaten.set(kabupaten, features);
    }

    const directory = path.join(GEO_DIR, '2024', 'kecamatan');
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    let bytes = 0;
    let largest = 0;
    let kecamatan = 0;
    for (const [kabupaten, features] of byKabupaten) {
        features.sort((a, b) => String(a.properties.kode_kecamatan).localeCompare(String(b.properties.kode_kecamatan)));
        const file = path.join(directory, `${kabupaten}.geojson`);
        fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }));
        const size = fs.statSync(file).size;
        bytes += size;
        largest = Math.max(largest, size);
        kecamatan += features.length;
    }
    console.log(
        `kecamatan: ${kecamatan} shapes in ${byKabupaten.size} files, ${(bytes / 1e6).toFixed(1)} MB ` +
            `(largest ${(largest / 1024).toFixed(0)} KB); ${withoutShape} without a shape`,
    );
}

main();
