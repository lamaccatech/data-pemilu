# Prompt: build the `pemilu-data` repository

Paste everything below the line into a new session started in an empty directory `~/code/pemilu-data`.

---

You are building a new repository, `pemilu-data`, in the current empty directory. It is a small read-only
HTTP API that serves Indonesian legislative election results (2024, with 2019 as a reference) from
Cloudflare D1 through one Cloudflare Worker. Several separate applications will call it; each belongs to a
different political party, so nothing in this repository may assume a particular party.

Work through the milestones in order. Finish and verify one before starting the next. Report what you
verified and what you could not.

## Hard rules

1. Never commit election data, generated SQL, or boundary files. They live outside the repository in
   `~/data/bedah-dapil/` and are read from there. Add `data/`, `*.sql.gz`, `.wrangler/` and `.dev.vars` to
   `.gitignore` in the first commit.
2. Everything is built and tested against local D1 first (`wrangler d1 ... --local`, `wrangler dev`).
   Do not create remote Cloudflare resources, deploy, add DNS routes or load remote data until I say so.
   Milestone 6 lists those commands for me to run or approve.
3. The API is read-only. No endpoint writes to the database.
4. Do not invent numbers. Every calculation must reproduce `fixtures.json` (see "Reference files").
5. Indonesian for user-facing field values and error messages, English for code, comments and commits.
6. Conventional commits (`feat:`, `fix:`, `chore:`), one commit per milestone at least.

## Stack

- TypeScript, Cloudflare Workers, Wrangler 4, Hono for routing, Zod for query validation.
- Vitest with `@cloudflare/vitest-pool-workers` for tests against a local D1.
- Biome for lint and format: 4 spaces, single quotes, 120 columns.
- Node scripts (TypeScript run with `tsx`) for the import tooling. No Python in the repository.
- pnpm.

## Input data

All in `~/data/bedah-dapil/export/`, UTF-8 CSV with a header row. Names contain commas and are quoted, so
use a real CSV parser, never `split(',')`.

| File | Rows | Columns |
| --- | --- | --- |
| `partai.csv` | 44 | `pemilu,partai_id,kode_partai,nama_partai` |
| `dapil.csv` | 5,265 | `pemilu,tingkat,kode_dapil,nama_dapil,kode_provinsi,nama_provinsi,kode_kabupaten,nama_kabupaten,jumlah_kursi,total_suara_sah` |
| `suara_partai.csv` | 87,688 | `pemilu,tingkat,kode_dapil,partai_id,suara,sumber` |
| `caleg.csv` | 501,437 | `pemilu,tingkat,kode_dapil,partai_id,nomor_urut,nama,jenis_kelamin,suara,kursi_ke` |
| `padanan_dapil.csv` | 2,182 | `tingkat,kode_dapil_2024,kode_dapil_2019,nama_dapil_2019,sebanding,ada_di_hasil_2019,ada_di_hasil_2024` |
| `dapil_kecamatan_2024.csv` | 21,941 | `tingkat,kode_dapil,kode_kecamatan,nama_kecamatan` |
| `dapil_alias_2024.csv` | 70 | `tingkat,nama_di_aplikasi,nama_dapil,kode_dapil` |
| `kelurahan_suara_partai_2024.csv` | 3,140,001 | `tingkat,kode_dapil,kode_kelurahan,partai_id,suara` |
| `kelurahan_suara_caleg_2024.csv` | 7,645,652 | `tingkat,kode_dapil,kode_kelurahan,partai_id,nomor_urut,suara` |
| `kecamatan_suara_caleg_dprd_provinsi_2024.csv` | 673,145 | `tingkat,kode_dapil,kode_kecamatan,partai_id,nomor_urut,suara` |
| `kelurahan_dpt_2024.csv` | 83,731 | `kode_kelurahan,nama_kelurahan,dpt,dpt_l,dpt_p,usia_kurang21,usia_u21_25,usia_u26_30,usia_u31_40,usia_u41_50,usia_u51_55,usia_lebih55` |

