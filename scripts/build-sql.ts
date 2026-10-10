/**
 * Turns the export CSV files into SQL files for D1: data/sql/<database>/<table>-NNNN.sql.
 *
 * Input is streamed row by row. Output is the same for the same input, and every table starts with a DELETE,
 * so the files can be applied again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { TINGKAT, type Tingkat } from '../src/tingkat';
import {
    type Column,
    DATABASES,
    type Database,
    EXPORT_DIR,
    MANIFEST_PATH,
    type Manifest,
    SOURCES,
    type Source,
    SQL_DIR,
} from './tables';

/** D1 rejects statements over 100 KB; stay under it. */
const MAX_STATEMENT_BYTES = 90_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/**
 * D1 answers SQLITE_NOMEM to one INSERT with too many values, well before the statement reaches 100 KB: locally
 * 18,000 values pass and 19,400 fail. Stay far below.
 */
const MAX_STATEMENT_VALUES = 10_000;
/** What the source spreadsheet left where a dapil lookup failed. */
const MISSING_CODE = '#N/A';

type Row = Record<string, string>;

/** Writes one table of one database as numbered files of multi-row INSERT statements. */
class TableWriter {
    rows = 0;
    readonly files: string[] = [];
    private readonly head: string;
    private readonly maxTuples: number;
    private tuples: string[] = [];
    private statementBytes = 0;
    private descriptor: number | null = null;
    private fileBytes = 0;

    constructor(
        private readonly database: Database,
        private readonly table: string,
        columns: Column[],
    ) {
        this.head = `INSERT INTO ${table} (${columns.map((column) => column.name).join(',')}) VALUES\n`;
        this.maxTuples = Math.floor(MAX_STATEMENT_VALUES / columns.length);
    }

    add(tuple: string): void {
        // Each tuple is followed by ",\n" or ";\n".
        const bytes = Buffer.byteLength(tuple) + 2;
        const full = this.tuples.length >= this.maxTuples || this.statementBytes + bytes > MAX_STATEMENT_BYTES;
        if (this.tuples.length > 0 && full) {
            this.flush();
        }
        if (this.tuples.length === 0) {
            this.statementBytes = Buffer.byteLength(this.head);
        }
        this.tuples.push(tuple);
        this.statementBytes += bytes;
        this.rows++;
    }

    close(): void {
        this.flush();
        if (this.descriptor === null) {
            // An empty table still gets its DELETE, so a repeated import clears old rows.
            this.open();
        }
        if (this.descriptor !== null) {
            fs.closeSync(this.descriptor);
            this.descriptor = null;
        }
    }

    private open(): void {
        const name = `${this.table}-${String(this.files.length + 1).padStart(4, '0')}.sql`;
        const first = this.files.length === 0;
        this.files.push(path.join(this.database, name));
        this.descriptor = fs.openSync(path.join(SQL_DIR, this.database, name), 'w');
        this.fileBytes = 0;
        if (first) {
            this.write(`DELETE FROM ${this.table};\n`);
        }
    }

    private write(sql: string): void {
        if (this.descriptor === null) {
            throw new Error('no open file');
        }
        fs.writeSync(this.descriptor, sql);
        this.fileBytes += Buffer.byteLength(sql);
    }

    private flush(): void {
        if (this.tuples.length === 0) {
            return;
        }
        if (this.descriptor !== null && this.fileBytes + this.statementBytes > MAX_FILE_BYTES) {
            fs.closeSync(this.descriptor);
            this.descriptor = null;
        }
        if (this.descriptor === null) {
            this.open();
        }
        this.write(`${this.head}${this.tuples.join(',\n')};\n`);
        this.tuples = [];
        this.statementBytes = 0;
    }
}

function sqlValue(column: Column, raw: string | undefined, where: string): string {
    if (raw === undefined) {
        throw new Error(`${where}: column ${column.name} is missing`);
    }
    if (raw === '') {
        if (column.nullable) {
            return 'NULL';
        }
        throw new Error(`${where}: ${column.name} is empty`);
    }
    if (column.kind === 'tingkat') {
        const code = TINGKAT[raw as Tingkat];
        if (code === undefined) {
            throw new Error(`${where}: unknown tingkat "${raw}"`);
        }
        return String(code);
    }
    if (column.kind === 'int') {
        // Codes are stored as integers, so a leading zero would be lost.
        if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
            throw new Error(`${where}: ${column.name} is not a plain non-negative integer: "${raw}"`);
        }
        return raw;
    }
    return `'${raw.replaceAll("'", "''")}'`;
}

function readRows(file: string): AsyncIterable<Row> {
    return fs.createReadStream(path.join(EXPORT_DIR, file)).pipe(parse({ columns: true, bom: true }));
}

