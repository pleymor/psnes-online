export interface FeatureConfig {
  enabled: boolean;
  beta: boolean;
  rolloutPercentage: number;
  description: string;
}

export const FEATURES = {
  DUAL_EMULATION_MODE: {
    enabled: import.meta.env.VITE_ENABLE_DUAL_MODE === 'true',
    beta: true,
    rolloutPercentage: 100, // 100% pour commencer (mode manuel dans l'UI)
    description: 'Mode d\'émulation duale avec synchronisation des inputs'
  } as FeatureConfig,

  INPUT_PREDICTION: {
    enabled: import.meta.env.VITE_ENABLE_INPUT_PREDICTION === 'true',
    beta: true,
    rolloutPercentage: 50,
    description: 'Prédiction des inputs manquants en mode dual'
  } as FeatureConfig,

  PERFORMANCE_MONITORING: {
    enabled: import.meta.env.VITE_ENABLE_PERF_MONITORING === 'true',
    beta: false,
    rolloutPercentage: 100,
    description: 'Monitoring de performance en temps réel'
  } as FeatureConfig
};

// Vérifier si une feature est disponible pour cet utilisateur
export function isFeatureEnabled(
  featureName: keyof typeof FEATURES,
  userId?: string
): boolean {
  const feature = FEATURES[featureName];

  if (!feature.enabled) {
    return false;
  }

  // Si rollout partiel, utiliser hash du userId
  if (feature.rolloutPercentage < 100 && userId) {
    const hash = simpleHash(userId);
    const percentage = hash % 100;
    return percentage < feature.rolloutPercentage;
  }

  return true;
}

// Vérifier si une feature est en beta
export function isFeatureBeta(featureName: keyof typeof FEATURES): boolean {
  return FEATURES[featureName]?.beta || false;
}

// Obtenir la description d'une feature
export function getFeatureDescription(featureName: keyof typeof FEATURES): string {
  return FEATURES[featureName]?.description || '';
}

// Simple hash function pour distribution uniforme
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

// Obtenir toutes les features actives
export function getActiveFeatures(userId?: string): string[] {
  const active: string[] = [];

  for (const [name, config] of Object.entries(FEATURES)) {
    if (isFeatureEnabled(name as keyof typeof FEATURES, userId)) {
      active.push(name);
    }
  }

  return active;
}

// Log des features pour debug
export function logFeatureStatus(): void {
  console.log('🎛️ Feature Flags Status:');
  for (const [name, config] of Object.entries(FEATURES)) {
    const status = config.enabled ? '✅ Enabled' : '❌ Disabled';
    const beta = config.beta ? ' [BETA]' : '';
    const rollout = config.rolloutPercentage < 100 ? ` (${config.rolloutPercentage}% rollout)` : '';
    console.log(`  ${name}: ${status}${beta}${rollout}`);
    console.log(`    ${config.description}`);
  }
}
