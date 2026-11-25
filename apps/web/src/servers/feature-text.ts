import { FEATURE_LABELS, type Feature } from '@agent-board/contract';

export const notOffered = (feature: Feature): string =>
  `This server does not offer ${FEATURE_LABELS[feature]}.`;
