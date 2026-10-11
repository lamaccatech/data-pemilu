import os from 'node:os';
import path from 'node:path';

export const EXPORT_DIR = process.env.PEMILU_EXPORT_DIR ?? path.join(os.homedir(), 'data/bedah-dapil/export');
export const SQL_DIR = path.resolve('data/sql');
/** Kecamatan and kelurahan shapes as supplied. */
export const GEO_SOURCE_DIR = process.env.PEMILU_GEO_DIR ?? path.join(os.homedir(), 'data/bedah-dapil/geo');
/** Boundary files made by build-geo (ignored by git). */
export const GEO_DIR = path.resolve('data/geo');
/** R2 bucket for the built boundary files. Objects are named <pemilu>/<wilayah>.geojson. */
export const GEO_BUCKET = 'data-pemilu-batas';

export const DATABASES = { '2024': 'pemilu2024', '2019': 'pemilu2019' } as const;
export type Database = (typeof DATABASES)[keyof typeof DATABASES];

/** `tingkat` columns become the small integer of src/tingkat.ts; an empty nullable cell becomes NULL. */
export type ColumnKind = 'int' | 'text' | 'tingkat';

export interface Column {
    name: string;
    kind: ColumnKind;
    nullable?: boolean;
}

export interface Source {
    /** CSV file in the export directory. */
    file: string;
    /** Rows in the file, from the project brief. A different count is an error. */
    expectedRows: number;
    table: string;
    /** True when the file has a `pemilu` column that picks the database; otherwise everything is 2024. */
    byPemilu: boolean;
    columns: Column[];
}

const int = (name: string, nullable = false): Column => ({ name, kind: 'int', nullable });
const text = (name: string, nullable = false): Column => ({ name, kind: 'text', nullable });
const tingkat: Column = { name: 'tingkat', kind: 'tingkat' };

export const SOURCES: Source[] = [
    {
        file: 'partai.csv',
        expectedRows: 44,
        table: 'partai',
        byPemilu: true,
        columns: [int('partai_id'), text('kode_partai'), text('nama_partai')],
    },
    {
        file: 'dapil.csv',
        expectedRows: 5265,
        table: 'dapil',
        byPemilu: true,
        columns: [
            tingkat,
            int('kode_dapil'),
            text('nama_dapil'),
            int('kode_provinsi', true),
            text('nama_provinsi', true),
            int('kode_kabupaten', true),
            text('nama_kabupaten', true),
            int('jumlah_kursi', true),
            int('total_suara_sah'),
        ],
    },
    {
        file: 'suara_partai.csv',
        expectedRows: 87688,
        table: 'suara_partai',
        byPemilu: true,
        columns: [tingkat, int('kode_dapil'), int('partai_id'), int('suara'), text('sumber')],
    },
    {
        file: 'caleg.csv',
        expectedRows: 501437,
        table: 'caleg',
        byPemilu: true,
        columns: [
            tingkat,
            int('kode_dapil'),
            int('partai_id'),
            int('nomor_urut'),
            text('nama'),
            text('jenis_kelamin', true),
            int('suara'),
            int('kursi_ke'),
        ],
    },
    {
        file: 'padanan_dapil.csv',
        expectedRows: 2182,
        table: 'padanan_dapil',
        byPemilu: false,
        columns: [
            tingkat,
            int('kode_dapil_2024'),
            int('kode_dapil_2019'),
            text('nama_dapil_2019'),
            int('sebanding'),
            int('ada_di_hasil_2019'),
            int('ada_di_hasil_2024'),
        ],
    },
    {
        file: 'dapil_kecamatan_2024.csv',
        expectedRows: 21941,
        table: 'dapil_kecamatan',
        byPemilu: false,
        columns: [tingkat, int('kode_dapil'), text('kode_kecamatan'), text('nama_kecamatan')],
    },
    {
        file: 'dapil_alias_2024.csv',
        expectedRows: 70,
        table: 'dapil_alias',
        byPemilu: false,
        columns: [tingkat, text('nama_di_aplikasi'), text('nama_dapil'), int('kode_dapil')],
    },
    {
        file: 'kelurahan_suara_partai_2024.csv',
        expectedRows: 3140001,
        table: 'kelurahan_suara_partai',
        byPemilu: false,
        columns: [tingkat, int('kode_dapil'), int('kode_kelurahan'), int('partai_id'), int('suara')],
    },
    {
        file: 'kelurahan_suara_caleg_2024.csv',
        expectedRows: 7645652,
        table: 'kelurahan_suara_caleg',
        byPemilu: false,
        columns: [tingkat, int('kode_dapil'), int('kode_kelurahan'), int('partai_id'), int('nomor_urut'), int('suara')],
    },
    {
        // Every row of this file is dprd_provinsi (checked by build-sql), so the table has no tingkat column.
        file: 'kecamatan_suara_caleg_dprd_provinsi_2024.csv',
        expectedRows: 673145,
        table: 'kecamatan_suara_caleg',
        byPemilu: false,
        columns: [int('kode_dapil'), int('kode_kecamatan'), int('partai_id'), int('nomor_urut'), int('suara')],
    },
    {
        file: 'kelurahan_dpt_2024.csv',
        expectedRows: 83731,
        table: 'kelurahan_dpt',
        byPemilu: false,
        columns: [
            int('kode_kelurahan'),
            text('nama_kelurahan'),
            int('dpt'),
            int('dpt_l'),
            int('dpt_p'),
            int('usia_kurang21'),
            int('usia_u21_25'),
            int('usia_u26_30'),
            int('usia_u31_40'),
            int('usia_u41_50'),
            int('usia_u51_55'),
            int('usia_lebih55'),
        ],
    },
];

/** Secondary index entries are billed as rows written too: index name -> table, per database. */
export const SECONDARY_INDEXES: Record<string, string> = {
    caleg_partai: 'caleg',
    dapil_kecamatan_kecamatan: 'dapil_kecamatan',
};

export interface Manifest {
    /** Rows written per database and table. */
    rows: Record<Database, Record<string, number>>;
    /** SQL files per database, in the order they must be applied, relative to the SQL directory. */
    files: Record<Database, string[]>;
}

export const MANIFEST_PATH = path.join(SQL_DIR, 'manifest.json');
