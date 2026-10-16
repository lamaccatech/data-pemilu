/**
 * Asks the API for every answer that is the same for all candidates of a dapil, so that each is computed once and
 * kept in KV (see `http/cache.ts`). Run it after every load and every `RESPONSE_VERSION` change.
 *
 *   pnpm prewarm https://api.example.com <api key>
 *   pnpm prewarm http://localhost:8787 kunci-lokal --tingkat dpr_ri
 *
 * What it asks for, for 2024: `/caleg` for each party of each dapil, `/caleg-wilayah` by kecamatan (and by
 * kabupaten, where the level has it), and `/kekuatan` for each party over the country and each province.
 * Answers that name one candidate (`/caleg/:partai/:nomor_urut/wilayah`) are not prewarmed: there are
 * hundreds of thousands, and the dashboard reads the dapil answers instead.
 */
import { TINGKAT_NAMES } from '../src/tingkat';

const CONCURRENCY = 8;
const RETRIES = 2;

const [base, key, ...flags] = process.argv.slice(2);
if (base === undefined || key === undefined) {
    console.error('usage: pnpm prewarm <base url> <api key> [--tingkat dpr_ri|dprd_provinsi|dprd_kabupaten_kota]');
    process.exit(1);
}
const onlyTingkat = flags[0] === '--tingkat' ? flags[1] : undefined;

async function get<T>(path: string): Promise<{ data: T }> {
    for (let attempt = 0; ; attempt++) {
        const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}` } });
        if (response.ok) {
            return (await response.json()) as { data: T };
        }
        if (attempt >= RETRIES || response.status < 500) {
            throw new Error(`${response.status} ${path}`);
        }
    }
}

interface Standing {
    kode_dapil: string;
    kode_provinsi: string | null;
    partai: { kode_partai: string }[];
}

const paths: string[] = [];
const provincesByLevel = new Map<string, Set<string>>();
const partiesByLevel = new Map<string, Set<string>>();

for (const tingkat of TINGKAT_NAMES) {
    if (onlyTingkat !== undefined && onlyTingkat !== tingkat) {
        continue;
    }
    const { data: dapil } = await get<Standing[]>(`/v1/2024/${tingkat}/persaingan`);
    const provinces = new Set<string>();
    const parties = new Set<string>();
    for (const row of dapil) {
        if (row.kode_provinsi !== null) {
            provinces.add(row.kode_provinsi);
        }
        paths.push(`/v1/2024/${tingkat}/dapil/${row.kode_dapil}/caleg-wilayah?tingkat_wilayah=kecamatan`);
        if (tingkat !== 'dprd_kabupaten_kota') {
            paths.push(`/v1/2024/${tingkat}/dapil/${row.kode_dapil}/caleg-wilayah?tingkat_wilayah=kabupaten`);
        }
        for (const party of row.partai) {
            parties.add(party.kode_partai);
            paths.push(`/v1/2024/${tingkat}/dapil/${row.kode_dapil}/caleg?partai=${party.kode_partai}`);
        }
    }
    provincesByLevel.set(tingkat, provinces);
    partiesByLevel.set(tingkat, parties);
}
for (const [tingkat, parties] of partiesByLevel) {
    for (const party of parties) {
        paths.push(`/v1/2024/${tingkat}/kekuatan?partai=${party}`);
        if (tingkat === 'dprd_kabupaten_kota') {
            continue;
        }
        for (const province of provincesByLevel.get(tingkat) ?? []) {
            paths.push(`/v1/2024/${tingkat}/kekuatan?partai=${party}&provinsi=${province}`);
        }
    }
}

console.log(`${paths.length} answers`);
let done = 0;
const failed: string[] = [];
const queue = [...paths];
await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
        for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
            // 404s are expected: a party can be listed in a dapil where it has no candidates.
            await get(path).catch((error: Error) => {
                if (!error.message.startsWith('404')) {
                    failed.push(error.message);
                }
            });
            done++;
            if (done % 500 === 0) {
                console.log(`${done}/${paths.length}`);
            }
        }
    }),
);
console.log(`done, ${failed.length} failed`);
for (const line of failed.slice(0, 20)) {
    console.log(`  ${line}`);
}
process.exit(failed.length === 0 ? 0 : 1);
