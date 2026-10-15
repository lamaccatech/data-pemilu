-- pemilu2024: dprd_provinsi candidate votes per kecamatan from a second source (see
-- scripts/build-kecamatan-pelengkap.py), beside kecamatan_suara_caleg. They cover kecamatan the first table
-- lacks. Only rows with votes.

CREATE TABLE kecamatan_suara_caleg_pelengkap (
    kode_dapil INTEGER NOT NULL,
    kode_kecamatan INTEGER NOT NULL,
    partai_id INTEGER NOT NULL,
    nomor_urut INTEGER NOT NULL,
    suara INTEGER NOT NULL,
    PRIMARY KEY (kode_dapil, kode_kecamatan, partai_id, nomor_urut)
) WITHOUT ROWID;
