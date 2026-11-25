import { onTermination, readFlags, requiredFlag, serve } from '../http.ts';
import { createSamlIdp } from './idp.ts';

const flags = readFlags(process.argv.slice(2));
const port = Number(requiredFlag(flags, 'port'));
const issuer = flags.get('issuer') ?? `http://127.0.0.1:${port}`;

const idp = createSamlIdp({
  issuer,
  spEntityId: requiredFlag(flags, 'sp-entity-id'),
  acsUrl: requiredFlag(flags, 'acs-url'),
});

const server = await serve(idp.handler, port);
onTermination(server);
console.log(JSON.stringify({ listening: issuer }));
