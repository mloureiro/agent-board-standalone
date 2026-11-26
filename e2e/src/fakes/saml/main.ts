import { onTermination, readFlags, requiredFlag, serve } from '../http.ts';
import { createSamlIdp } from './idp.ts';

const flags = readFlags(process.argv.slice(2));
const port = Number(requiredFlag(flags, 'port'));
// Same site as the board (localhost): Playwright 1.65 WebKit throws "Assertion error" when a cross-site
// POST lands on a page with Cross-Origin-Opener-Policy, because WebKit opens a second provisional page.
const issuer = flags.get('issuer') ?? `http://localhost:${port}`;

const idp = createSamlIdp({
  issuer,
  spEntityId: requiredFlag(flags, 'sp-entity-id'),
  acsUrl: requiredFlag(flags, 'acs-url'),
});

const server = await serve(idp.handler, port);
onTermination(server);
console.log(JSON.stringify({ listening: issuer }));
