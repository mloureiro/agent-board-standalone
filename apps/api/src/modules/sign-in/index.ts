import { defineModule } from '../module.js';
import { signInSchema } from './config.js';

export {
  DEFAULT_SESSION_DAYS,
  MIN_SIGNUP_TOKEN_LENGTH,
  signInMethods,
  type LoginConfig,
  type NoLoginConfig,
  type SignInConfig,
} from './config.js';
export const signInModule = defineModule({ name: 'signIn', schema: signInSchema });
