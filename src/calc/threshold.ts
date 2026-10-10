import type { VotesByParty } from './sainte-lague';

export const NATIONAL_THRESHOLD = 0.04;

/** Ballot numbers of the parties at or above the national threshold, ascending. Applies to `dpr_ri` only. */
export function partiesPassingThreshold(nationalVotes: VotesByParty): number[] {
    let total = 0;
    for (const votes of nationalVotes.values()) {
        total += votes;
    }
    const passing: number[] = [];
    for (const [partyId, votes] of nationalVotes) {
        if (votes / total >= NATIONAL_THRESHOLD) {
            passing.push(partyId);
        }
    }
    return passing.sort((a, b) => a - b);
}
