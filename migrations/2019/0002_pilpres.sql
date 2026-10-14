-- pemilu2019: Pilpres (Pemilihan Presiden dan Wakil Presiden 2019)
-- tingkat: 0 nasional, 1 provinsi, 2 kabupaten

CREATE TABLE paslon (
    nomor_urut INTEGER NOT NULL PRIMARY KEY,
    nama_lengkap TEXT NOT NULL,
    nama_singkat TEXT NOT NULL,
    capres TEXT NOT NULL,
    cawapres TEXT NOT NULL,
    warna TEXT NOT NULL,
    foto TEXT,
    partai_pengusung TEXT
) WITHOUT ROWID;

CREATE TABLE suara_pilpres (
    tingkat INTEGER NOT NULL,
    kode_wilayah TEXT NOT NULL,
    nama_wilayah TEXT NOT NULL,
    parent_kode TEXT,
    total_suara_sah INTEGER NOT NULL,
    nomor_urut INTEGER NOT NULL,
    suara INTEGER NOT NULL,
    persentase REAL NOT NULL,
    PRIMARY KEY (tingkat, kode_wilayah, nomor_urut)
) WITHOUT ROWID;

CREATE INDEX idx_pilpres_parent ON suara_pilpres (tingkat, parent_kode);
CREATE INDEX idx_pilpres_wilayah ON suara_pilpres (kode_wilayah);
