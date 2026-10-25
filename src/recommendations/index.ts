import type { RecommendationProvider } from './types';
import { securityProvider } from './security';
import { costProvider } from './cost';
import { performanceProvider } from './performance';
import { schemaProvider } from './schema';
import { reliabilityProvider } from './reliability';
import { documentationProvider } from './documentation';
import { dataQualityProvider } from './dataquality';

export * from './types';

export const RECOMMENDATION_PROVIDERS: RecommendationProvider[] = [
  securityProvider,
  costProvider,
  performanceProvider,
  schemaProvider,
  reliabilityProvider,
  documentationProvider,
  dataQualityProvider,
];
