import type { HandlerSet } from '../http/handler.js';
import { publicHandlers } from './public.js';

export const HANDLER_SETS: readonly HandlerSet[] = [publicHandlers];
