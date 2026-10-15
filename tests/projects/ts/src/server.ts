import Fastify from 'fastify';

export const app = Fastify();
app.get('/health', async () => ({ ok: true }));
