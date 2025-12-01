-- Migration: 002_homepage_crawling.sql
-- Updates schema to support homepage-based crawling instead of feed-only sources

-- ============================================
-- Modify blog_sources table
-- ============================================

-- Rename feed_url to home_url (backwards compatible approach)
ALTER TABLE blog_sources
  RENAME COLUMN feed_url TO home_url;

-- Add discovered_feed_url column for auto-discovered RSS/Atom feeds
ALTER TABLE blog_sources
  ADD COLUMN IF NOT EXISTS discovered_feed_url TEXT;

-- Add crawl tracking columns
ALTER TABLE blog_sources
  ADD COLUMN IF NOT EXISTS last_crawl_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_crawl_completed_at TIMESTAMPTZ;

-- Add robots_txt_rules to cache parsed robots.txt
ALTER TABLE blog_sources
  ADD COLUMN IF NOT EXISTS robots_txt_rules JSONB DEFAULT '{}';

-- Update the type CHECK constraint to include 'homepage'
-- First drop the old constraint, then add the new one
ALTER TABLE blog_sources
  DROP CONSTRAINT IF EXISTS blog_sources_type_check;

ALTER TABLE blog_sources
  ADD CONSTRAINT blog_sources_type_check
  CHECK (type IN ('homepage', 'feed', 'sitemap', 'rss', 'custom'));

-- Update existing 'rss' types to 'feed' for consistency
UPDATE blog_sources SET type = 'feed' WHERE type = 'rss';

-- ============================================
-- Table: crawl_queue
-- Tracks URLs to crawl for each source
-- ============================================
CREATE TABLE IF NOT EXISTS crawl_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID NOT NULL REFERENCES blog_sources(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING',
    'FETCHING',
    'FETCHED',
    'FAILED',
    'SKIPPED',
    'IS_ARTICLE'
  )),
  depth INTEGER NOT NULL DEFAULT 0,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_tried_at TIMESTAMPTZ,
  fetch_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  page_title TEXT,
  content_type TEXT,
  is_article BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_id, url)
);

-- Indexes for crawl_queue
CREATE INDEX IF NOT EXISTS idx_crawl_queue_source_id ON crawl_queue(source_id);
CREATE INDEX IF NOT EXISTS idx_crawl_queue_status ON crawl_queue(status);
CREATE INDEX IF NOT EXISTS idx_crawl_queue_source_status ON crawl_queue(source_id, status);
CREATE INDEX IF NOT EXISTS idx_crawl_queue_depth ON crawl_queue(depth);
CREATE INDEX IF NOT EXISTS idx_crawl_queue_discovered_at ON crawl_queue(discovered_at DESC);

-- Trigger for updated_at on crawl_queue
CREATE TRIGGER update_crawl_queue_updated_at
  BEFORE UPDATE ON crawl_queue
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS on crawl_queue
ALTER TABLE crawl_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on crawl_queue" ON crawl_queue
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- Table: discovered_sitemaps
-- Tracks sitemaps found for each source
-- ============================================
CREATE TABLE IF NOT EXISTS discovered_sitemaps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID NOT NULL REFERENCES blog_sources(id) ON DELETE CASCADE,
  sitemap_url TEXT NOT NULL,
  sitemap_type TEXT NOT NULL DEFAULT 'standard' CHECK (sitemap_type IN (
    'standard',
    'index',
    'news',
    'image',
    'video'
  )),
  last_fetched_at TIMESTAMPTZ,
  url_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING',
    'FETCHED',
    'FAILED'
  )),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_id, sitemap_url)
);

CREATE INDEX IF NOT EXISTS idx_discovered_sitemaps_source_id ON discovered_sitemaps(source_id);

-- Trigger for updated_at
CREATE TRIGGER update_discovered_sitemaps_updated_at
  BEFORE UPDATE ON discovered_sitemaps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS
ALTER TABLE discovered_sitemaps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on discovered_sitemaps" ON discovered_sitemaps
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- Add FETCHING status to articles if not exists
-- ============================================
ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_status_check;

ALTER TABLE articles
  ADD CONSTRAINT articles_status_check
  CHECK (status IN (
    'NEW',
    'FETCHING',
    'REJECTED_NOT_RELEVANT',
    'READY_FOR_POST',
    'POSTED',
    'FAILED'
  ));

-- Add crawl_queue_id reference to articles (optional link)
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS crawl_queue_id UUID REFERENCES crawl_queue(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_articles_crawl_queue_id ON articles(crawl_queue_id);
