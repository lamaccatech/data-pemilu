/**
 * Builds the 2024 kelurahan shapes, one file per kabupaten: data/geo/2024/kelurahan/<kode_kabupaten>.geojson.
 *
 * They are the shapes a kecamatan is made of, kept apart so a single kelurahan can be drawn on the map when
 * its result is read. Per kabupaten like the kecamatan files, so the browser loads one small file.
 * 2019 has none: nothing lists which kelurahan existed then.
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
const KABUPATEN_FILE = /^(\d{4})\.geojson$/;

function rounded(coordinates: unknown): unknown {
    if (typeof coordinates === 'number') {
        return Math.round(coordinates * PRECISION) / PRECISION;
    }
    return Array.isArray(coordinates) ? coordinates.map(rounded) : coordinates;
}

function main() {
    const sourceDirectory = path.join(GEO_SOURCE_DIR, 'kelurahan');
    const directory = path.join(GEO_DIR, '2024', 'kelurahan');
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });

    let bytes = 0;
    let largest = 0;
    let kelurahan = 0;
    let withoutShape = 0;
    let files = 0;
    for (const name of fs.readdirSync(sourceDirectory).sort()) {
        const match = KABUPATEN_FILE.exec(name);
        if (match === null) {
            continue;
        }
        const kabupaten = match[1];
        const source = JSON.parse(fs.readFileSync(path.join(sourceDirectory, name), 'utf8')) as {
            features: Feature[];
        };
        const features: Feature[] = [];
        for (const shape of source.features) {
            if (shape.geometry === null) {
                withoutShape++;
                continue;
            }
            features.push({
                type: 'Feature',
                properties: {
                    kode_kelurahan: String(shape.properties.code),
                    nama_kelurahan: String(shape.properties.name).toUpperCase(),
                    kode_kecamatan: String(shape.properties.parent_code),
                    kode_kabupaten: kabupaten,
                },
                geometry: { type: shape.geometry.type, coordinates: rounded(shape.geometry.coordinates) },
            });
        }
        features.sort((a, b) => String(a.properties.kode_kelurahan).localeCompare(String(b.properties.kode_kelurahan)));
        const file = path.join(directory, `${kabupaten}.geojson`);
        fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }));
        const size = fs.statSync(file).size;
        bytes += size;
        largest = Math.max(largest, size);
        kelurahan += features.length;
        files++;
    }
    console.log(
        `kelurahan: ${kelurahan} shapes in ${files} files, ${(bytes / 1e6).toFixed(1)} MB ` +
            `(largest ${(largest / 1024).toFixed(0)} KB); ${withoutShape} without a shape`,
    );
}

main();
