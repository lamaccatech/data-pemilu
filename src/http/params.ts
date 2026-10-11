import { z } from 'zod';
import { database, type Election, loadElection, type Party, requireParty } from '../db/election';
import { ApiError, notFound } from '../errors';
import { PEMILU, type Pemilu, TINGKAT_NAMES, type Tingkat } from '../tingkat';
import type { AppContext } from './context';

/** The same name the response cache keys on; see `http/cache.ts`. */
export const CALLER_VERSION_PARAMETER = '__versi';

const digits = (pattern: RegExp, message: string) => z.string().regex(pattern, message).transform(Number);

export const fields = {
    tingkat: z.enum(TINGKAT_NAMES, { error: `tingkat harus salah satu dari: ${TINGKAT_NAMES.join(', ')}` }),
    kode_dapil: digits(/^[1-9]\d{3,6}$/, 'kode_dapil harus berupa 4 sampai 7 angka'),
    kode_kelurahan: digits(/^[1-9]\d{9}$/, 'kode_kelurahan harus berupa 10 angka'),
    // Text, not a number: overseas polling places of DKI JAKARTA II have codes such as 99AA01.
    kode_kecamatan: z.string().regex(/^[1-9][0-9A-Z]{5}$/, 'kode kecamatan harus berupa 6 karakter'),
    partai: z.string().regex(/^[a-z0-9_]{1,32}$/, 'partai harus berupa kode partai, misalnya "pan"'),
    provinsi: digits(/^[1-9]\d$/, 'provinsi harus berupa kode 2 angka'),
    kabupaten: digits(/^[1-9]\d{3}$/, 'kabupaten harus berupa kode 4 angka'),
};

/** Validates path and query parameters together. Unknown query parameters are refused, so typos are not ignored. */
export function parseParams<Shape extends z.ZodRawShape>(c: AppContext, shape: Shape): z.infer<z.ZodObject<Shape>> {
    const { pemilu: _pemilu, ...path } = c.req.param() as Record<string, string>;
    // A caller may send its own version marker so that its HTTP cache stops giving out an answer of an older
    // shape. It names nothing to look up, so it is dropped here.
    const { [CALLER_VERSION_PARAMETER]: _version, ...query } = c.req.query();
    const result = z.strictObject(shape).safeParse({ ...query, ...path });
    if (result.success) {
        return result.data as z.infer<z.ZodObject<Shape>>;
    }
    const problems = result.error.issues.map((issue) => {
        if (issue.code === 'unrecognized_keys') {
            return `parameter tidak dikenal: ${issue.keys.join(', ')}`;
        }
        const name = issue.path.join('.');
        return issue.code === 'invalid_type' ? `${name} wajib diisi` : issue.message;
    });
    throw new ApiError(400, 'parameter-tidak-valid', `Parameter tidak valid: ${problems.join('; ')}.`);
}

/** The election named in the path. An unknown year is a 404. */
export async function electionOf(c: AppContext): Promise<{ pemilu: Pemilu; election: Election; db: D1Database }> {
    const pemilu = c.req.param('pemilu') as Pemilu;
    if (!PEMILU.includes(pemilu)) {
        throw notFound('pemilu-tidak-ditemukan', `Pemilu "${pemilu}" tidak tersedia. Pilihan: ${PEMILU.join(', ')}.`);
    }
    return { pemilu, election: await loadElection(c.env, pemilu), db: database(c.env, pemilu) };
}

/** For the endpoints that exist for 2024 only. */
export async function election2024(c: AppContext, what: string) {
    const found = await electionOf(c);
    if (found.pemilu !== '2024') {
        throw notFound('tidak-tersedia', `${what} hanya tersedia untuk Pemilu 2024.`);
    }
    return found;
}

export function dapilNotFound(tingkat: Tingkat, kodeDapil: number, pemilu: Pemilu): ApiError {
    return notFound(
        'dapil-tidak-ditemukan',
        `Dapil ${kodeDapil} tingkat ${tingkat} tidak ditemukan pada Pemilu ${pemilu}.`,
    );
}

export const optionalParty = (election: Election, kodePartai: string | undefined): Party | null =>
    kodePartai === undefined ? null : requireParty(election, kodePartai);
