-- pemilu2019: the 2019 election, dapil level only. Same tables as the first four of pemilu2024.
-- `tingkat` is 1 dpr_ri, 2 dprd_provinsi, 3 dprd_kabupaten_kota (src/tingkat.ts).

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
