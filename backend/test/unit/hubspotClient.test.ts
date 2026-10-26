import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNoteHtml, hubspot, mapContact } from '../../src/hubspot/client';
import { HubSpotError, PermanentError, ReauthRequiredError, classify } from '../../src/lib/errors';

afterEach(() => vi.restoreAllMocks());

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('mapContact', () => {
  it('normalises blanks to null and keeps raw properties', () => {
    const c = mapContact({
      id: 42,
      properties: { firstname: 'Ada', lastname: '  ', email: 'ada@x.io', phone: '' },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-02-01T00:00:00Z',
    } as never);
    expect(c).toMatchObject({ hubspotId: '42', firstName: 'Ada', lastName: null, email: 'ada@x.io', phone: null });
    expect(c.hsUpdatedAt).toBe('2024-02-01T00:00:00Z');
  });
});

describe('buildNoteHtml', () => {
  it('escapes HTML and embeds the dedupe marker', () => {
    const html = buildNoteHtml('<script>x</script>\nline2', 'abc');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<br>');
    expect(html).toContain('[ref:abc]');
  });
});

describe('hubspot client error handling', () => {
  it('maps 429 to a rate-limit error honouring Retry-After', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(429, { message: 'slow down' }, { 'retry-after': '7' }));
    const err = await hubspot.listContacts('t', { limit: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(HubSpotError);
    expect(err.isRateLimit).toBe(true);
    expect(err.retryAfterMs).toBe(7000);
    expect(err.retryable).toBe(true);
  });

  it('treats network failures as retryable 503', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const err = await hubspot.listContacts('t', { limit: 10 }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it('parses paging cursors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { results: [{ id: '1', properties: {} }], paging: { next: { after: '100' } } }));
    const page = await hubspot.listContacts('t', { limit: 1 });
    expect(page.next).toBe('100');
    expect(page.contacts).toHaveLength(1);
  });

  it('finds an earlier-created note by its ref marker', async () => {
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { results: [{ toObjectId: 11 }, { toObjectId: 12 }] }))
      .mockResolvedValueOnce(json(200, { results: [{ id: '11', properties: { hs_note_body: 'other' } }, { id: '12', properties: { hs_note_body: '<p>x</p><p>[ref:n-1]</p>' } }] }));
    expect(await hubspot.findNoteByRef('t', '5', 'n-1')).toBe('12');
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('classify', () => {
  it('permanent for 4xx (except 401/408/429), retryable for 5xx', () => {
    expect(classify(new HubSpotError('bad', 400, null))).toBeInstanceOf(PermanentError);
    expect(classify(new HubSpotError('gone', 404, null))).toBeInstanceOf(PermanentError);
    expect(classify(new HubSpotError('boom', 502, null))).not.toBeInstanceOf(PermanentError);
    expect(classify(new HubSpotError('timeout', 408, null))).not.toBeInstanceOf(PermanentError);
    expect(classify(new ReauthRequiredError())).toBeInstanceOf(ReauthRequiredError);
  });
});
