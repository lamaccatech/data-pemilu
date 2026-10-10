-- pemilu2024: the 2024 election. The database is the election, so no table has a `pemilu` column.
-- `tingkat` is 1 dpr_ri, 2 dprd_provinsi, 3 dprd_kabupaten_kota (src/tingkat.ts).
-- Region and dapil codes are stored as integers; none of them starts with a zero. The one exception is
-- dapil_kecamatan.kode_kecamatan, which is text.

CREATE TABLE partai (
    partai_id INTEGER NOT NULL PRIMARY KEY,
    kode_partai TEXT NOT NULL,
    nama_partai TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE dapil (
    tingkat INTEGER NOT NULL,
    kode_dapil INTEGER NOT NULL,
    nama_dapil TEXT NOT NULL,
    kode_provinsi INTEGER,
    nama_provinsi TEXT,
    kode_kabupaten INTEGER,
    nama_kabupaten TEXT,
    jumlah_kursi INTEGER,
    total_suara_sah INTEGER NOT NULL,
    PRIMARY KEY (tingkat, kode_dapil)
) WITHOUT ROWID;

CREATE TABLE suara_partai (
    tingkat INTEGER NOT NULL,
    kode_dapil INTEGER NOT NULL,
    partai_id INTEGER NOT NULL,
    suara INTEGER NOT NULL,
    sumber TEXT NOT NULL,
    PRIMARY KEY (tingkat, kode_dapil, partai_id)
) WITHOUT ROWID;

CREATE TABLE caleg (
    tingkat INTEGER NOT NULL,
    kode_dapil INTEGER NOT NULL,
    partai_id INTEGER NOT NULL,
    nomor_urut INTEGER NOT NULL,
    nama TEXT NOT NULL,
    jenis_kelamin TEXT,
    suara INTEGER NOT NULL,
    kursi_ke INTEGER NOT NULL,
    PRIMARY KEY (tingkat, kode_dapil, partai_id, nomor_urut)
) WITHOUT ROWID;

-- For GET /v1/:pemilu/:tingkat/dapil (endpoint 2): one party's candidates across every dapil of a level, to
-- find suara_caleg_batas. Covering, so the candidate rows themselves are not read.
CREATE INDEX caleg_partai ON caleg (tingkat, partai_id, kode_dapil, suara);

-- The matching 2019 dapil of each 2024 dapil. The 2019 results themselves are in pemilu2019.
CREATE TABLE padanan_dapil (
    tingkat INTEGER NOT NULL,
    kode_dapil_2024 INTEGER NOT NULL,
    kode_dapil_2019 INTEGER NOT NULL,
    nama_dapil_2019 TEXT NOT NULL,
    sebanding INTEGER NOT NULL,
    ada_di_hasil_2019 INTEGER NOT NULL,
    ada_di_hasil_2024 INTEGER NOT NULL,
    PRIMARY KEY (tingkat, kode_dapil_2024)
) WITHOUT ROWID;

-- kode_kecamatan is text: the overseas polling places of DKI JAKARTA II (dpr_ri 3102) have codes such as 99AA01.
CREATE TABLE dapil_kecamatan (
    tingkat INTEGER NOT NULL,
    kode_dapil INTEGER NOT NULL,
    kode_kecamatan TEXT NOT NULL,
    nama_kecamatan TEXT NOT NULL,
    PRIMARY KEY (tingkat, kode_dapil, kode_kecamatan)
) WITHOUT ROWID;

-- For GET /v1/2024/:tingkat/dapil/:kode_dapil/kelurahan (endpoint 6): every dapil that holds a kecamatan, to
-- tell when a kecamatan is split between two dapil.
CREATE INDEX dapil_kecamatan_kecamatan ON dapil_kecamatan (tingkat, kode_kecamatan);

CREATE TABLE dapil_alias (
    tingkat INTEGER NOT NULL,
    nama_di_aplikasi TEXT NOT NULL,
    nama_dapil TEXT NOT NULL,
    kode_dapil INTEGER NOT NULL,
    PRIMARY KEY (tingkat, nama_di_aplikasi)
) WITHOUT ROWID;

-- The first six digits of kode_kelurahan are its kecamatan, so one kecamatan is one range of the primary key.
CREATE TABLE kelurahan_suara_partai (
    tingkat INTEGER NOT NULL,
    kode_dapil INTEGER NOT NULL,
    kode_kelurahan INTEGER NOT NULL,
    partai_id INTEGER NOT NULL,
    suara INTEGER NOT NULL,
    PRIMARY KEY (tingkat, kode_dapil, kode_kelurahan, partai_id)
) WITHOUT ROWID;

-- dpr_ri and dprd_kabupaten_kota only, and only rows with votes.
CREATE TABLE kelurahan_suara_caleg (
    tingkat INTEGER NOT NULL,
    kode_dapil INTEGER NOT NULL,
    kode_kelurahan INTEGER NOT NULL,
    partai_id INTEGER NOT NULL,
    nomor_urut INTEGER NOT NULL,
    suara INTEGER NOT NULL,
    PRIMARY KEY (tingkat, kode_dapil, kode_kelurahan, partai_id, nomor_urut)
) WITHOUT ROWID;

-- dprd_provinsi only, which is why there is no tingkat column: candidate votes at this level stop at kecamatan.
CREATE TABLE kecamatan_suara_caleg (
    kode_dapil INTEGER NOT NULL,
    kode_kecamatan INTEGER NOT NULL,
    partai_id INTEGER NOT NULL,
    nomor_urut INTEGER NOT NULL,
    suara INTEGER NOT NULL,
    PRIMARY KEY (kode_dapil, kode_kecamatan, partai_id, nomor_urut)
) WITHOUT ROWID;

CREATE TABLE kelurahan_dpt (
    kode_kelurahan INTEGER NOT NULL PRIMARY KEY,
    nama_kelurahan TEXT NOT NULL,
    dpt INTEGER NOT NULL,
    dpt_l INTEGER NOT NULL,
    dpt_p INTEGER NOT NULL,
    usia_kurang21 INTEGER NOT NULL,
    usia_u21_25 INTEGER NOT NULL,
    usia_u26_30 INTEGER NOT NULL,
    usia_u31_40 INTEGER NOT NULL,
    usia_u41_50 INTEGER NOT NULL,
    usia_u51_55 INTEGER NOT NULL,
    usia_lebih55 INTEGER NOT NULL
) WITHOUT ROWID;
