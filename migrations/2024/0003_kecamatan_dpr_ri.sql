-- pemilu2024: DPR RI candidate votes per kecamatan, from the kupasdapil crawl (see scripts/build-kecamatan-dpr.py).
-- The kelurahan tables hold a fraction of the votes of some dapil; the source publishes the kecamatan counts
-- of those dapil whole. Only rows with votes.

CREATE TABLE kecamatan_suara_caleg_dpr_ri (
    kode_dapil INTEGER NOT NULL,
    kode_kecamatan INTEGER NOT NULL,
    partai_id INTEGER NOT NULL,
    nomor_urut INTEGER NOT NULL,
    suara INTEGER NOT NULL,
    PRIMARY KEY (kode_dapil, kode_kecamatan, partai_id, nomor_urut)
) WITHOUT ROWID;
