import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

// Database types for type safety
export interface Database {
  public: {
    Tables: {
      blog_sources: {
        Row: BlogSource;
        Insert: Omit<BlogSource, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<BlogSource, 'id' | 'created_at' | 'updated_at'>>;
      };
      articles: {
        Row: Article;
        Insert: Omit<Article, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<Article, 'id' | 'created_at' | 'updated_at'>>;
      };
      criteria_configs: {
        Row: CriteriaConfig;
        Insert: Omit<CriteriaConfig, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<CriteriaConfig, 'id' | 'created_at' | 'updated_at'>>;
      };
      media_assets: {
        Row: MediaAsset;
        Insert: Omit<MediaAsset, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<MediaAsset, 'id' | 'created_at' | 'updated_at'>>;
      };
      social_posts: {
        Row: SocialPost;
        Insert: Omit<SocialPost, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<SocialPost, 'id' | 'created_at' | 'updated_at'>>;
      };
      platform_credentials: {
        Row: PlatformCredential;
        Insert: Omit<PlatformCredential, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<PlatformCredential, 'id' | 'created_at' | 'updated_at'>>;
      };
      activity_logs: {
        Row: ActivityLog;
        Insert: Omit<ActivityLog, 'id' | 'created_at'>;
        Update: never;
      };
    };
  };
}

// Type definitions
export type SourceType = 'rss' | 'sitemap' | 'custom';
export type ArticleStatus = 'NEW' | 'REJECTED_NOT_RELEVANT' | 'READY_FOR_POST' | 'POSTED' | 'FAILED';
export type SocialPostStatus = 'DRAFT' | 'APPROVED' | 'PUBLISHED' | 'FAILED' | 'SKIPPED';
export type Platform = 'linkedin' | 'facebook' | 'instagram' | 'x';

export interface BlogSource {
  id: string;
  name: string;
  feed_url: string;
  type: SourceType;
  active: boolean;
  last_checked_at: string | null;
  last_seen_external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Article {
  id: string;
  source_id: string;
  external_id: string;
  url: string;
  title: string;
  raw_summary: string | null;
  raw_content: string | null;
  published_at: string | null;
  status: ArticleStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CriteriaConfig {
  id: string;
  name: string;
  include_keywords: string[];
  exclude_keywords: string[];
  target_audience_description: string;
  default_hashtags: string[];
  max_posts_per_day_per_platform: Record<Platform, number>;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MediaAsset {
  id: string;
  label: string;
  description: string | null;
  supabase_path: string;
  public_url: string;
  platforms_allowed: Platform[];
  file_size_bytes: number | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
  updated_at: string;
}

export interface CanonicalPost {
  articleId: string;
  mainIdea: string;
  keyInsights: string[];
  targetAudience: string;
  toneGuidelines: string;
  suggestedCallToAction: string | null;
  tags: string[];
  articleUrl: string;
  articleTitle: string;
}

export interface SocialPost {
  id: string;
  article_id: string;
  platform: Platform;
  canonical_post_json: CanonicalPost;
  content_draft: string;
  content_final: string | null;
  media_asset_ids: string[];
  status: SocialPostStatus;
  error_message: string | null;
  external_post_id: string | null;
  scheduled_for: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformCredential {
  id: string;
  platform: Platform;
  config_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ActivityLog {
  id: string;
  type: string;
  entity_type: string | null;
  entity_id: string | null;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

// Supabase client singleton
let supabaseClient: SupabaseClient<Database> | null = null;

export function getSupabaseClient(): SupabaseClient<Database> {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      'Missing Supabase configuration. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.'
    );
  }

  supabaseClient = createClient<Database>(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  logger.info('Supabase client initialized');
  return supabaseClient;
}

// Helper function to get storage bucket
export function getStorageBucket(bucketName: string = 'social-media-assets') {
  const client = getSupabaseClient();
  return client.storage.from(bucketName);
}

// Helper to check Supabase connectivity
export async function checkSupabaseConnection(): Promise<boolean> {
  try {
    const client = getSupabaseClient();
    const { error } = await client.from('blog_sources').select('id').limit(1);

    if (error) {
      logger.error('Supabase connection check failed', { error: error.message });
      return false;
    }

    return true;
  } catch (error) {
    logger.error('Supabase connection check failed', { error });
    return false;
  }
}

// Activity log helper
export async function logActivity(
  type: string,
  message: string,
  entityType?: string,
  entityId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const client = getSupabaseClient();
    await client.from('activity_logs').insert({
      type,
      message,
      entity_type: entityType || null,
      entity_id: entityId || null,
      metadata: metadata || {},
    });
  } catch (error) {
    logger.error('Failed to log activity', { type, message, error });
  }
}
