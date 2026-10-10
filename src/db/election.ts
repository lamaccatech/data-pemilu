import { partiesPassingThreshold } from '../calc';
import type { Env } from '../env';
import { ApiError, notFound } from '../errors';
import { type Pemilu, TINGKAT, type Tingkat } from '../tingkat';

export interface Party {
    /** The ballot number in this election. It changes between elections; `kode_partai` does not. */
    partai_id: number;
    kode_partai: string;
    nama_partai: string;
}

/** What is fixed for one election: its parties and the national threshold result. */
export interface Election {
    pemilu: Pemilu;
    parties: Party[];
    partyByCode: ReadonlyMap<string, Party>;
    partyById: ReadonlyMap<number, Party>;
    /** Ballot numbers of the parties passing the national threshold, ascending. Applies to dpr_ri only. */
    passingThreshold: number[];
}

export function database(env: Env, pemilu: Pemilu): D1Database {
    return pemilu === '2024' ? env.DB_2024 : env.DB_2019;
}

// The data never changes, so each isolate reads the parties and the national totals once per election.
const elections = new Map<Pemilu, Promise<Election>>();

async function readElection(db: D1Database, pemilu: Pemilu): Promise<Election> {
    const [partyRows, nationalRows] = await db.batch<Record<string, unknown>>([
        db.prepare('SELECT partai_id, kode_partai, nama_partai FROM partai ORDER BY partai_id'),
        db
            .prepare('SELECT partai_id, SUM(suara) AS suara FROM suara_partai WHERE tingkat = ? GROUP BY partai_id')
            .bind(TINGKAT.dpr_ri),
    ]);
    const parties = (partyRows?.results ?? []) as unknown as Party[];
    if (parties.length === 0) {
        throw new ApiError(503, 'data-belum-dimuat', `Data Pemilu ${pemilu} belum dimuat ke basis data.`);
    }
    const national = new Map<number, number>();
    for (const row of (nationalRows?.results ?? []) as unknown as { partai_id: number; suara: number }[]) {
        national.set(row.partai_id, row.suara);
    }
    return {
        pemilu,
        parties,
        partyByCode: new Map(parties.map((party) => [party.kode_partai, party])),
        partyById: new Map(parties.map((party) => [party.partai_id, party])),
        passingThreshold: partiesPassingThreshold(national),
    };
}

export function loadElection(env: Env, pemilu: Pemilu): Promise<Election> {
    let election = elections.get(pemilu);
    if (election === undefined) {
        election = readElection(database(env, pemilu), pemilu);
        elections.set(pemilu, election);
        // A failed read must not be remembered.
        election.catch(() => elections.delete(pemilu));
    }
    return election;
}

/** Forget what was read. For tests that change the database. */
export function resetElections(): void {
    elections.clear();
}

/** The parties that take part in the seat allocation, or null where the level has no threshold. */
export function eligibleParties(election: Election, tingkat: Tingkat): ReadonlySet<number> | null {
    return tingkat === 'dpr_ri' ? new Set(election.passingThreshold) : null;
}

export function requireParty(election: Election, kodePartai: string): Party {
    const party = election.partyByCode.get(kodePartai);
    if (party === undefined) {
        throw notFound(
            'partai-tidak-ditemukan',
            `Partai "${kodePartai}" tidak ditemukan pada Pemilu ${election.pemilu}.`,
        );
    }
    return party;
}

export function partyCode(election: Election, partyId: number): string {
    // Every partai_id in the vote and candidate tables is in `partai`; a missing one is a broken import.
    const party = election.partyById.get(partyId);
    if (party === undefined) {
        throw new Error(`partai_id ${partyId} is not in the partai table of ${election.pemilu}`);
    }
    return party.kode_partai;
}
