import { z } from 'zod';

import { signingKeyIdString } from '../../limits.js';
import { emptyResult } from '../../schemas/common.js';
import { uiDevice } from '../../schemas/device.js';
import { clientCommand, clientQuery } from '../route.js';

const devices = { feature: 'devices' } as const;

export const listClientDevicesRoute = clientQuery('devices/list', {
  request: z.object({}).strict(),
  response: z.object({ devices: z.array(uiDevice) }).strict(),
  ...devices,
});

export const revokeClientDeviceRoute = clientCommand('devices/revoke', {
  request: z.object({ keyId: signingKeyIdString }).strict(),
  response: emptyResult,
  errors: ['not-found'],
  ...devices,
});

export const clientDeviceRoutes = [listClientDevicesRoute, revokeClientDeviceRoute] as const;
