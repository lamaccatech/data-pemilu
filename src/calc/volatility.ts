import { round2 } from './analyse';

/** One party's share of the valid votes in both elections, in percent, and the difference in points. */
export interface ShareChange {
    kode_partai: string;
    /** Zero for a party that did not run then. */
    persen_sebelum: number;
    /** Zero for a party that did not run now. */
    persen_sesudah: number;
    selisih_poin: number;
}

export interface Volatility {
    /**
     * Pedersen's index of electoral volatility (Pedersen 1979): half the sum of every party's change in
     * vote share, in points. 0 when every party kept its share, 100 when all votes went to parties that had
     * none before. It is the net change, so it is the least share of voters that changed party: voters who
     * crossed in opposite directions cancel out.
     */
    indeks: number;
    /** Every party of either election, largest gain first. */
    perubahan: ShareChange[];
}

const totalOf = (votes: ReadonlyMap<string, number>) => {
    let total = 0;
    for (const count of votes.values()) {
        total += count;
    }
    return total;
};

/**
 * The volatility between two results of the same area, by party code. A party in one result only counts
 * with a share of zero in the other. Null when either result has no votes.
 */
export function volatility(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): Volatility | null {
    const totalBefore = totalOf(before);
    const totalAfter = totalOf(after);
    if (totalBefore <= 0 || totalAfter <= 0) {
        return null;
    }
    let moved = 0;
    const perubahan: ShareChange[] = [];
    for (const kodePartai of new Set([...before.keys(), ...after.keys()])) {
        const shareBefore = ((before.get(kodePartai) ?? 0) / totalBefore) * 100;
        const shareAfter = ((after.get(kodePartai) ?? 0) / totalAfter) * 100;
        moved += Math.abs(shareAfter - shareBefore);
        perubahan.push({
            kode_partai: kodePartai,
            persen_sebelum: round2(shareBefore),
            persen_sesudah: round2(shareAfter),
            selisih_poin: round2(shareAfter - shareBefore),
        });
    }
    perubahan.sort((a, b) => b.selisih_poin - a.selisih_poin || a.kode_partai.localeCompare(b.kode_partai));
    return { indeks: round2(moved / 2), perubahan };
}
