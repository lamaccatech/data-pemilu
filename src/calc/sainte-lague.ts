/** Votes per party, keyed by `partai_id` (the ballot number). */
export type VotesByParty = ReadonlyMap<number, number>;

export interface Quotient {
    partai_id: number;
    suara: number;
    pembagi: number;
    hasil_bagi: number;
}

/**
 * Every Sainte-Laguë quotient (divisors 1, 3, 5, ...) for `seats` seats, highest first.
 *
 * Ties are broken by more party votes, then by lower partai_id.
 */
export function rankQuotients(votesByParty: VotesByParty, seats: number): Quotient[] {
    const quotients: Quotient[] = [];
    for (const [partyId, votes] of votesByParty) {
        if (votes <= 0) {
            continue;
        }
        for (let index = 0; index < seats; index++) {
            const divisor = 2 * index + 1;
            quotients.push({ partai_id: partyId, suara: votes, pembagi: divisor, hasil_bagi: votes / divisor });
        }
    }
    quotients.sort((a, b) => b.hasil_bagi - a.hasil_bagi || b.suara - a.suara || a.partai_id - b.partai_id);
    return quotients;
}

/** Sainte-Laguë with divisors 1, 3, 5, ... Returns seats per party and the winning quotients, highest first. */
export function allocateSeats(
    votesByParty: VotesByParty,
    seats: number,
): { seatsByParty: Map<number, number>; winning: number[] } {
    const winners = rankQuotients(votesByParty, seats).slice(0, Math.max(seats, 0));
    const seatsByParty = new Map<number, number>();
    for (const { partai_id } of winners) {
        seatsByParty.set(partai_id, (seatsByParty.get(partai_id) ?? 0) + 1);
    }
    return { seatsByParty, winning: winners.map((entry) => entry.hasil_bagi) };
}

/** Smallest party total that wins `wantedSeats` seats, all other parties unchanged. Null if impossible. */
export function votesNeededForSeats(
    votesByParty: VotesByParty,
    seats: number,
    partyId: number,
    wantedSeats: number,
): number | null {
    if (wantedSeats < 1 || wantedSeats > seats) {
        return null;
    }
    const otherQuotients: number[] = [];
    for (const [otherId, votes] of votesByParty) {
        if (otherId === partyId || votes <= 0) {
            continue;
        }
        for (let index = 0; index < seats; index++) {
            otherQuotients.push(votes / (2 * index + 1));
        }
    }
    otherQuotients.sort((a, b) => b - a);
    // The party's n-th quotient must beat the (seats - n + 1)-th best quotient of everyone else.
    const position = seats - wantedSeats;
    const rival = otherQuotients[position];
    if (rival === undefined) {
        return 1;
    }
    return Math.floor(rival * (2 * wantedSeats - 1)) + 1;
}
