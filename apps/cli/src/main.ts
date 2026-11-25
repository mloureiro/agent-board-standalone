import { runCli } from './commands/program.js';
import { loopbackNoProxy } from './no-proxy.js';
import { systemRuntime } from './runtime.js';

process.env.NO_PROXY = loopbackNoProxy(process.env.NO_PROXY);
process.env.no_proxy = loopbackNoProxy(process.env.no_proxy);
process.exitCode = await runCli(process.argv.slice(2), systemRuntime());
