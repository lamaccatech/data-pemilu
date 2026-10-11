# data-pemilu

A small read-only HTTP API that serves Indonesian legislative election results (2024, with 2019 as a
reference) from Cloudflare D1 through one Cloudflare Worker. Several applications call it, each owned by a
different party, so nothing here assumes a particular party: every endpoint takes the party as a parameter.

- One D1 database per election: `pemilu2024` (binding `DB_2024`) and `pemilu2019` (binding `DB_2019`).
- Calculations (Sainte-Laguë seats, targets, `kuadran`, `peluang_dekat`) run in the Worker at request time.
  Nothing derived is stored. `src/calc/` is a port of `reference/reference_calc.py` and must reproduce
  `reference/fixtures.json`.
- Election data is never committed. It is read from `~/data/bedah-dapil/export/` (override with
  `PEMILU_EXPORT_DIR`), and generated SQL goes to `data/`, which git ignores.

## Run it locally

Requirements: Node 22 or newer and pnpm.

```sh
pnpm install
pnpm build-sql      # CSV -> data/sql/<database>/<table>-NNNN.sql, about 50 s
pnpm load-local     # migrations and SQL files into the local D1, about 90 s
pnpm verify         # row counts, threshold lists, the ACEH I example, database sizes
echo 'API_KEYS={"kunci-lokal":"lokal"}' > .dev.vars
pnpm dev
curl -H 'Authorization: Bearer kunci-lokal' 'http://localhost:8787/v1/2024/dpr_ri/dapil/1101?partai=pan'
```

`build-sql` fails if a file's row count differs from the expected count in `scripts/tables.ts`. Its output is
identical for identical input, and every table starts with `DELETE FROM`, so a load can be repeated.

## Checks

```sh
pnpm test           # Vitest, two projects (below)
pnpm check          # Biome lint and format
pnpm typecheck
```

- `worker` runs inside the Workers runtime against an in-memory D1 seeded from `reference/fixtures.json`:
  the calculation library, authentication, validation, caching and response shapes.
- `data` runs the same app against the local D1 filled by `pnpm load-local`: the fixtures over HTTP, the
  kuadran counts, the kelurahan sums and the query plans. It is skipped, with a warning, when the local D1 is
  empty. Add `--reporter=verbose --silent=false` to see the query plans it prints.

## API

Base path `/v1`. The election is in the path: `/v1/2024/...` or `/v1/2019/...`. On the hostnames
`pemilu2024.*` and `pemilu2019.*` the year may be left out (`/v1/partai`), and the hostname supplies it.

Every request needs `Authorization: Bearer <key>`. The key says which application is calling; it does not
limit which party can be asked about. `GET /healthz` is open.

Success: `{ "data": ..., "meta": { ... } }` with `Cache-Control: private, max-age=86400`.
Failure: `{ "error": { "code": "...", "message": "..." } }`, message in Indonesian.

`:tingkat` is `dpr_ri`, `dprd_provinsi` or `dprd_kabupaten_kota`. Parties are always named by `kode_partai`
(`pan`, `pkb`, ...), never by ballot number, because ballot numbers change between elections. Codes are
returned as strings.

| # | Endpoint | Returns |
| --- | --- | --- |
| 1 | `GET /v1/:pemilu/partai` | Parties of the election, with ballot number and whether they pass the 4% threshold |
| 2 | `GET /v1/:pemilu/:tingkat/dapil?partai=&provinsi=&kabupaten=` | One row per dapil for the focus party; `meta` carries the kuadran counts. Region filters are 2024 only |
| 3 | `GET /v1/:pemilu/:tingkat/dapil/:kode_dapil?partai=` | The same row plus every party's votes and seats and the quotient table up to the first seat lost |
| 4 | `GET /v1/:pemilu/:tingkat/dapil/:kode_dapil/caleg?partai=` | Candidates (all parties without `partai`) and `tokoh_menonjol` |
| 5 | `GET /v1/2024/:tingkat/dapil/:kode_dapil/kecamatan?partai=` | Party votes per kecamatan, summed from kelurahan |
| 6 | `GET /v1/2024/:tingkat/dapil/:kode_dapil/kelurahan?partai=&kecamatan=` | Per kelurahan: focus party, total, share, leading party, DPT. `kecamatan` is required |
| 7 | `GET /v1/2024/:tingkat/dapil/:kode_dapil/kelurahan/:kode_kelurahan/caleg?partai=` | Candidate votes in a kelurahan. `dprd_provinsi`: 404 `tidak-tersedia` |
| 8 | `GET /v1/2024/dprd_provinsi/dapil/:kode_dapil/kecamatan/:kode_kecamatan/caleg?partai=` | Candidate votes in a kecamatan |
| 9 | `GET /v1/2024/:tingkat/dapil/:kode_dapil/padanan?partai=` | The matching 2019 dapil and, when comparable, the 2019 figures for the same party |
| 10 | `GET /v1/2024/dapil-alias` | Applications' own dapil names mapped to `kode_dapil` |

Error codes: `tidak-berwenang` (401), `parameter-tidak-valid` (400, also for unknown query parameters),
`pemilu-tidak-ditemukan`, `partai-tidak-ditemukan`, `dapil-tidak-ditemukan`, `kecamatan-tidak-ditemukan`,
`kelurahan-tidak-ditemukan`, `tidak-tersedia`, `tidak-ditemukan` (all 404), `data-belum-dimuat` (503).

### Classification

