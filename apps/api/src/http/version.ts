import { CONTRACT, FEATURES, MIN_CLIENT, type Feature, type VersionDocument } from '@rumo/contract';

import type { SessionState } from '@rumo/contract';
import type { ApiConfig } from '../modules/registry.js';
import { signInMethods } from '../modules/sign-in/index.js';

export const featuresServed = (config: ApiConfig): Feature[] =>
  FEATURES.filter((feature) => {
    if (feature === 'schedules') return config.scheduling;
    if (feature === 'feeds') return config.feeds;
    if (feature === 'request-signature' || feature === 'pairing') return config.requestSignature;
    return true;
  });

export const versionDocument = (config: ApiConfig, session: SessionState): VersionDocument => ({
  contract: CONTRACT,
  minClient: { ...MIN_CLIENT },
  features: featuresServed(config),
  server: { version: config.build.version, commit: config.build.commit },
  modules: {
    signIn: signInMethods(config.signIn),
    requestSignature: config.requestSignature,
    scheduling: config.scheduling,
    feeds: config.feeds,
  },
  session,
});
