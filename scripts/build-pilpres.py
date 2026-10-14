#!/usr/bin/env python3
"""Build and load Pilpres (Presidential Election) data into local D1 and SQL files.

Reads:
  - ~/data/kupasdapil/data/pemilu/2024/pilpres/
  - ~/data/kupasdapil/data/pemilu/2019/pilpres/

Writes:
  - Local SQLite databases in .wrangler/state/v3/d1/miniflare-D1DatabaseObject/
  - data/sql/pemilu2024/pilpres.sql
  - data/sql/pemilu2019/pilpres.sql
"""
import glob
import gzip
import json
import os
import re
import sqlite3
import sys

KUPAS_DIR = os.path.expanduser('~/data/kupasdapil')
DATA_PEMILU_DIR = os.path.expanduser('~/code/data-pemilu')

PASLON_2024 = [
    (1, "H. Anies Rasyid Baswedan, S.E., M.P.P., Ph.D. - Dr. (H.C.) Drs. H. Abdul Muhaimin Iskandar, M.Si.", "Anies - Muhaimin", "Anies Baswedan", "Muhaimin Iskandar", "#1565C0", "/images/foto-capres/1.jpg", json.dumps(["nasdem", "pkb", "pks", "ummat"])),
    (2, "H. Prabowo Subianto - Gibran Rakabuming Raka, B.Sc.", "Prabowo - Gibran", "Prabowo Subianto", "Gibran Rakabuming Raka", "#5599FF", "/images/foto-capres/2.jpg", json.dumps(["gerindra", "golkar", "demokrat", "pan", "psi", "pbb", "garuda", "gelora"])),
    (3, "H. Ganjar Pranowo, S.H., M.I.P. - Prof. Dr. H. M. Mahfud MD, S.H., S.U., M.I.P.", "Ganjar - Mahfud", "Ganjar Pranowo", "Mahfud MD", "#C62828", "/images/foto-capres/3.jpg", json.dumps(["pdip", "ppp", "perindo", "hanura"]))
]

PASLON_2019 = [
    (1, "Ir. H. Joko Widodo - Prof. Dr. (H.C) KH. Ma'ruf Amin", "Jokowi - Ma'ruf", "Jokowi", "Ma'ruf Amin", "#C62828", "/images/foto-capres/2019-1.jpg", json.dumps(["pdip", "golkar", "pkb", "nasdem", "ppp", "hanura", "pkpi", "perindo", "psi"])),
    (2, "H. Prabowo Subianto - Sandiaga Salahuddin Uno", "Prabowo - Sandi", "Prabowo Subianto", "Sandiaga Uno", "#1565C0", "/images/foto-capres/2019-2.jpg", json.dumps(["gerindra", "pks", "pan", "demokrat", "berkarya"]))
]

ALIASES_2019_KAB = {
    'TOLITOLI': 'TOLI-TOLI',
    'TOJO UNA-UNA': 'TOJO UNA UNA',
    'MUKOMUKO': 'MUKO-MUKO',
    'FAKFAK': 'FAK-FAK',
    'TIMOR TENGAH SELATAN': '5302',
    'KOTA LUBUKLINGGAU': 'KOTA LUBUK LINGGAU',
    'GORONTALO.': 'GORONTALO',
    'PAHUWATO': 'POHUWATO',
    'KOTA PARE PARE': 'KOTA PAREPARE',
    'PEGUNUNGAN BINTANG': '9502',
    'KOTA TANJUNGPINANG': 'KOTA TANJUNG PINANG',
    'TOBA SAMOSIR': 'TOBA',
    'KEPULAUAN SIAU TAGULANDANG BIARO': 'KEP. SIAU TAGULANDANG BIARO',
    'KOTA PANGKALPINANG': 'KOTA PANGKAL PINANG',
    'KEPULAUAN SERIBU': 'ADM. KEP. SERIBU',
    'BATANGHARI': 'BATANG HARI',
    'PANGKAJENE DAN KEPULAUAN': 'PANGKAJENE KEPULAUAN',
    'TULANGBAWANG': 'TULANG BAWANG',
    'TULANGBAWANG BARAT': 'TULANG BAWANG BARAT',
    'MAMUJU UTARA': 'PASANGKAYU',
    'JAKARTA PUSAT': '3171',
    'JAKARTA UTARA': '3172',
    'JAKARTA BARAT': '3173',
    'JAKARTA SELATAN': '3174',
    'JAKARTA TIMUR': '3175',
    'MALUKU TENGGARA BARAT': '8103',
}