- `kuadran`: the margin is the party's votes minus the votes it needed for the seats it holds, divided by its
  votes. `aman` 10% or more, `waspada` 5% to under 10%, `rawan` under 5%, `kosong` when it holds no seat or
  (for `dpr_ri`) is under the national threshold.
- `peluang_dekat`: `kekurangan_kursi_berikutnya` is less than half of `harga_kursi_terakhir`. Always false
  for a party under the national threshold, which cannot win a `dpr_ri` seat whatever it gains in one dapil.

### Gaps the API reports

Missing data is reported, never filled in.

- A dapil without party votes has `data_lengkap: false` and null calculated fields, `kuadran` included.
  That is 145 `dprd_kabupaten_kota` dapil in 2024 and 27 in 2019. Endpoint 2 counts them in
  `meta.dapil_tanpa_data`.
- Kelurahan data is incomplete. Endpoint 5 lists kecamatan without rows as `data_tersedia: false` and puts
  the sum over kelurahan next to the dapil figure in `meta` (`suara_partai_dari_kelurahan`,
  `suara_partai_dapil`, `selisih`). Endpoint 6 lists kelurahan that are on the voter roll but have no votes.
- The 2019 results carry no province or kabupaten codes, so the region filters of endpoint 2 answer 404
  `tidak-tersedia` for 2019.

### Known problems in the source data

Served as they are; fix them in the export, not here.

- **Kelurahan candidate votes are inflated in places.** In 17 `dpr_ri` and 49 `dprd_kabupaten_kota` dapil the
  candidate votes summed over kelurahan exceed the dapil-level candidate total. ACEH I sums to 1.83 times
  its total (close to double in every kabupaten), KOTA KENDARI 1 to 72 times. Treat endpoint 7 with care
  until the export is corrected.
- `kelurahan_suara_caleg_2024.csv` has 2,058 rows (kabupaten 9110) whose `kode_dapil` is `#N/A`. `build-sql`
  restores it from the kecamatan of the kelurahan, which names exactly one dapil (9101), and prints the count.
- `nama_kabupaten` is empty for every 2024 `dprd_kabupaten_kota` dapil.
- Overseas polling places of DKI JAKARTA II have kecamatan codes with letters (`99AA01`), which is why
  `dapil_kecamatan.kode_kecamatan` is text. They have no kelurahan data.
- 24 kecamatan are split between two `dprd_kabupaten_kota` dapil. Endpoint 6 names the other dapil in
  `meta.dapil_lain` and leaves out kelurahan that have votes there.

## Deployment

Nothing below has been run. The project is built and tested against local D1 only.

### What a full load costs

D1 bills rows written, index entries included, and stored size. From `pnpm verify`:

| Database | Rows | Rows written (with index entries) | Local SQLite size |
| --- | --- | --- | --- |
| `pemilu2024` | 11,874,387 | 12,154,429 | 286 MB |
| `pemilu2019` | 286,769 | 530,105 | 16 MB |
| Total | 12,161,156 | 12,684,534 | 302 MB |

A repeated load writes the same again, plus one row written per row deleted by the leading `DELETE FROM`.
Check these against the current D1 limits before loading: the free plan allowed 100,000 rows written per day
and 500 MB per database when this was written, so the load needs the Workers Paid plan. The listing of all
2,325 `dprd_kabupaten_kota` dapil also takes more CPU time than the free plan's 10 ms.

### Steps

```sh
# 1. Create the databases, then put the two database_id values into wrangler.jsonc.
pnpm exec wrangler d1 create pemilu2024
pnpm exec wrangler d1 create pemilu2019

# 2. Create the tables.
pnpm exec wrangler d1 migrations apply pemilu2024 --remote
pnpm exec wrangler d1 migrations apply pemilu2019 --remote

# 3. Load the data, in file order (16 files for 2024, 4 for 2019). Run `pnpm build-sql` first.
for file in data/sql/pemilu2019/*.sql; do
    pnpm exec wrangler d1 execute pemilu2019 --remote --yes --file "$file" || break
done
for file in data/sql/pemilu2024/*.sql; do
    pnpm exec wrangler d1 execute pemilu2024 --remote --yes --file "$file" || break
done

# 4. Check the counts against the table above, for example:
pnpm exec wrangler d1 execute pemilu2024 --remote --command 'SELECT COUNT(*) FROM kelurahan_suara_caleg'

# 5. API keys: a JSON object mapping key to client label, for example {"<random key>":"pan"}.
pnpm exec wrangler secret put API_KEYS

# 6. Deploy.
pnpm exec wrangler deploy
```

If a file fails part-way, run that table's files again from `-0001`, which begins with the `DELETE`.

Each statement stays under 90 KB and 10,000 values: D1 answers `SQLITE_NOMEM` to a single `INSERT` with
about 19,000 values, long before the 100 KB statement limit.

### Custom domains

Both hostnames point at this one Worker. Add to `wrangler.jsonc` and deploy again:

```jsonc
"routes": [
    { "pattern": "pemilu2024.lamaccaservices.com", "custom_domain": true },
    { "pattern": "pemilu2019.lamaccaservices.com", "custom_domain": true }
]
```

The year in the path always wins, so `https://pemilu2019.lamaccaservices.com/v1/2024/partai` is 2024. The
Cache API only works on a custom domain; on `*.workers.dev` every request is computed again.

## Later

Boundary files (`~/data/bedah-dapil/geo/`) are out of scope. Proposal: put them in an R2 bucket bound to this
Worker and serve them from a route such as `/v1/2024/batas/:tingkat/:kode_dapil` behind the same key check,
streaming the object with a long cache lifetime. Nothing for this is built.