Facts you must respect:

- `tingkat` is one of `dpr_ri`, `dprd_provinsi`, `dprd_kabupaten_kota`. `pemilu` is `2019` or `2024`.
- A dapil is identified by `(pemilu, tingkat, kode_dapil)`. `kode_dapil` alone is not unique.
- `partai_id` is the ballot number in that election, so it changes between elections. `kode_partai`
  (for example `pan`, `pkb`) is the stable identity. Every public endpoint takes and returns `kode_partai`.
- A candidate is identified by `(pemilu, tingkat, kode_dapil, partai_id, nomor_urut)`. There is no
  candidate id.
- `kursi_ke` is `0` for candidates who did not win a seat, and the seat order (1, 2, ...) for those who did.
- Region codes are Kemendagri codes: province 2 digits, kabupaten 4, kecamatan 6, kelurahan 10. The first
  digits of a kelurahan code give its kecamatan, kabupaten and province.
- The kelurahan and kecamatan files exist for 2024 only. 2019 has dapil-level data only.
- Kelurahan candidate rows are present only where votes are greater than zero, and only for `dpr_ri` and
  `dprd_kabupaten_kota`. For `dprd_provinsi`, candidate votes stop at kecamatan level (the separate file).
- Known gaps, to be reported by the API and never papered over: 145 of the 2024 `dprd_kabupaten_kota` dapil
  have no dapil-level party votes, and about 14% of kelurahan have no vote data.

## Reference files

Copy these two files from `~/data/bedah-dapil/` into `reference/` in the repository (they are small and
contain no bulk data, so they are committed):

- `reference_calc.py` is the specification of every calculation. Port it to TypeScript line by line.
  Where this prompt and that file disagree, the file wins; tell me about the disagreement.
- `fixtures.json` holds expected outputs. Your tests load it and must pass for every dapil in it.

Summary of the rules in `reference_calc.py`, so you know what to expect:

- Seats are allocated per dapil with Sainte-Laguë, divisors 1, 3, 5, 7 and so on.
- For `dpr_ri` only, parties below 4% of the national valid vote get no seats. Parties that pass, by
  ballot number: 2024 `[1,2,3,4,5,8,12,14]`, 2019 `[1,2,3,4,5,8,10,12,14]`. Compute this from the data
  and assert it equals these lists. `dprd_provinsi` and `dprd_kabupaten_kota` have no threshold.
- Outputs per dapil for a focus party: `harga_kursi_terakhir`, `target_suara_kursi_pertama`,
  `selisih_kursi_pertama`, `target_suara_kursi_berikutnya`, `kekurangan_kursi_berikutnya`,
  `suara_caleg_batas`.
- Worked example, ACEH I, 2024, `dpr_ri`, 7 seats, party `pan` with 185,867 votes: those six outputs are
  119581, 106678, 79189, 358744, 172877 and 140614 in that order.

On top of the reference, add one classification per dapil for the focus party, `kuadran`:

The margin is the party's votes minus the votes it would have needed for the seats it holds, which is
`votes_needed_for_seats(counted, seats, party_id, own_seats)` in the reference, divided by the party's votes.

- `aman`: the party holds a seat and the margin is 10% or more.
- `waspada`: margin from 5% to under 10%.
- `rawan`: margin under 5%.
- `kosong`: the party holds no seat, or (for `dpr_ri`) is under the national threshold.

Also add `peluang_dekat`: true when `kekurangan_kursi_berikutnya` is less than half of
`harga_kursi_terakhir`. Check: for `pan`, 2024, `dpr_ri`, the 84 dapil must come out as 37 aman,
3 waspada, 7 rawan and 37 kosong, and 28 dapil must have `peluang_dekat` true. If your counts differ,
stop and tell me.

## Databases

One D1 database per election, bound in one Worker:

- `pemilu2024` (binding `DB_2024`): all 2024 rows, including the kelurahan and kecamatan tables.
- `pemilu2019` (binding `DB_2019`): the 2019 rows of `partai`, `dapil`, `suara_partai`, `caleg`.

