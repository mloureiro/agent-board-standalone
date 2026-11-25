import type { AgentBoardBridge } from './types.js';

export const currentBridge = (): AgentBoardBridge | null => window.agentBoardBridge ?? null;
