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

function jsonArrayEnv(key: string, defaultValue: string[]): string[] {
  const value = process.env[key];
  if (!value) return defaultValue;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : defaultValue;
  } catch {
    return defaultValue;
  }
}

export const config = {
  // Supabase (primary data store)
  supabase: {
    url: optionalEnv('SUPABASE_URL', ''),
    anonKey: optionalEnv('SUPABASE_ANON_KEY', ''),
    serviceRoleKey: optionalEnv('SUPABASE_SERVICE_ROLE_KEY', ''),
    storageBucket: optionalEnv('SUPABASE_STORAGE_BUCKET', 'social-media-assets'),
  },

  // Legacy Database (for migration only)
  databaseUrl: optionalEnv('DATABASE_URL', 'file:./dev.db'),

  // LinkedIn
  linkedin: {
    clientId: optionalEnv('LINKEDIN_CLIENT_ID', ''),
    clientSecret: optionalEnv('LINKEDIN_CLIENT_SECRET', ''),
    redirectUri: optionalEnv('LINKEDIN_REDIRECT_URI', 'http://localhost:3000/auth/linkedin/callback'),
    accessToken: optionalEnv('LINKEDIN_ACCESS_TOKEN', ''),
    memberUrn: optionalEnv('LINKEDIN_MEMBER_URN', ''),
  },

  // Facebook (Meta Graph API)
  facebook: {
    appId: optionalEnv('FACEBOOK_APP_ID', ''),
    appSecret: optionalEnv('FACEBOOK_APP_SECRET', ''),
    pageId: optionalEnv('FACEBOOK_PAGE_ID', ''),
    pageAccessToken: optionalEnv('FACEBOOK_PAGE_ACCESS_TOKEN', ''),
  },

  // Instagram (via Meta Graph API)
  instagram: {
    accountId: optionalEnv('INSTAGRAM_ACCOUNT_ID', ''),
    // Uses Facebook app credentials and page access token
  },

  // X (Twitter)
  x: {
    apiKey: optionalEnv('X_API_KEY', ''),
    apiSecret: optionalEnv('X_API_SECRET', ''),
    accessToken: optionalEnv('X_ACCESS_TOKEN', ''),
    accessTokenSecret: optionalEnv('X_ACCESS_TOKEN_SECRET', ''),
    bearerToken: optionalEnv('X_BEARER_TOKEN', ''),
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
  manualReviewMode: boolEnv('MANUAL_REVIEW_ENABLED', true),
  autoPostPlatforms: jsonArrayEnv('AUTO_POST_PLATFORMS', ['linkedin']),

  // Scheduler
  watcherCron: optionalEnv('WATCHER_CRON', '*/30 * * * *'),
  fetcherCron: optionalEnv('FETCHER_CRON', '*/10 * * * *'),
  filterCron: optionalEnv('FILTER_CRON', '*/10 * * * *'),
  generatorCron: optionalEnv('GENERATOR_CRON', '0 * * * *'),
  posterCron: optionalEnv('POSTER_CRON', '0 9,12,15 * * *'),

  // Security
  encryptionKey: optionalEnv('ENCRYPTION_KEY', ''),

  // Validation
  isProduction: () => config.nodeEnv === 'production',
  hasSupabaseConfig: () => !!(config.supabase.url && config.supabase.serviceRoleKey),
  hasLinkedInConfig: () => !!(config.linkedin.clientId && config.linkedin.clientSecret),
  hasFacebookConfig: () => !!(config.facebook.appId && config.facebook.pageAccessToken),
  hasInstagramConfig: () => !!(config.instagram.accountId && config.facebook.pageAccessToken),
  hasXConfig: () => !!(config.x.apiKey && config.x.accessToken),
  hasOpenAIConfig: () => !!config.openai.apiKey,
  hasLinkedInToken: () => !!(config.linkedin.accessToken && config.linkedin.memberUrn),
};

export type Config = typeof config;
