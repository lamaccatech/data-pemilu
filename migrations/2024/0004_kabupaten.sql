-- pemilu2024: candidate and party votes per kabupaten of a dapil, dpr_ri and dprd_provinsi, from the kupasdapil
-- crawl (see scripts/build-kabupaten.py). Unlike the kelurahan tables these add up to the dapil totals.
-- kode_kabupaten is text: overseas dapil of dpr_ri carry codes that are not numeric.

CREATE TABLE kabupaten_suara_caleg (
    tingkat INTEGER NOT NULL,
    kode_dapil INTEGER NOT NULL,
    kode_kabupaten TEXT NOT NULL,
    partai_id INTEGER NOT NULL,
    nomor_urut INTEGER NOT NULL,
    suara INTEGER NOT NULL,
    PRIMARY KEY (tingkat, kode_dapil, kode_kabupaten, partai_id, nomor_urut)
) WITHOUT ROWID;

CREATE TABLE kabupaten_suara_partai (
    tingkat INTEGER NOT NULL,
    kode_dapil INTEGER NOT NULL,
    kode_kabupaten TEXT NOT NULL,
    nama_kabupaten TEXT NOT NULL,
    partai_id INTEGER NOT NULL,
    suara INTEGER NOT NULL,
    PRIMARY KEY (tingkat, kode_dapil, kode_kabupaten, partai_id)
) WITHOUT ROWID;
