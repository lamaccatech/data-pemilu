import { describe, expect, it } from 'vitest';
import fixtures from '../../reference/fixtures.json';
import {
    allocateSeats,
    analyseDapil,
    type Candidate,
    classifyKuadran,
    countedVotes,
    isComputable,
    isNextSeatNear,
    normalizePersonName,
    round2,
    volatility,
    votesNeededForSeats,
} from '../../src/calc';

type Fixture = (typeof fixtures.dapil)[number];

const eligibleFor = (pemilu: number, tingkat: string) =>
    tingkat === 'dpr_ri' ? new Set(fixtures.dpr_ri_parties_passing_threshold[String(pemilu) as '2019' | '2024']) : null;

const votesOf = (fixture: Fixture) =>
    new Map(Object.entries(fixture.input.suara_partai).map(([partyId, votes]) => [Number(partyId), Number(votes)]));

const candidatesOf = (fixture: Fixture): Candidate[] =>
    fixture.input.caleg.map((row) => ({
        partai_id: Number(row.partai_id),
        nomor_urut: Number(row.nomor_urut),
        nama: row.nama,
        suara: Number(row.suara),
        kursi_ke: Number(row.kursi_ke),
    }));

function analyse(fixture: Fixture) {
    const { expected } = fixture;
    // The fixtures were produced with `pan` as the focus party; an uncomputable dapil does not name it.
    const ownPartyId = 'partai_sendiri' in expected && expected.partai_sendiri ? expected.partai_sendiri.partai_id : 12;
    return analyseDapil(
        {
            pemilu: expected.pemilu,
            tingkat: expected.tingkat,
            kode_dapil: expected.kode_dapil,
            nama_dapil: expected.nama_dapil,
            jumlah_kursi: expected.jumlah_kursi,
        },
        votesOf(fixture),
        candidatesOf(fixture),
        eligibleFor(expected.pemilu, expected.tingkat),
        ownPartyId,
    );
}

describe('fixtures.json', () => {
    it('holds the 8 reference dapil for pan', () => {
        expect(fixtures.dapil).toHaveLength(8);
        expect(fixtures.own_party_code).toBe('pan');
    });

    it.each(
        fixtures.dapil.map((fixture) => [
            `${fixture.expected.pemilu} ${fixture.expected.tingkat} ${fixture.expected.kode_dapil}`,
            fixture,
        ]),
    )('reproduces %s exactly, tokoh_menonjol included', (_label, fixture) => {
        expect(analyse(fixture as Fixture)).toEqual((fixture as Fixture).expected);
    });

    it('covers a dapil that cannot be computed', () => {
        expect(fixtures.dapil.filter((fixture) => !fixture.expected.dapat_dihitung)).toHaveLength(1);
    });

    it.each(fixtures.person_name_normalisation)('normalises %s to %s', (name, expected) => {
        expect(normalizePersonName(name as string)).toBe(expected);
    });
});

describe('ACEH I, 2024, dpr_ri, pan', () => {
    const fixture = fixtures.dapil.find(
        ({ expected }) => expected.pemilu === 2024 && expected.tingkat === 'dpr_ri' && expected.kode_dapil === '1101',
    ) as Fixture;
    const result = analyse(fixture);

    it('gives the six worked outputs', () => {
        if (!isComputable(result)) {
            throw new Error('ACEH I must be computable');
        }
        const own = result.partai_sendiri;
        expect([
            result.harga_kursi_terakhir,
            own.target_suara_kursi_pertama,
            own.selisih_kursi_pertama,
            own.target_suara_kursi_berikutnya,
            own.kekurangan_kursi_berikutnya,
            own.suara_caleg_batas,
        ]).toEqual([119581, 106678, 79189, 358744, 172877, 140614]);
    });

    it('classifies the seat as aman and the next seat as out of reach', () => {
        if (!isComputable(result)) {
            throw new Error('ACEH I must be computable');
        }
        const counted = countedVotes(votesOf(fixture), eligibleFor(2024, 'dpr_ri'));
        // Margin: (185867 - 106678) / 185867 = 42.6%.
        expect(classifyKuadran(counted, 7, result.partai_sendiri)).toBe('aman');
        expect(isNextSeatNear(result.partai_sendiri, result.harga_kursi_terakhir)).toBe(false);
    });
});

