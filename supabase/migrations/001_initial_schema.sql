-- Multi-Platform Social Autoposter Schema
-- Migration: 001_initial_schema.sql

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- Table: blog_sources
-- Stores RSS feeds and websites to monitor
-- ============================================
CREATE TABLE IF NOT EXISTS blog_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('rss', 'sitemap', 'custom')),
  active BOOLEAN NOT NULL DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  last_seen_external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_sources_active ON blog_sources(active);

-- ============================================
-- Table: articles
-- Discovered articles from monitored sources
-- ============================================
CREATE TABLE IF NOT EXISTS articles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID NOT NULL REFERENCES blog_sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  raw_summary TEXT,
  raw_content TEXT,
  published_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN (
    'NEW',
    'REJECTED_NOT_RELEVANT',
    'READY_FOR_POST',
    'POSTED',
    'FAILED'
  )),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_source_id ON articles(source_id);

-- ============================================
-- Table: criteria_configs
-- Filtering rules and audience targeting
-- ============================================
CREATE TABLE IF NOT EXISTS criteria_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL DEFAULT 'default',
  include_keywords JSONB NOT NULL DEFAULT '[]',
  exclude_keywords JSONB NOT NULL DEFAULT '[]',
  target_audience_description TEXT NOT NULL DEFAULT '',
  default_hashtags JSONB NOT NULL DEFAULT '[]',
  max_posts_per_day_per_platform JSONB NOT NULL DEFAULT '{"linkedin": 3, "facebook": 3, "instagram": 3, "x": 5}',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_criteria_configs_active ON criteria_configs(active);

-- ============================================
-- Table: media_assets
-- Images and media stored in Supabase Storage
-- ============================================
CREATE TABLE IF NOT EXISTS media_assets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label TEXT NOT NULL,
  description TEXT,
  supabase_path TEXT NOT NULL,
  public_url TEXT NOT NULL,
  platforms_allowed JSONB NOT NULL DEFAULT '["linkedin", "facebook", "instagram", "x"]',
  file_size_bytes INTEGER,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_assets_created_at ON media_assets(created_at DESC);

-- ============================================
-- Table: social_posts
-- Platform-specific posts linked to articles
-- ============================================
CREATE TABLE IF NOT EXISTS social_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('linkedin', 'facebook', 'instagram', 'x')),
  canonical_post_json JSONB NOT NULL,
  content_draft TEXT NOT NULL,
  content_final TEXT,
  media_asset_ids JSONB DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT',
    'APPROVED',
    'PUBLISHED',
    'FAILED',
    'SKIPPED'
  )),
  error_message TEXT,
  external_post_id TEXT,
  scheduled_for TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_posts_article_id ON social_posts(article_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_platform ON social_posts(platform);
CREATE INDEX IF NOT EXISTS idx_social_posts_status ON social_posts(status);
CREATE INDEX IF NOT EXISTS idx_social_posts_published_at ON social_posts(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_posts_platform_status ON social_posts(platform, status);

-- ============================================
-- Table: platform_credentials
-- Encrypted OAuth tokens and API credentials
-- ============================================
CREATE TABLE IF NOT EXISTS platform_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  platform TEXT NOT NULL UNIQUE CHECK (platform IN ('linkedin', 'facebook', 'instagram', 'x')),
  config_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- Table: activity_logs
-- Audit trail for all system actions
-- ============================================
CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_type ON activity_logs(type);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity ON activity_logs(entity_type, entity_id);

-- ============================================
-- Trigger function for updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers to all tables with updated_at
CREATE TRIGGER update_blog_sources_updated_at
  BEFORE UPDATE ON blog_sources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_articles_updated_at
  BEFORE UPDATE ON articles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_criteria_configs_updated_at
  BEFORE UPDATE ON criteria_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_media_assets_updated_at
  BEFORE UPDATE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_social_posts_updated_at
  BEFORE UPDATE ON social_posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_platform_credentials_updated_at
  BEFORE UPDATE ON platform_credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- Row Level Security Policies (optional)
-- Enable RLS for additional security
-- ============================================

-- Enable RLS on all tables
ALTER TABLE blog_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE criteria_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (for backend operations)
CREATE POLICY "Service role full access on blog_sources" ON blog_sources
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on articles" ON articles
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on criteria_configs" ON criteria_configs
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on media_assets" ON media_assets
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on social_posts" ON social_posts
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on platform_credentials" ON platform_credentials
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on activity_logs" ON activity_logs
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- Insert default criteria config
-- ============================================
INSERT INTO criteria_configs (name, target_audience_description, max_posts_per_day_per_platform)
VALUES (
  'default',
  'Professionals interested in technology, business, and industry insights',
  '{"linkedin": 3, "facebook": 3, "instagram": 3, "x": 5}'
)
ON CONFLICT DO NOTHING;
