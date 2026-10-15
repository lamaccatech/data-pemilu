#!/usr/bin/env python3
"""Build the candidate and party votes per kabupaten of a dapil from the kupasdapil crawl.

Reads, for dpr (tingkat 1) and dprd-provinsi (tingkat 2):
  - ~/data/kupasdapil/data/pemilu/2024/<level>/dapil.json.gz or dapil/<id>.json.gz (the dapil code)
  - ~/data/kupasdapil/data/pemilu/2024/<level>/dapil/<id>/caleg-kabupaten.json.gz
  - ~/data/kupasdapil/data/pemilu/2024/<level>/dapil/<id>/kabupaten.json.gz

Writes:
  - data/sql/pemilu2024/kabupaten_suara_{caleg,partai}-0001.sql, listed in data/sql/manifest.json
  - the local 2024 D1 database, when one exists (migration 0004 must be applied there)
"""
import glob
import gzip
import json
import os
import sqlite3

BASE = os.path.expanduser('~/data/kupasdapil/data/pemilu/2024')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL_DIR = os.path.join(ROOT, 'data/sql')
LEVELS = [('dpr', 1), ('dprd-provinsi', 2)]
MAX_TUPLES = 1500
CALEG_COLUMNS = ['tingkat', 'kode_dapil', 'kode_kabupaten', 'partai_id', 'nomor_urut', 'suara']
PARTAI_COLUMNS = ['tingkat', 'kode_dapil', 'kode_kabupaten', 'nama_kabupaten', 'partai_id', 'suara']


def load(path):
    with gzip.open(path) as f:
        data = json.load(f)
    return data['data'] if isinstance(data, dict) and 'data' in data else data


def dapil_code(level, folder_id):
    data = load(os.path.join(BASE, level, 'dapil', f'{folder_id}.json.gz'))
    return data['dapil']['dapil_dpr_ri_kode']


def collect():
    caleg, partai = {}, {}
    for level, tingkat in LEVELS:
        for folder in sorted(glob.glob(os.path.join(BASE, level, 'dapil', '*/'))):
            folder_id = os.path.basename(os.path.dirname(folder))
            kode = dapil_code(level, folder_id)
            for row in load(os.path.join(folder, 'caleg-kabupaten.json.gz')):
                if row['total_suara'] > 0:
                    key = (tingkat, kode, str(row['wilayah_kode']), row['partai_id'], row['nomor_urut'])
                    caleg[key] = max(caleg.get(key, 0), row['total_suara'])
            for row in load(os.path.join(folder, 'kabupaten.json.gz')):
                for party in row['partai']:
                    if party['total_suara'] > 0:
                        key = (tingkat, kode, str(row['wilayah_kode']), row['wilayah_nama'], party['partai_id'])
                        partai[key] = max(partai.get(key, 0), party['total_suara'])
    return (
        sorted(key + (votes,) for key, votes in caleg.items()),
        sorted(key + (votes,) for key, votes in partai.items()),
    )


def literal(value):
    return "'" + value.replace("'", "''") + "'" if isinstance(value, str) else str(value)


def write(table, columns, rows):
    folder = os.path.join(SQL_DIR, 'pemilu2024')
    os.makedirs(folder, exist_ok=True)
    name = f'{table}-0001.sql'
    with open(os.path.join(folder, name), 'w') as out:
        out.write(f'DELETE FROM {table};\n')
        for i in range(0, len(rows), MAX_TUPLES):
            values = ',\n'.join('(' + ','.join(literal(v) for v in row) + ')' for row in rows[i:i + MAX_TUPLES])
            out.write(f'INSERT INTO {table} ({",".join(columns)}) VALUES\n{values};\n')
    return f'pemilu2024/{name}'


def register(files, counts):
    path = os.path.join(SQL_DIR, 'manifest.json')
    if not os.path.exists(path):
        return
    with open(path) as f:
        manifest = json.load(f)
    listed = manifest['files']['pemilu2024']
    for name in files:
        if name not in listed:
            listed.append(name)
    manifest['rows']['pemilu2024'].update(counts)
    with open(path, 'w') as f:
        json.dump(manifest, f, indent=4)
        f.write('\n')


def load_local(tables):
    pattern = os.path.join(ROOT, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite')
    for path in glob.glob(pattern):
        conn = sqlite3.connect(path)
        try:
            if conn.execute("SELECT count(*) FROM sqlite_master WHERE name = 'kabupaten_suara_caleg'").fetchone()[0] == 0:
                continue  # the 2019 database, or the miniflare metadata
            for table, columns, rows in tables:
                conn.execute(f'DELETE FROM {table}')
                marks = ','.join('?' * len(columns))
                conn.executemany(f'INSERT INTO {table} ({",".join(columns)}) VALUES ({marks})', rows)
            conn.commit()
            print(f'loaded into {os.path.basename(path)}')
        finally:
            conn.close()


def main():
    caleg, partai = collect()
    tables = [
        ('kabupaten_suara_caleg', CALEG_COLUMNS, caleg),
        ('kabupaten_suara_partai', PARTAI_COLUMNS, partai),
    ]
    files = [write(table, columns, rows) for table, columns, rows in tables]
    register(files, {table: len(rows) for table, _, rows in tables})
    for table, _, rows in tables:
        print(f'{table}: {len(rows)} rows')
    load_local(tables)


if __name__ == '__main__':
    main()