def find_db_file(target_caleg_count):
    files = glob.glob(os.path.join(DATA_PEMILU_DIR, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite'))
    for f in files:
        try:
            conn = sqlite3.connect(f)
            cur = conn.cursor()
            cur.execute('SELECT count(*) FROM caleg')
            count = cur.fetchone()[0]
            conn.close()
            if abs(count - target_caleg_count) < 5000:
                return f
        except Exception:
            pass
    raise RuntimeError(f'Could not find database with ~{target_caleg_count} caleg rows')


def process_2024():
    print('Processing 2024 Pilpres...')
    base = os.path.join(KUPAS_DIR, 'data/pemilu/2024/pilpres')
    rows = []

    # 1. Nasional (tingkat = 0)
    with gzip.open(os.path.join(base, 'nasional.json.gz'), 'rt') as f:
        nas_data = json.load(f)['data']

    total_sah_nas = nas_data['total_suara_sah']
    for p in nas_data['paslon']:
        rows.append((0, '00', 'INDONESIA', None, total_sah_nas, p['no_urut'], p['suara'], p['persentase']))

    # 2. Provinsi (tingkat = 1)
    for p in nas_data['provinsi']:
        prov_code = p['kode']
        prov_name = p['pro_name']
        prov_sah = p['total_sah']
        for paslon in p['paslon']:
            rows.append((1, prov_code, prov_name, '00', prov_sah, paslon['no_urut'], paslon['suara'], paslon['persentase']))

    # 3. Kabupaten (tingkat = 2)
    prov_files = glob.glob(os.path.join(base, 'provinsi/*/kabupaten.json.gz'))
    for pf in prov_files:
        prov_code = os.path.basename(os.path.dirname(pf))
        with gzip.open(pf, 'rt') as f:
            kabs = json.load(f).get('data') or []
            for k in kabs:
                kab_code = k['kab_kode']
                kab_name = k['kab_nama']
                kab_sah = k['total_sah']
                for paslon in k['paslon']:
                    rows.append((2, kab_code, kab_name, prov_code, kab_sah, paslon['no_urut'], paslon['suara'], paslon['persentase']))

    # 4. Kecamatan (tingkat = 3)
    kab_dirs = glob.glob(os.path.join(base, 'kabupaten/*'))
    for kd in kab_dirs:
        kab_code = os.path.basename(kd)
        kf = os.path.join(kd, 'kecamatan.json.gz')
        if not os.path.exists(kf):
            continue
        with gzip.open(kf, 'rt') as f:
            kecs = json.load(f).get('data') or []
            for kec in kecs:
                kec_code = kec['kec_kode']
                kec_name = kec['kec_nama']
                kec_sah = kec['total_sah']
                for paslon in kec['paslon']:
                    rows.append((3, kec_code, kec_name, kab_code, kec_sah, paslon['no_urut'], paslon['suara'], paslon['persentase']))

    # 5. Kelurahan (tingkat = 4)
    kec_dirs = glob.glob(os.path.join(base, 'kecamatan/*'))
    print(f'Loading kelurahan from {len(kec_dirs)} kecamatan...')
    for i, kd in enumerate(kec_dirs):
        kec_code = os.path.basename(kd)
        kf = os.path.join(kd, 'kelurahan.json.gz')
        if not os.path.exists(kf):
            continue
        with gzip.open(kf, 'rt') as f:
            kels = json.load(f).get('data') or []
            for kel in kels:
                kel_code = kel['kel_kode']
                kel_name = kel['kel_nama']
                kel_sah = kel['total_sah']
                for paslon in kel['paslon']:
                    rows.append((4, kel_code, kel_name, kec_code, kel_sah, paslon['no_urut'], paslon['suara'], paslon['persentase']))
        if (i + 1) % 2000 == 0:
            print(f'  ... {i + 1} / {len(kec_dirs)} kecamatan processed')

    print(f'Total 2024 suara_pilpres rows: {len(rows)}')
    return rows


def process_2019(kab_2024_map):
    print('Processing 2019 Pilpres...')
    base = os.path.join(KUPAS_DIR, 'data/pemilu/2019/pilpres')
    rows = []

    # 1. Nasional (tingkat = 0)
    with gzip.open(os.path.join(base, 'nasional.json.gz'), 'rt') as f:
        nas_data = json.load(f)['data']

    total_sah_nas = nas_data['total_suara_sah']
    for p in nas_data['paslon']:
        rows.append((0, '00', 'INDONESIA', None, total_sah_nas, p['no_urut'], p['suara'], p['persentase']))

    # 2. Provinsi (tingkat = 1)
    prov_map = {}
    for p in nas_data['provinsi']:
        prov_map[p['pro_id']] = (p['kode'], p['pro_name'])
        prov_code = p['kode']
        prov_name = p['pro_name']
        prov_sah = p['total_sah']
        for paslon in p['paslon']:
            rows.append((1, prov_code, prov_name, '00', prov_sah, paslon['no_urut'], paslon['suara'], paslon['persentase']))

    # 3. Kabupaten (tingkat = 2)
    prov_files = glob.glob(os.path.join(base, 'provinsi/*/kabupaten.json.gz'))
    for pf in prov_files:
        pro_id = int(os.path.basename(os.path.dirname(pf)))
        prov_code, prov_name = prov_map[pro_id]
        with gzip.open(pf, 'rt') as f:
            kabs = json.load(f).get('data') or []
            for k in kabs:
                raw_name = k['kab_nama'].upper().strip()
                norm = ALIASES_2019_KAB.get(raw_name, raw_name).rstrip('.')
                if norm in ALIASES_2019_KAB:
                    kab_code = ALIASES_2019_KAB[norm]
                elif raw_name in ALIASES_2019_KAB:
                    kab_code = ALIASES_2019_KAB[raw_name]
                else:
                    kab_code = kab_2024_map.get(raw_name) or kab_2024_map.get(norm)
                    if not kab_code:
                        clean_norm = re.sub(r'[^A-Z]', '', norm)
                        for name_24, c_24 in kab_2024_map.items():
                            if re.sub(r'[^A-Z]', '', name_24) == clean_norm:
                                kab_code = c_24
                                break

                if not kab_code:
                    kab_code = str(k['kab_id'])

                kab_sah = k['total_sah']
                for paslon in k['paslon']:
                    rows.append((2, kab_code, k['kab_nama'], prov_code, kab_sah, paslon['no_urut'], paslon['suara'], paslon['persentase']))

    print(f'Total 2019 suara_pilpres rows: {len(rows)}')
    return rows


def main():
    # 1. Process 2024
    rows_2024 = process_2024()

    # Build kab_2024 map for 2019 matcher
    kab_2024_map = {}
    for r in rows_2024:
        if r[0] == 2:  # tingkat kabupaten
            kab_2024_map[r[2].upper().strip()] = r[1]  # nama -> kode

    # 2. Process 2019
    rows_2019 = process_2019(kab_2024_map)

    # 3. Load into SQLite databases directly
    db_2024_file = find_db_file(258101)
    db_2019_file = find_db_file(243336)
    print(f'Loading 2024 into {db_2024_file}...')

    conn_2024 = sqlite3.connect(db_2024_file)
    cur_2024 = conn_2024.cursor()
    cur_2024.execute('DELETE FROM paslon')
    cur_2024.executemany('INSERT INTO paslon VALUES (?, ?, ?, ?, ?, ?, ?, ?)', PASLON_2024)
    cur_2024.execute('DELETE FROM suara_pilpres')
    cur_2024.executemany('INSERT INTO suara_pilpres VALUES (?, ?, ?, ?, ?, ?, ?, ?)', rows_2024)
    conn_2024.commit()
    conn_2024.close()
    print('2024 database load complete!')

    print(f'Loading 2019 into {db_2019_file}...')
    conn_2019 = sqlite3.connect(db_2019_file)
    cur_2019 = conn_2019.cursor()
    cur_2019.execute('DELETE FROM paslon')
    cur_2019.executemany('INSERT INTO paslon VALUES (?, ?, ?, ?, ?, ?, ?, ?)', PASLON_2019)
    cur_2019.execute('DELETE FROM suara_pilpres')
    cur_2019.executemany('INSERT INTO suara_pilpres VALUES (?, ?, ?, ?, ?, ?, ?, ?)', rows_2019)
    conn_2019.commit()
    conn_2019.close()
    print('2019 database load complete!')


if __name__ == '__main__':
    main()
