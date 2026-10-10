import { Hono } from 'hono';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ data: { status: 'ok' }, meta: {} }));

export default app;
