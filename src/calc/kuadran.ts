import type { OwnPartyResult } from './analyse';
import { type VotesByParty, votesNeededForSeats } from './sainte-lague';

export type Kuadran = 'aman' | 'waspada' | 'rawan' | 'kosong';

export const SAFE_MARGIN = 0.1;
export const WATCH_MARGIN = 0.05;

/**
 * How firmly the focus party holds its seats.
 *
 * The margin is the party's votes minus the votes it needed for the seats it holds, as a share of its votes.
 * `counted` must be the votes that took part in the allocation (see `countedVotes`).
 */
export function classifyKuadran(counted: VotesByParty, seats: number, own: OwnPartyResult): Kuadran {
    if (own.kursi === 0 || !own.lolos_ambang_batas) {
        return 'kosong';
    }
    const needed = votesNeededForSeats(counted, seats, own.partai_id, own.kursi);
    if (needed === null) {
        return 'kosong';
    }
    const margin = (own.suara - needed) / own.suara;
    if (margin >= SAFE_MARGIN) {
        return 'aman';
    }
    return margin >= WATCH_MARGIN ? 'waspada' : 'rawan';
}

/**
 * True when the next seat is less than half a last-seat price away.
 *
 * A party under the national threshold cannot win a seat whatever it gains in one dapil, so it is never near.
 */
export function isNextSeatNear(own: OwnPartyResult, lastSeatPrice: number | null): boolean {
    if (!own.lolos_ambang_batas || own.kekurangan_kursi_berikutnya === null || lastSeatPrice === null) {
        return false;
    }
    return own.kekurangan_kursi_berikutnya < lastSeatPrice / 2;
}