`padanan_dapil` goes into `pemilu2024`. D1 cannot join across databases; when an endpoint needs both
years, run two queries and merge in the Worker.

Schema rules, because D1 bills by rows read and written and by stored size:

- Drop the `pemilu` column inside each database; the database is the election.
- Store `tingkat` as a small integer (1 `dpr_ri`, 2 `dprd_provinsi`, 3 `dprd_kabupaten_kota`) with the mapping
  in one shared constant.
- Use `WITHOUT ROWID` tables with a composite primary key that matches the main lookup, so no extra index
  is needed for it. For the kelurahan tables the primary key starts with
  `(tingkat, kode_dapil, kode_kelurahan, ...)`.
- Add a secondary index only when an endpoint below needs it, and say which endpoint in a comment.
- Migrations are plain SQL files under `migrations/2024/` and `migrations/2019/`, applied with
  `wrangler d1 migrations apply`.

## Import tooling

`scripts/build-sql.ts` reads the CSV files and writes SQL into `data/sql/<database>/<table>-NNNN.sql`
(ignored by git). Requirements:

- Stream the input; never load a whole file into memory. The largest file is 273 MB.
- Multi-row `INSERT` statements, at most 100 KB per statement, files of at most 50 MB each.
- Deterministic output for the same input, so a file can be re-applied.
- Each table's first file starts with `DELETE FROM <table>;` so an import can be repeated.
- Print a row count per table at the end and compare it with the counts in the table above. A mismatch
  is an error.

`scripts/load-local.ts` applies the migrations and every SQL file to the local D1. `scripts/verify.ts`
then queries the local D1 and checks row counts and the ACEH I example.

## API

Base path is `/v1`. The election comes from the path: `/v1/2024/...` or `/v1/2019/...`. Unknown year
returns 404.

Authentication: `Authorization: Bearer <key>`. Keys are stored as a Worker secret `API_KEYS`, a JSON
object mapping key to a client label (for example `{"abc...":"pan"}`). A missing or unknown key returns
401. The key identifies the calling application only; it does not restrict which party can be queried.

Every response is JSON: `{ "data": ..., "meta": { ... } }`. Errors are
`{ "error": { "code": "...", "message": "..." } }`. Responses carry
`Cache-Control: private, max-age=86400`, and the Worker caches successful responses with the Cache API,
keyed by the full URL, because the data never changes.

Endpoints, where `:tingkat` is `dpr_ri`, `dprd_provinsi` or `dprd_kabupaten_kota`:

1. `GET /v1/:pemilu/partai` returns the parties of that election.
2. `GET /v1/:pemilu/:tingkat/dapil?partai=<kode_partai>&provinsi=<kode>&kabupaten=<kode>` returns one row
   per dapil with seats, total votes, the six calculated outputs, `kuadran`, `peluang_dekat`, the focus
   party's votes and seats, and `data_lengkap` (false when party votes are missing). `partai` is required.
3. `GET /v1/:pemilu/:tingkat/dapil/:kode_dapil?partai=<kode_partai>` returns the same for one dapil plus
   every party's votes and seats, and the Sainte-Laguë quotient table for the last seat won and the first
   seat lost.
4. `GET /v1/:pemilu/:tingkat/dapil/:kode_dapil/caleg?partai=<kode_partai>` returns candidates with votes
   and `kursi_ke`. Without `partai`, returns all parties' candidates. The response also carries
   `tokoh_menonjol`, built exactly as in `analyse_dapil` in the reference (the strongest candidates who
   did not win a seat, with the same fields). These are the people a party may want to recruit.
5. `GET /v1/2024/:tingkat/dapil/:kode_dapil/kecamatan?partai=<kode_partai>` returns party votes per
   kecamatan in the dapil (summed from the kelurahan table), with every party's total per kecamatan.
