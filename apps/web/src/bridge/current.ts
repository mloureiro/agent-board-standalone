import type { RumoBridge } from './types.js';

export const currentBridge = (): RumoBridge | null => window.rumoBridge ?? null;
