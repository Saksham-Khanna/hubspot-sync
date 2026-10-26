/**
 * Local stand-in for HubSpot so the whole app can be demoed/tested without a HubSpot account.
 *   npm run mock:hubspot            (default: 2,500 contacts on :4010)
 * Then point the backend at it:
 *   HUBSPOT_API_BASE=http://localhost:4010 HUBSPOT_AUTH_URL=http://localhost:4010/oauth/authorize
 */
import { FakeHubSpot } from '../test/integration/fakeHubSpot';

const port = Number(process.env.MOCK_PORT ?? 4010);
const count = Number(process.env.MOCK_CONTACTS ?? 2500);
const hs = new FakeHubSpot();
hs.seed(count);
hs.start(port).then(() => console.log(`mock HubSpot with ${count} contacts listening on ${hs.url}`));
