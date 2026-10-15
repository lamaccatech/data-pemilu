#!/usr/bin/env python3
"""Build the supplementary DPRD provinsi candidate votes per kecamatan.

Reads the second crawl, under SOURCE_DIR:
  - dapil/2024/dprd_prov/limit=*.json.gz (dapil id -> KPU dapil code)
  - hasil/caleg/2024/dprd_prov/limit=100&offset=*&wilayah_id=*.json.gz

Writes:
  - data/sql/pemilu2024/kecamatan_suara_caleg_pelengkap-0001.sql, listed in data/sql/manifest.json
  - the local 2024 D1 database, when one exists (migration 0005 must be applied there)

The second crawl numbers the local Aceh parties differently from the ids the database uses; they are
translated below. Overseas kecamatan have no numeric code and are left out.
"""
import glob
import gzip
import json
import os
import sqlite3

SOURCE_DIR = os.path.expanduser('~/data/bedahsuara/data')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL_DIR = os.path.join(ROOT, 'data/sql')
TABLE = 'kecamatan_suara_caleg_pelengkap'
COLUMNS = ['kode_dapil', 'kode_kecamatan', 'partai_id', 'nomor_urut', 'suara']
# Source party id -> database party id, where they differ (ids 1 to 17, 21 and 23 are the same).
PARTY = {18: 24, 22: 18, 24: 20, 25: 19, 26: 22}
MAX_TUPLES = 2000


def load(path):
    with gzip.open(path) as f:
        return json.load(f)


def dapil_codes():
    codes = {}
    for path in glob.glob(os.path.join(SOURCE_DIR, 'dapil/2024/dprd_prov/limit=*.json.gz')):
        for row in load(path)['data']:
            if str(row['kode']).isdigit():
                codes[row['id']] = int(row['kode'])
    return codes


def collect():
    codes = dapil_codes()
    votes = {}
    pattern = os.path.join(SOURCE_DIR, 'hasil/caleg/2024/dprd_prov/limit=100&offset=*&wilayah_id=*.json.gz')
    for path in sorted(glob.glob(pattern)):
        data = load(path)
        unit = data['unit']
        if not data.get('tersedia') or unit['tingkat'] != 'kecamatan' or not str(unit['kode']).isdigit():
            continue
        for group in data.get('grup') or []:
            kode = codes.get((group.get('dapil') or {}).get('id'))
            if kode is None:
                continue
            for row in group['data']:
                if row['suara'] <= 0 or row['partai_id'] is None:
                    continue
                key = (kode, int(unit['kode']), PARTY.get(row['partai_id'], row['partai_id']), row['nomor_urut'])
                votes[key] = max(votes.get(key, 0), row['suara'])
    return sorted(key + (suara,) for key, suara in votes.items())


def write(rows):
    folder = os.path.join(SQL_DIR, 'pemilu2024')
    os.makedirs(folder, exist_ok=True)
    name = f'{TABLE}-0001.sql'
    with open(os.path.join(folder, name), 'w') as out:
        out.write(f'DELETE FROM {TABLE};\n')
        for i in range(0, len(rows), MAX_TUPLES):
            values = ',\n'.join('(' + ','.join(str(v) for v in row) + ')' for row in rows[i:i + MAX_TUPLES])
            out.write(f'INSERT INTO {TABLE} ({",".join(COLUMNS)}) VALUES\n{values};\n')
    return f'pemilu2024/{name}'


def register(name, count):
    path = os.path.join(SQL_DIR, 'manifest.json')
    if not os.path.exists(path):
        return
    with open(path) as f:
        manifest = json.load(f)
    if name not in manifest['files']['pemilu2024']:
        manifest['files']['pemilu2024'].append(name)
    manifest['rows']['pemilu2024'][TABLE] = count
    with open(path, 'w') as f:
        json.dump(manifest, f, indent=4)
        f.write('\n')


def load_local(rows):
    pattern = os.path.join(ROOT, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite')
    for path in glob.glob(pattern):
        conn = sqlite3.connect(path)
        try:
            if conn.execute('SELECT count(*) FROM sqlite_master WHERE name = ?', (TABLE,)).fetchone()[0] == 0:
                continue  # the 2019 database, or the miniflare metadata
            conn.execute(f'DELETE FROM {TABLE}')
            conn.executemany(f'INSERT INTO {TABLE} ({",".join(COLUMNS)}) VALUES (?,?,?,?,?)', rows)
            conn.commit()
            print(f'loaded into {os.path.basename(path)}')
        finally:
            conn.close()


def main():
    rows = collect()
    register(write(rows), len(rows))
    print(f'{TABLE}: {len(rows)} rows')
    load_local(rows)


if __name__ == '__main__':
    main()
