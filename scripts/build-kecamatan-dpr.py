#!/usr/bin/env python3
"""Build the DPR RI candidate votes per kecamatan from the kupasdapil crawl.

Party votes per kecamatan are not loaded: party votes stay at kelurahan level.

Reads:
  - ~/data/kupasdapil/data/pemilu/2024/dpr/dapil.json.gz
  - ~/data/kupasdapil/data/pemilu/2024/dpr/dapil/<id>/caleg-kecamatan.json.gz

Writes:
  - data/sql/pemilu2024/kecamatan_suara_caleg_dpr_ri-0001.sql, listed in data/sql/manifest.json
  - the local 2024 D1 database, when one exists (migration 0003 must be applied there)

Overseas kecamatan have no numeric code and are left out.
"""
import glob
import gzip
import json
import os
import sqlite3

KUPAS = os.path.expanduser('~/data/kupasdapil/data/pemilu/2024/dpr')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL_DIR = os.path.join(ROOT, 'data/sql')
MAX_TUPLES = 2000  # 5 columns: stays far below D1's limit on values per statement


def load(path):
    with gzip.open(path) as f:
        data = json.load(f)
    return data['data'] if isinstance(data, dict) else data


def collect():
    caleg = []
    for dapil in load(os.path.join(KUPAS, 'dapil.json.gz')):
        kode, folder = dapil['dapil_dpr_ri_kode'], os.path.join(KUPAS, 'dapil', str(dapil['id']))
        for row in load(os.path.join(folder, 'caleg-kecamatan.json.gz')):
            if str(row['wilayah_kode']).isdigit() and row['total_suara'] > 0:
                caleg.append((kode, int(row['wilayah_kode']), row['partai_id'], row['nomor_urut'], row['total_suara']))
    return caleg


def dedupe(rows, width):
    best = {}
    for row in rows:
        best[row[:width]] = max(best.get(row[:width], 0), row[width])
    return sorted(key + (votes,) for key, votes in best.items())


def write(table, columns, rows):
    folder = os.path.join(SQL_DIR, 'pemilu2024')
    os.makedirs(folder, exist_ok=True)
    name = f'{table}-0001.sql'
    with open(os.path.join(folder, name), 'w') as out:
        out.write(f'DELETE FROM {table};\n')
        for i in range(0, len(rows), MAX_TUPLES):
            values = ',\n'.join('(' + ','.join(str(v) for v in row) + ')' for row in rows[i:i + MAX_TUPLES])
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
            if conn.execute("SELECT count(*) FROM sqlite_master WHERE name = 'kecamatan_suara_caleg_dpr_ri'").fetchone()[0] == 0:
                continue  # the 2019 database, or the miniflare metadata
            for table, columns, rows in tables:
                conn.execute(f'DELETE FROM {table}')
                marks = ','.join('?' * len(columns))
                conn.executemany(f'INSERT INTO {table} ({",".join(columns)}) VALUES ({marks})', rows)
            conn.commit()
            print(f'loaded into {os.path.basename(path)}')
        except sqlite3.Error as error:
            print(f'skipped {os.path.basename(path)}: {error}')
        finally:
            conn.close()


def main():
    caleg = dedupe(collect(), 4)
    tables = [
        ('kecamatan_suara_caleg_dpr_ri', ['kode_dapil', 'kode_kecamatan', 'partai_id', 'nomor_urut', 'suara'], caleg),
    ]
    files = [write(table, columns, rows) for table, columns, rows in tables]
    register(files, {table: len(rows) for table, _, rows in tables})
    for table, _, rows in tables:
        print(f'{table}: {len(rows)} rows')
    load_local(tables)


if __name__ == '__main__':
    main()
