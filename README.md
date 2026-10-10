# data-pemilu

A small read-only HTTP API that serves Indonesian legislative election results (2024, with 2019 as a
reference) from Cloudflare D1 through one Cloudflare Worker. Several applications call it, each owned by a
different party, so nothing here assumes a particular party: every endpoint takes the party as a parameter.

## Run it locally

Requirements: Node 22 or newer, pnpm, and the export files in `~/data/bedah-dapil/export/`. Election data is
never committed; generated SQL goes to `data/`, which git ignores.

```sh
pnpm install
pnpm build-sql      # CSV -> data/sql/<database>/<table>-NNNN.sql
pnpm load-local     # apply migrations and SQL files to the local D1
pnpm verify         # check row counts and the ACEH I example
echo 'API_KEYS={"kunci-lokal":"lokal"}' > .dev.vars
pnpm dev
curl -H 'Authorization: Bearer kunci-lokal' 'http://localhost:8787/v1/2024/dpr_ri/dapil/1101?partai=pan'
```

## Checks

```sh
pnpm test           # Vitest: Workers runtime tests, plus tests against the loaded local D1
pnpm check          # Biome lint and format
pnpm typecheck
```
