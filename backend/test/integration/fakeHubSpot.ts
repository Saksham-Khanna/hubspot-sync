import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface FakeContact {
  id: string;
  properties: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** Minimal in-memory HubSpot: just the endpoints the app calls, with knobs to inject failures. */
export class FakeHubSpot {
  server!: Server;
  url!: string;
  contacts: FakeContact[] = [];
  notes: { id: string; body: string; contactId: string }[] = [];
  refreshCalls = 0;
  refreshMode: 'ok' | 'revoked' = 'ok';
  failContactListOnce = 0;
  rateLimitContactListTimes = 0;
  contactListCalls = 0;
  noteMode: 'ok' | 'create_then_500' | 'contact_gone' = 'ok';
  revokedTokens = new Set<string>();
  private tokenSeq = 0;
  private noteSeq = 0;

  seed(n: number) {
    this.contacts = Array.from({ length: n }, (_, i) => ({
      id: String(1000 + i),
      properties: { firstname: `First${i}`, lastname: `Last${i}`, email: `c${i}@example.com`, company: i % 2 ? 'Acme' : 'Globex' },
      createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString(),
      updatedAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString(),
    }));
  }

  async start(port = 0) {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, this.url);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const path = url.pathname;

    // Stand-in for HubSpot's consent screen: instantly "approves" and bounces back with a code.
    if (path === '/oauth/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'good-code');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return void res.end();
    }

    if (path === '/oauth/v1/token' && req.method === 'POST') {
      const form = new URLSearchParams(raw);
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code') return this.send(res, 400, { message: 'bad code' });
      } else {
        this.refreshCalls++;
        if (this.refreshMode === 'revoked') return this.send(res, 400, { message: 'refresh token revoked' });
        await new Promise((r) => setTimeout(r, 60)); // widen the race window for the concurrency test
      }
      return this.send(res, 200, { access_token: `at-${++this.tokenSeq}`, refresh_token: 'rt-1', expires_in: 1800 });
    }
    if (path.startsWith('/oauth/v1/access-tokens/')) {
      return this.send(res, 200, { hub_id: 12345, hub_domain: 'demo.hubspot.com', user: 'owner@demo.test', scopes: ['crm.objects.contacts.read'] });
    }

    // Everything below needs a valid bearer token.
    const bearer = (req.headers.authorization ?? '').replace('Bearer ', '');
    if (!bearer.startsWith('at-') || this.revokedTokens.has(bearer)) return this.send(res, 401, { message: 'token invalid' });

    if (path === '/crm/v3/objects/contacts' && req.method === 'GET') {
      this.contactListCalls++;
      if (this.rateLimitContactListTimes > 0) {
        this.rateLimitContactListTimes--;
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        return void res.end(JSON.stringify({ message: 'secondly limit exceeded', policyName: 'SECONDLY' }));
      }
      if (this.failContactListOnce > 0) {
        this.failContactListOnce--;
        return this.send(res, 500, { message: 'transient upstream failure' });
      }
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const start = Number(url.searchParams.get('after') ?? 0);
      const slice = this.contacts.slice(start, start + limit);
      const next = start + limit < this.contacts.length ? { next: { after: String(start + limit) } } : undefined;
      return this.send(res, 200, { results: slice, paging: next });
    }
    if (path === '/crm/v3/objects/contacts/search' && req.method === 'POST') {
      const body = JSON.parse(raw);
      const since = Number(body.filterGroups[0].filters[0].value);
      const hits = this.contacts.filter((c) => new Date(c.updatedAt).getTime() >= since);
      const start = Number(body.after ?? 0);
      const slice = hits.slice(start, start + body.limit);
      const next = start + body.limit < hits.length ? { next: { after: String(start + body.limit) } } : undefined;
      return this.send(res, 200, { total: hits.length, results: slice, paging: next });
    }
    if (path === '/crm/v3/objects/contacts/batch/read' && req.method === 'POST') {
      const ids = new Set<string>(JSON.parse(raw).inputs.map((i: { id: string }) => i.id));
      return this.send(res, 200, { results: this.contacts.filter((c) => ids.has(c.id)) });
    }
    if (path === '/crm/v3/objects/notes' && req.method === 'POST') {
      const body = JSON.parse(raw);
      const contactId = body.associations[0].to.id as string;
      if (this.noteMode === 'contact_gone') return this.send(res, 404, { message: 'contact does not exist' });
      const note = { id: `n-${++this.noteSeq}`, body: body.properties.hs_note_body as string, contactId };
      this.notes.push(note);
      if (this.noteMode === 'create_then_500') {
        this.noteMode = 'ok'; // created server-side, but the client never sees the success
        return this.send(res, 500, { message: 'gateway blew up after write' });
      }
      return this.send(res, 201, { id: note.id });
    }
    const assoc = path.match(/^\/crm\/v4\/objects\/contacts\/(\d+)\/associations\/notes$/);
    if (assoc) {
      return this.send(res, 200, { results: this.notes.filter((n) => n.contactId === assoc[1]).map((n) => ({ toObjectId: n.id })) });
    }
    if (path === '/crm/v3/objects/notes/batch/read' && req.method === 'POST') {
      const ids = new Set<string>(JSON.parse(raw).inputs.map((i: { id: string }) => i.id));
      return this.send(res, 200, { results: this.notes.filter((n) => ids.has(n.id)).map((n) => ({ id: n.id, properties: { hs_note_body: n.body } })) });
    }
    return this.send(res, 404, { message: `no route ${req.method} ${path}` });
  }
}
