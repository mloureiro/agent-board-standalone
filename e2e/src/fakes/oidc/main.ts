import { onTermination, readFlags, requiredFlag, serve } from '../http.ts';
import { createOidcProvider } from './provider.ts';

const flags = readFlags(process.argv.slice(2));
const port = Number(requiredFlag(flags, 'port'));
const issuer = flags.get('issuer') ?? `http://127.0.0.1:${port}`;

const provider = await createOidcProvider({
  issuer,
  clientId: requiredFlag(flags, 'client-id'),
  clientSecret: requiredFlag(flags, 'client-secret'),
  redirectUri: requiredFlag(flags, 'redirect-uri'),
});

const server = await serve(provider.handler, port);
onTermination(server);
console.log(JSON.stringify({ listening: issuer }));
