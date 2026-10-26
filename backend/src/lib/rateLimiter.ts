import { DelayedError, Job } from 'bullmq';
import { config } from '../config';
import { redis } from '../redis';
import { rateLimitDelays } from './metrics';

// Fixed-window counter shared by every worker process. Returns 0 when the call may proceed,
// otherwise the milliseconds until the window resets. INCRBY is atomic, so N workers hitting the
// same portal can never jointly exceed the budget.
const LUA = `
local c = redis.call('INCRBY', KEYS[1], ARGV[3])
if c == tonumber(ARGV[3]) then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if c > tonumber(ARGV[2]) then return redis.call('PTTL', KEYS[1]) end
return 0
`;

export async function acquireHubSpotSlot(accountId: string, cost = 1): Promise<number> {
  const ttl = (await redis.eval(
    LUA,
    1,
    `rl:hubspot:${accountId}`,
    String(config.HUBSPOT_RATE_LIMIT_WINDOW_MS),
    String(config.HUBSPOT_RATE_LIMIT_MAX),
    String(cost),
  )) as number;
  return ttl > 0 ? ttl : 0;
}

/**
 * Postpone the current job without consuming a retry attempt. Throwing DelayedError tells BullMQ the
 * job was moved to the delayed set on purpose (as opposed to failing).
 */
export async function delayJob(job: Job, token: string | undefined, ms: number, source: 'limiter' | 'hubspot_429'): Promise<never> {
  rateLimitDelays.inc({ source });
  await job.moveToDelayed(Date.now() + Math.max(ms, 250) + Math.floor(Math.random() * 250), token);
  throw new DelayedError();
}