/** (tingkat, kode_kecamatan) -> kode_dapil for 2024, or null where a kecamatan is split between dapil. */
async function loadDapilByKecamatan(): Promise<Map<string, string | null>> {
    const dapilByKecamatan = new Map<string, string | null>();
    for await (const row of readRows('dapil_kecamatan_2024.csv')) {
        const key = `${row.tingkat}:${row.kode_kecamatan}`;
        dapilByKecamatan.set(key, dapilByKecamatan.has(key) ? null : (row.kode_dapil ?? null));
    }
    return dapilByKecamatan;
}

async function convert(source: Source, dapilByKecamatan: Map<string, string | null>, manifest: Manifest) {
    const writers = new Map<Database, TableWriter>();
    const databases: Database[] = source.byPemilu ? Object.values(DATABASES) : [DATABASES['2024']];
    for (const database of databases) {
        writers.set(database, new TableWriter(database, source.table, source.columns));
    }
    const hasTingkatColumn = source.columns.some((column) => column.kind === 'tingkat');
    let read = 0;
    let repaired = 0;
    for await (const row of readRows(source.file)) {
        read++;
        const where = `${source.file} row ${read}`;
        if (row.kode_dapil === MISSING_CODE && row.kode_kelurahan !== undefined) {
            // The dapil lookup failed at the source. The kecamatan of the kelurahan names the dapil, unless that
            // kecamatan is split between two dapil.
            const dapil = dapilByKecamatan.get(`${row.tingkat}:${row.kode_kelurahan.slice(0, 6)}`);
            if (!dapil) {
                throw new Error(`${where}: kode_dapil is ${MISSING_CODE} and cannot be found from the kecamatan`);
            }
            row.kode_dapil = dapil;
            repaired++;
        }
        if (!hasTingkatColumn && row.tingkat !== undefined && row.tingkat !== 'dprd_provinsi') {
            throw new Error(`${where}: expected only dprd_provinsi rows, found "${row.tingkat}"`);
        }
        let database: Database = DATABASES['2024'];
        if (source.byPemilu) {
            const found = DATABASES[row.pemilu as keyof typeof DATABASES];
            if (found === undefined) {
                throw new Error(`${where}: unknown pemilu "${row.pemilu}"`);
            }
            database = found;
        }
        const tuple = `(${source.columns.map((column) => sqlValue(column, row[column.name], where)).join(',')})`;
        writers.get(database)?.add(tuple);
    }
    for (const [database, writer] of writers) {
        writer.close();
        manifest.rows[database][source.table] = writer.rows;
        manifest.files[database].push(...writer.files);
    }
    return { read, repaired };
}

async function main() {
    fs.rmSync(SQL_DIR, { recursive: true, force: true });
    const manifest: Manifest = {
        rows: { pemilu2024: {}, pemilu2019: {} },
        files: { pemilu2024: [], pemilu2019: [] },
    };
    for (const database of Object.values(DATABASES)) {
        fs.mkdirSync(path.join(SQL_DIR, database), { recursive: true });
    }
    const dapilByKecamatan = await loadDapilByKecamatan();
    const mismatches: string[] = [];
    console.log(`Reading ${EXPORT_DIR}\n`);
    console.log(
        `${'table'.padEnd(26)}${'expected'.padStart(10)}${'read'.padStart(10)}${'2024'.padStart(10)}${'2019'.padStart(10)}`,
    );
    for (const source of SOURCES) {
        const { read, repaired } = await convert(source, dapilByKecamatan, manifest);
        const in2024 = manifest.rows.pemilu2024[source.table] ?? 0;
        const in2019 = manifest.rows.pemilu2019[source.table];
        const ok = read === source.expectedRows && in2024 + (in2019 ?? 0) === read;
        const cells = [source.expectedRows, read, in2024, in2019 ?? '-'].map((cell) => String(cell).padStart(10));
        console.log(`${source.table.padEnd(26)}${cells.join('')}  ${ok ? 'ok' : 'MISMATCH'}`);
        if (repaired > 0) {
            console.log(
                `  ${repaired} rows had kode_dapil ${MISSING_CODE}; restored from the kecamatan of the kelurahan`,
            );
        }
        if (!ok) {
            mismatches.push(`${source.file}: expected ${source.expectedRows} rows, read ${read}`);
        }
    }
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 4)}\n`);
    for (const database of Object.values(DATABASES)) {
        const bytes = manifest.files[database].reduce(
            (sum, file) => sum + fs.statSync(path.join(SQL_DIR, file)).size,
            0,
        );
        const rows = Object.values(manifest.rows[database]).reduce((sum, count) => sum + count, 0);
        console.log(
            `\n${database}: ${rows} rows in ${manifest.files[database].length} files, ${(bytes / 1e6).toFixed(1)} MB`,
        );
    }
    if (mismatches.length > 0) {
        throw new Error(`Row counts differ from the brief:\n${mismatches.join('\n')}`);
    }
}

main().catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exit(1);
});
