import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const hubspotRequests = new client.Counter({
  name: 'hubspot_requests_total',
  help: 'HubSpot API calls by endpoint and HTTP status',
  labelNames: ['endpoint', 'status'] as const,
  registers: [registry],
});
export const contactsSynced = new client.Counter({
  name: 'contacts_synced_total',
  help: 'Contacts upserted into the database',
  registers: [registry],
});
export const notesPushed = new client.Counter({
  name: 'notes_push_total',
  help: 'Note push attempts by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});
export const jobDuration = new client.Histogram({
  name: 'queue_job_duration_seconds',
  help: 'Job processing time by job name and outcome',
  labelNames: ['job', 'outcome'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});
export const rateLimitDelays = new client.Counter({
  name: 'rate_limit_delays_total',
  help: 'Jobs postponed because of the per-portal limiter or a HubSpot 429',
  labelNames: ['source'] as const,
  registers: [registry],
});
