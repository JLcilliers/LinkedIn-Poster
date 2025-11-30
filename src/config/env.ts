import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function boolEnv(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true';
}

function intEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

export const config = {
  // Database
  databaseUrl: optionalEnv('DATABASE_URL', 'file:./dev.db'),

  // LinkedIn
  linkedin: {
    clientId: optionalEnv('LINKEDIN_CLIENT_ID', ''),
    clientSecret: optionalEnv('LINKEDIN_CLIENT_SECRET', ''),
    redirectUri: optionalEnv('LINKEDIN_REDIRECT_URI', 'http://localhost:3000/auth/linkedin/callback'),
    accessToken: optionalEnv('LINKEDIN_ACCESS_TOKEN', ''),
    memberUrn: optionalEnv('LINKEDIN_MEMBER_URN', ''),
  },

  // OpenAI
  openai: {
    apiKey: optionalEnv('OPENAI_API_KEY', ''),
    model: optionalEnv('OPENAI_MODEL', 'gpt-4o'),
  },

  // Server
  port: intEnv('PORT', 3000),
  nodeEnv: optionalEnv('NODE_ENV', 'development'),

  // Feature flags
  autoPostToLinkedIn: boolEnv('AUTO_POST_TO_LINKEDIN', false),
  manualReviewMode: boolEnv('MANUAL_REVIEW_MODE', true),

  // Scheduler
  watcherCron: optionalEnv('WATCHER_CRON', '*/30 * * * *'),
  posterCron: optionalEnv('POSTER_CRON', '0 9,12,15 * * *'),

  // Security
  encryptionKey: optionalEnv('ENCRYPTION_KEY', ''),

  // Validation
  isProduction: () => config.nodeEnv === 'production',
  hasLinkedInConfig: () => !!(config.linkedin.clientId && config.linkedin.clientSecret),
  hasOpenAIConfig: () => !!config.openai.apiKey,
  hasLinkedInToken: () => !!(config.linkedin.accessToken && config.linkedin.memberUrn),
};

export type Config = typeof config;
