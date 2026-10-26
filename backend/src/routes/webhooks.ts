import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { pool } from '../db';
import { verifyHubSpotV3Signature } from '../lib/crypto';
import { logger } from '../lib/logger';
import { addJob, syncQueue } from '../queues';
import { softDeleteContacts } from '../services/contacts';

const events = z.array(
  z
    .object({
      subscriptionType: z.string(),
      objectId: z.union([z.number(), z.string()]),
      portalId: z.number(),
    })
    .passthrough(),
);

// HubSpot signs the exact URL it calls, so we must reproduce it (it may differ from what the proxy shows us).
const webhookUrl = () => config.WEBHOOK_PUBLIC_URL ?? new URL('/api/webhooks/hubspot', config.HUBSPOT_REDIRECT_URI).toString();

/**
 * Real-time incremental sync. HubSpot POSTs batches of events (at-least-once, unordered).
 * We verify the signature, do the cheap part synchronously (deletions), and queue the rest so the
 * HTTP response returns fast (HubSpot's timeout is 5s). Refreshes are idempotent upserts.
 */
export async function webhookRoutes(app: FastifyInstance) {
  // Signature verification needs the raw bytes, so keep the body string alongside the parsed JSON.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error);
    }
  });

  app.post('/webhooks/hubspot', async (req, reply) => {
    const ok = verifyHubSpotV3Signature({
      secret: config.HUBSPOT_CLIENT_SECRET,
      method: req.method,
      url: webhookUrl(),
      rawBody: req.rawBody ?? '',
      timestamp: req.headers['x-hubspot-request-timestamp'] as string | undefined,
      signature: req.headers['x-hubspot-signature-v3'] as string | undefined,
    });
    if (!ok) return reply.code(401).send({ error: 'invalid_signature' });

    const parsed = events.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    const portalIds = [...new Set(parsed.data.map((e) => e.portalId))];
    const accounts = (await pool.query('SELECT id, hub_id FROM accounts WHERE hub_id = ANY($1::bigint[]) AND status = $2', [portalIds, 'connected'])).rows;
    const byHub = new Map<number, string>(accounts.map((a) => [a.hub_id, a.id]));

    const toRefresh = new Map<string, Set<string>>();
    const toDelete = new Map<string, Set<string>>();
    for (const e of parsed.data) {
      const accountId = byHub.get(e.portalId);
      if (!accountId || !e.subscriptionType.startsWith('contact.')) continue;
      const bucket = /deletion$/i.test(e.subscriptionType) ? toDelete : toRefresh;
      if (!bucket.has(accountId)) bucket.set(accountId, new Set());
      bucket.get(accountId)!.add(String(e.objectId));
    }

    for (const [accountId, ids] of toDelete) await softDeleteContacts(pool, accountId, [...ids]);
    let queued = 0;
    for (const [accountId, set] of toRefresh) {
      const ids = [...set];
      for (let i = 0; i < ids.length; i += 100) {
        await addJob(syncQueue, 'refresh-contacts', { accountId, hubspotIds: ids.slice(i, i + 100) });
        queued++;
      }
    }
    logger.info({ events: parsed.data.length, queued }, 'webhook accepted');
    return reply.code(200).send({ received: parsed.data.length });
  });
}
