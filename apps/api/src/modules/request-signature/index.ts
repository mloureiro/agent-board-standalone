import { defineModule } from '../module.js';
import { envObject, onOff } from '../env.js';
import { registerRequestSignature } from './register.js';

export const requestSignatureModule = defineModule({
  name: 'requestSignature',
  schema: envObject.transform((env, ctx) => onOff(env, 'REQUEST_SIGNATURE', false, ctx)),
  register: registerRequestSignature,
});

export { REGISTER_KEY_ROUTE, requiresSignature, type VerifiedSignature } from './verify.js';
