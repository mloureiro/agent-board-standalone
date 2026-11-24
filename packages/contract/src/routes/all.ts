import {
  clientAccountRoutes,
  clientAttentionRoute,
  clientDeviceRoutes,
  clientDirectoryRoutes,
  clientDocumentRoutes,
  clientEventsRoute,
  clientFeedRoutes,
  clientKeyRoutes,
  clientMachineRoutes,
  clientPasskeyRoutes,
  clientProjectRoutes,
  clientScheduleRoutes,
  clientSettingsRoutes,
  clientTaskRoutes,
  clientTopRoutes,
  clientTranscriptRoutes,
} from './client/index.js';
import {
  machineDirectoryRoutes,
  machineDocumentRoutes,
  machineEventsRoute,
  machineHandshakeRoutes,
  machineNoteRoutes,
  machinePrRoutes,
  machineRunRoutes,
  machineScheduleRoutes,
  machineTaskRoutes,
  machineUserActionRoutes,
  transcriptRoute,
} from './machine/index.js';
import type { AnyRoute } from './route.js';

export const routes = [
  ...machineTaskRoutes,
  ...machineNoteRoutes,
  ...machinePrRoutes,
  ...machineRunRoutes,
  ...machineHandshakeRoutes,
  ...machineDocumentRoutes,
  ...machineDirectoryRoutes,
  ...machineScheduleRoutes,
  ...machineUserActionRoutes,
  transcriptRoute,
  machineEventsRoute,
  ...clientTopRoutes,
  ...clientTaskRoutes,
  ...clientScheduleRoutes,
  ...clientTranscriptRoutes,
  ...clientKeyRoutes,
  ...clientPasskeyRoutes,
  ...clientMachineRoutes,
  ...clientFeedRoutes,
  ...clientDocumentRoutes,
  ...clientAccountRoutes,
  ...clientProjectRoutes,
  ...clientDirectoryRoutes,
  ...clientSettingsRoutes,
  clientAttentionRoute,
  ...clientDeviceRoutes,
  clientEventsRoute,
] as const;

export type RouteName = (typeof routes)[number]['name'];

const ofAuth = (auth: AnyRoute['auth']): readonly AnyRoute[] =>
  routes.filter((route) => route.auth === auth);

export const machineRoutes = ofAuth('machine');
export const clientRoutes = ofAuth('client');
export const publicRoutes = ofAuth('public');

export const routeByName = <N extends RouteName>(
  name: N,
): Extract<(typeof routes)[number], { name: N }> => {
  const route = routes.find((candidate) => candidate.name === name);
  if (!route) throw new Error(`unknown route ${name}`);
  return route as Extract<(typeof routes)[number], { name: N }>;
};
