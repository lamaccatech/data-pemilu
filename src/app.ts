import { Hono } from 'hono';
import { ApiError } from './errors';
import { authenticate } from './http/auth';
import { cacheResponses } from './http/cache';
import type { AppEnv } from './http/context';
import { registerDapilRoutes } from './routes/dapil';

export const app = new Hono<AppEnv>();

app.get('/healthz', (c) => c.json({ data: { status: 'ok' }, meta: {} }));

app.use('/v1/*', authenticate, cacheResponses);
registerDapilRoutes(app);

app.notFound((c) => c.json({ error: { code: 'tidak-ditemukan', message: 'Alamat tidak ditemukan.' } }, 404));

app.onError((error, c) => {
    c.header('Cache-Control', 'no-store');
    if (error instanceof ApiError) {
        return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: 'kesalahan-server', message: 'Terjadi kesalahan di server.' } }, 500);
});
