import { defineModule } from '../module.js';
import { envObject, onOff } from '../env.js';

export const requestSignatureModule = defineModule({
  name: 'requestSignature',
  schema: envObject.transform((env, ctx) => onOff(env, 'REQUEST_SIGNATURE', false, ctx)),
});