describe('Sainte-Laguë', () => {
    const votes = new Map([
        [1, 1000],
        [2, 600],
        [3, 300],
    ]);

    it('allocates by quotients 1, 3, 5', () => {
        const { seatsByParty, winning } = allocateSeats(votes, 4);
        expect(Object.fromEntries(seatsByParty)).toEqual({ 1: 2, 2: 1, 3: 1 });
        expect(winning).toEqual([1000, 600, 1000 / 3, 300]);
    });

    it('breaks a tie by more party votes, then by the lower partai_id', () => {
        // 900 / 3 ties with 300 / 1: the larger party takes the seat.
        expect(
            Object.fromEntries(
                allocateSeats(
                    new Map([
                        [1, 300],
                        [2, 900],
                    ]),
                    2,
                ).seatsByParty,
            ),
        ).toEqual({ 2: 2 });
        expect(
            Object.fromEntries(
                allocateSeats(
                    new Map([
                        [5, 100],
                        [4, 100],
                    ]),
                    1,
                ).seatsByParty,
            ),
        ).toEqual({ 4: 1 });
    });

    it('ignores parties without votes', () => {
        expect(
            allocateSeats(
                new Map([
                    [1, 0],
                    [2, 10],
                ]),
                3,
            ).winning,
        ).toEqual([10, 10 / 3, 2]);
    });

    it('finds the smallest total that wins a seat', () => {
        // With 4 seats the others hold 1000, 600, 333.3, 200: party 3 needs more than 200 for one seat.
        expect(votesNeededForSeats(votes, 4, 3, 1)).toBe(201);
        const { seatsByParty } = allocateSeats(new Map([...votes, [3, 201]]), 4);
        expect(seatsByParty.get(3)).toBe(1);
        expect(allocateSeats(new Map([...votes, [3, 200]]), 4).seatsByParty.get(3)).toBeUndefined();
    });

    it('returns null for an impossible seat count and 1 when nobody competes', () => {
        expect(votesNeededForSeats(votes, 4, 1, 5)).toBeNull();
        expect(votesNeededForSeats(votes, 4, 1, 0)).toBeNull();
        expect(votesNeededForSeats(new Map([[1, 50]]), 2, 1, 1)).toBe(1);
    });
});

describe('kuadran', () => {
    const own = (suara: number, kursi: number, lolos = true) => ({
        partai_id: 1,
        suara,
        kursi,
        lolos_ambang_batas: lolos,
        target_suara_kursi_pertama: null,
        selisih_kursi_pertama: null,
        target_suara_kursi_berikutnya: null,
        kekurangan_kursi_berikutnya: null,
        suara_caleg_batas: null,
    });
    // One seat, one rival with 899 votes: party 1 needs 900.
    const counted = (suara: number) =>
        new Map([
            [1, suara],
            [2, 899],
        ]);

    it.each([
        [1000, 'aman'],
        [999, 'waspada'],
        [948, 'waspada'],
        [947, 'rawan'],
        [900, 'rawan'],
    ])('with %i votes against a need of 900 is %s', (suara, expected) => {
        expect(classifyKuadran(counted(suara), 1, own(suara, 1))).toBe(expected);
    });

    it('is kosong without a seat or under the national threshold', () => {
        expect(classifyKuadran(counted(100), 1, own(100, 0))).toBe('kosong');
        expect(classifyKuadran(counted(1000), 1, own(1000, 1, false))).toBe('kosong');
    });

    it('flags the next seat as near below half the last seat price', () => {
        expect(isNextSeatNear({ ...own(1, 0), kekurangan_kursi_berikutnya: 49 }, 100)).toBe(true);
        expect(isNextSeatNear({ ...own(1, 0), kekurangan_kursi_berikutnya: 50 }, 100)).toBe(false);
        expect(isNextSeatNear({ ...own(1, 0), kekurangan_kursi_berikutnya: null }, 100)).toBe(false);
        expect(isNextSeatNear({ ...own(1, 0, false), kekurangan_kursi_berikutnya: 1 }, 100)).toBe(false);
    });
});

describe('round2', () => {
    it("matches Python's round(value, 2)", () => {
        expect(round2(6.754)).toBe(6.75);
        expect(round2(2.675)).toBe(2.67);
        expect(round2(0.125)).toBe(0.12);
        expect(round2(0.375)).toBe(0.38);
        expect(round2(1.005)).toBe(1);
        expect(round2(2)).toBe(2);
    });
});

describe('volatility', () => {
    it('is half the sum of the changes in share, with a party of one election counted from zero', () => {
        // Shares then: 50, 30, 20. Shares now: 40, 30, 0, and 30 for a party that is new.
        const before = new Map([
            ['a', 500],
            ['b', 300],
            ['c', 200],
        ]);
        const after = new Map([
            ['a', 800],
            ['b', 600],
            ['d', 600],
        ]);
        expect(volatility(before, after)).toEqual({
            indeks: 30,
            perubahan: [
                { kode_partai: 'd', persen_sebelum: 0, persen_sesudah: 30, selisih_poin: 30 },
                { kode_partai: 'b', persen_sebelum: 30, persen_sesudah: 30, selisih_poin: 0 },
                { kode_partai: 'a', persen_sebelum: 50, persen_sesudah: 40, selisih_poin: -10 },
                { kode_partai: 'c', persen_sebelum: 20, persen_sesudah: 0, selisih_poin: -20 },
            ],
        });
    });

    it('is zero when every share is kept, whatever the turnout, and null without votes', () => {
        const before = new Map([
            ['a', 100],
            ['b', 300],
        ]);
        const doubled = new Map([
            ['a', 200],
            ['b', 600],
        ]);
        expect(volatility(before, doubled)?.indeks).toBe(0);
        expect(volatility(before, new Map())).toBeNull();
        expect(volatility(new Map([['a', 0]]), doubled)).toBeNull();
    });
});