6. `GET /v1/2024/:tingkat/dapil/:kode_dapil/kelurahan?partai=<kode_partai>&kecamatan=<kode>` returns per
   kelurahan: focus party votes, total valid votes, share, the leading party, and the DPT figures.
   `kecamatan` is required, so one request never returns a whole dapil of kelurahan.
7. `GET /v1/2024/:tingkat/dapil/:kode_dapil/kelurahan/:kode_kelurahan/caleg?partai=<kode_partai>` returns
   candidate votes in one kelurahan. For `dprd_provinsi` it returns 404 with code `tidak-tersedia` and a
   message saying candidate votes for this level stop at kecamatan.
8. `GET /v1/2024/dprd_provinsi/dapil/:kode_dapil/kecamatan/:kode_kecamatan/caleg?partai=<kode_partai>`
   returns candidate votes in one kecamatan from the separate file.
9. `GET /v1/2024/:tingkat/dapil/:kode_dapil/padanan` returns the matching 2019 dapil and, when
   `sebanding` is 1, the 2019 calculated outputs for the same `kode_partai`.
10. `GET /v1/2024/dapil-alias` returns the alias rows, so a calling application can map its own dapil
    names to `kode_dapil`.

Calculations run in the Worker at request time from `suara_partai` and `dapil`; do not store derived
values. The national threshold list per election is computed once per isolate and memoised.

Validate every path and query parameter with Zod and return 400 with code `parameter-tidak-valid` on
failure. An unknown `kode_partai` returns 404 with code `partai-tidak-ditemukan`.

## Milestones

1. **Scaffold.** `package.json`, `wrangler.jsonc` with the two D1 bindings (placeholder database ids),
   Biome, Vitest, `.gitignore`, a `README.md` that explains what the service is and how to run it
   locally. A `GET /healthz` endpoint. Verify: `pnpm test` and `pnpm biome check` pass.
2. **Calculation library.** `src/calc/` as pure functions with no I/O, ported from `reference_calc.py`,
   plus `kuadran` and `peluang_dekat`. Verify: tests pass for all 8 dapil in `fixtures.json`,
   including `tokoh_menonjol`. The fixtures were produced with `pan` as the focus party (`own_party_code`).
3. **Schema and import.** Migrations, `build-sql.ts`, `load-local.ts`, `verify.ts`. Verify: row counts
   match the table above, and `verify.ts` prints the ACEH I numbers. Report the size of the local SQLite
   file for each database, because it predicts D1 storage.
4. **Dapil endpoints** (1 to 4 and 9, 10) with authentication, validation and caching. Verify with tests
   against the local D1, including the 37/3/7/37 kuadran count and the 28 `peluang_dekat`.
5. **Kelurahan and kecamatan endpoints** (5 to 8). Verify: for ACEH I, the kelurahan party votes for
   `pan` summed over the dapil equal the dapil-level figure, or report the difference and the number of
   kelurahan without data. Print `EXPLAIN QUERY PLAN` for each query and confirm none scans a whole table.
6. **Deployment notes.** Do not run these; write them into `README.md` and stop:
   `wrangler d1 create pemilu2024`, `wrangler d1 create pemilu2019`, applying migrations with `--remote`,
   loading the SQL files with `wrangler d1 execute --remote --file`, `wrangler secret put API_KEYS`,
   `wrangler deploy`, and the custom domains `pemilu2024.lamaccaservices.com` and
   `pemilu2019.lamaccaservices.com` (both pointing at this one Worker, which also accepts the year in the
   path). Include the expected number of rows written, so I can check it against the D1 plan limits before
   loading.

## Out of scope

- Boundary files (`~/data/bedah-dapil/geo/`). Leave a short "Later" note in the README proposing an R2
  bucket served by this Worker; do not build it.
- Supporter, volunteer or witness data. Those stay in each party's own application.
- TPS-level data.
- Any write endpoint, admin screen or user accounts.

## What to tell me at the end of each milestone

What you built, the exact commands you ran to verify it and their results, anything in the data that
surprised you, and any place where you departed from this prompt and why.
