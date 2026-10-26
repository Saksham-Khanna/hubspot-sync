import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db';
import { HttpError } from '../lib/errors';
import { createNote, retryNote } from '../services/notes';
import { requireAccount } from './session';

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const noteBody = z.object({ body: z.string().trim().min(1, 'Note cannot be empty').max(10_000) });

const NOTE_COLS = 'id, contact_id, body, status, hubspot_note_id, last_error, attempts, created_at, synced_at';
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export async function contactRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAccount);

  app.get('/contacts', async (req) => {
    const q = listQuery.parse(req.query);
    const params: unknown[] = [req.accountId];
    let where = 'account_id = $1 AND deleted_at IS NULL';
    if (q.search) {
      params.push(`%${escapeLike(q.search.toLowerCase())}%`);
      where += ` AND search_text LIKE $${params.length}`; // served by the pg_trgm GIN index
    }
    const total = (await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE ${where}`, params)).rows[0].n;
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const { rows } = await pool.query(
      `SELECT id, hubspot_id, email, first_name, last_name, phone, company, lifecycle_stage, hs_created_at, synced_at
         FROM contacts WHERE ${where}
        ORDER BY hs_created_at DESC NULLS LAST, id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { data: rows, page: q.page, pageSize: q.pageSize, total };
  });

  app.get('/contacts/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await pool.query(
      `SELECT id, hubspot_id, email, first_name, last_name, phone, company, lifecycle_stage, properties,
              hs_created_at, hs_updated_at, synced_at
         FROM contacts WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`,
      [id, req.accountId],
    );
    if (!rows[0]) throw new HttpError(404, 'Contact not found', 'contact_not_found');
    return rows[0];
  });

  app.get('/contacts/:id/notes', async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await pool.query(
      `SELECT ${NOTE_COLS} FROM notes WHERE contact_id=$1 AND account_id=$2 ORDER BY created_at DESC LIMIT 200`,
      [id, req.accountId],
    );
    return { data: rows };
  });

  app.post('/contacts/:id/notes', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { body } = noteBody.parse(req.body);
    const note = await createNote(req.accountId!, id, body);
    return reply.code(201).send(note);
  });

  app.post('/notes/:id/retry', async (req) => {
    const { id } = idParam.parse(req.params);
    const ok = await retryNote(req.accountId!, id);
    if (!ok) throw new HttpError(409, 'Only failed notes can be retried', 'not_retryable');
    return { ok: true };
  });
}
