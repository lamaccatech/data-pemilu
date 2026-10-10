/** Election levels and the small integers they are stored as in D1. */
export const TINGKAT = {
    dpr_ri: 1,
    dprd_provinsi: 2,
    dprd_kabupaten_kota: 3,
} as const;

export type Tingkat = keyof typeof TINGKAT;

export const TINGKAT_NAMES = Object.keys(TINGKAT) as [Tingkat, ...Tingkat[]];

export const PEMILU = ['2024', '2019'] as const;

export type Pemilu = (typeof PEMILU)[number];
