import Parser from 'rss-parser';
import { getSupabaseClient, logActivity } from '../config/supabase';
import { logger } from '../utils/logger';
import { sourceDiscoveryService } from './SourceDiscoveryService';
import { crawlerService } from './CrawlerService';

// Updated BlogSource interface to match new schema
interface BlogSource {
  id: string;
  name: string;
  home_url: string;
  discovered_feed_url: string | null;
  type: 'homepage' | 'feed' | 'sitemap' | 'rss' | 'custom';
  active: boolean;
  last_checked_at: string | null;
  last_crawl_started_at: string | null;
  last_crawl_completed_at: string | null;
  last_seen_external_id: string | null;
  robots_txt_rules: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

type SourceType = BlogSource['type'];

interface RSSFeedItem {
  title?: string;
  link?: string;
  guid?: string;
  pubDate?: string;
  isoDate?: string;
  content?: string;
  contentSnippet?: string;
}

export interface FetchResult {
  success: boolean;
  articlesFound: number;
  articlesNew: number;
  errors: string[];
}

const parser = new Parser<unknown, RSSFeedItem>({
  timeout: 30000,
  headers: {
    'User-Agent': 'SocialAutoposterBot/1.0',
    'Accept': 'application/rss+xml, application/xml, text/xml',
  },
  requestOptions: {
    redirect: 'follow',
  },
});

export class SourceWatcherService {
  /**
   * Check all active sources for new articles
   * This now uses both feed-based and crawler-based discovery
   */
  async checkAllSources(): Promise<FetchResult[]> {
    const supabase = getSupabaseClient();
    const { data: sources, error } = await supabase
      .from('blog_sources')
      .select('*')
      .eq('active', true);

    if (error || !sources) {
      logger.error('Failed to fetch active sources', { error });
      return [];
    }

    logger.info(`Checking ${sources.length} active sources`);

    const results: FetchResult[] = [];

    // Separate sources by type for different processing
    const feedSources: BlogSource[] = [];
    const crawlSources: BlogSource[] = [];

    for (const source of sources as BlogSource[]) {
      if (source.type === 'feed' || source.type === 'rss' || source.discovered_feed_url) {
        feedSources.push(source);
      } else {
        crawlSources.push(source);
      }
    }

    // Process feed-based sources (faster, preferred when available)
    for (const source of feedSources) {
      try {
        const result = await this.checkFeedSource(source);
        results.push(result);
      } catch (error) {
        logger.error(`Error checking feed source ${source.name}`, { error, sourceId: source.id });
        results.push({
          success: false,
          articlesFound: 0,
          articlesNew: 0,
          errors: [error instanceof Error ? error.message : 'Unknown error'],
        });
      }
    }

    // Process crawl-based sources
    if (crawlSources.length > 0) {
      try {
        const crawlResults = await crawlerService.runCrawlCycle();
        for (const crawlResult of crawlResults) {
          results.push({
            success: crawlResult.errors.length === 0,
            articlesFound: crawlResult.pagesProcessed,
            articlesNew: crawlResult.articlesFound,
            errors: crawlResult.errors,
          });
        }
      } catch (error) {
        logger.error('Error running crawl cycle', { error });
        results.push({
          success: false,
          articlesFound: 0,
          articlesNew: 0,
          errors: [error instanceof Error ? error.message : 'Unknown error'],
        });
      }
    }

    return results;
  }

  /**
   * Check a source that has a discovered or configured feed
   */
  async checkFeedSource(source: BlogSource): Promise<FetchResult> {
    const feedUrl = source.discovered_feed_url || source.home_url;
    logger.info(`Checking feed source: ${source.name}`, { sourceId: source.id, feedUrl });

    const result: FetchResult = {
      success: true,
      articlesFound: 0,
      articlesNew: 0,
      errors: [],
    };

    try {
      await this.fetchRSSFeed(source, feedUrl, result);

      // Update last checked timestamp
      const supabase = getSupabaseClient();
      await supabase
        .from('blog_sources')
        .update({ last_checked_at: new Date().toISOString() })
        .eq('id', source.id);

      await logActivity(
        'SOURCE_CHECKED',
        `Checked source "${source.name}": found ${result.articlesFound} articles, ${result.articlesNew} new`,
        'BlogSource',
        source.id
      );

    } catch (error) {
      result.success = false;
      result.errors.push(error instanceof Error ? error.message : 'Unknown error');
      logger.error(`Failed to check feed source: ${source.name}`, { error, sourceId: source.id });
    }

    return result;
  }

  /**
   * Fetch and process RSS feed
   */
  private async fetchRSSFeed(source: BlogSource, feedUrl: string, result: FetchResult): Promise<void> {
    const supabase = getSupabaseClient();
    const feed = await parser.parseURL(feedUrl);
    const items = feed.items || [];
    result.articlesFound = items.length;

    logger.debug(`Fetched ${items.length} items from RSS feed`, { sourceId: source.id });

    let latestPublishedAt: string | null = null;
    let latestExternalId: string | null = null;

    for (const item of items) {
      const externalId = item.guid || item.link || '';
      if (!externalId) {
        logger.warn('RSS item has no guid or link, skipping', { sourceId: source.id });
        continue;
      }

      const publishedAt = item.isoDate || item.pubDate || null;
      const publishedAtDate = publishedAt ? new Date(publishedAt) : null;

      // Check if article already exists
      const { data: existing } = await supabase
        .from('articles')
        .select('id')
        .eq('source_id', source.id)
        .eq('external_id', externalId)
        .single();

      if (existing) {
        continue;
      }

      // Create new article
      try {
        const { error: insertError } = await supabase
          .from('articles')
          .insert({
            source_id: source.id,
            external_id: externalId,
            url: item.link || '',
            title: item.title || 'Untitled',
            raw_summary: item.contentSnippet || item.content || null,
            published_at: publishedAtDate?.toISOString() || null,
            status: 'NEW',
          });

        if (insertError) {
          if (insertError.code === '23505') {
            logger.debug('Article already exists (race condition)', { externalId });
            continue;
          }
          throw insertError;
        }

        result.articlesNew++;
        logger.info(`New article discovered: ${item.title}`, {
          sourceId: source.id,
          url: item.link,
        });

        await logActivity(
          'ARTICLE_DISCOVERED',
          `New article: "${item.title}" from ${source.name}`,
          'Article',
          externalId
        );

        if (publishedAtDate && (!latestPublishedAt || publishedAtDate > new Date(latestPublishedAt))) {
          latestPublishedAt = publishedAtDate.toISOString();
          latestExternalId = externalId;
        }
      } catch (error) {
        logger.error('Failed to create article', { error, externalId });
        throw error;
      }
    }

    if (latestExternalId) {
      await supabase
        .from('blog_sources')
        .update({
          last_seen_external_id: latestExternalId,
        })
        .eq('id', source.id);
    }
  }

  /**
   * Add a new blog source - now accepts just homepage URL
   * The system will automatically discover feeds, sitemaps, and crawl as needed
   */
  async addSource(name: string, homeUrl: string, type?: SourceType): Promise<BlogSource | null> {
    const supabase = getSupabaseClient();

    // Validate and normalize the URL
    const validation = sourceDiscoveryService.validateAndNormalizeUrl(homeUrl);
    if (!validation.valid) {
      logger.error('Invalid URL provided', { error: validation.error, homeUrl });
      return null;
    }

    const normalizedUrl = validation.normalizedUrl!;

    // Create the source with initial type (will be updated after discovery)
    const { data: source, error } = await supabase
      .from('blog_sources')
      .insert({
        name,
        home_url: normalizedUrl,
        type: type || 'homepage', // Default to homepage, will be updated after discovery
        active: true,
      })
      .select()
      .single();

    if (error || !source) {
      logger.error('Failed to add source', { error, name, homeUrl });
      return null;
    }

    await logActivity('SOURCE_ADDED', `Added new source: ${name}`, 'BlogSource', source.id);
    logger.info(`Added new blog source: ${name}`, { sourceId: source.id, homeUrl: normalizedUrl });

    // Run discovery in background (don't wait for it)
    this.initializeSourceDiscovery(source.id, normalizedUrl).catch(error => {
      logger.error('Background discovery failed', { sourceId: source.id, error });
    });

    return source as BlogSource;
  }

  /**
   * Initialize source discovery (runs after source is created)
   */
  private async initializeSourceDiscovery(sourceId: string, homeUrl: string): Promise<void> {
    try {
      await sourceDiscoveryService.initializeSource(sourceId, homeUrl);
      logger.info('Source discovery completed', { sourceId });
    } catch (error) {
      logger.error('Source discovery failed', {
        sourceId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Manually trigger discovery for an existing source
   */
  async rediscoverSource(sourceId: string): Promise<void> {
    const source = await this.getSource(sourceId);
    if (!source) {
      throw new Error('Source not found');
    }

    // Clear existing crawl queue and sitemaps
    const supabase = getSupabaseClient();
    await supabase.from('crawl_queue').delete().eq('source_id', sourceId);
    await supabase.from('discovered_sitemaps').delete().eq('source_id', sourceId);

    // Re-run discovery
    await sourceDiscoveryService.initializeSource(sourceId, source.home_url);

    logger.info('Source rediscovery completed', { sourceId });
  }

  /**
   * Get crawl statistics for a source
   */
  async getSourceCrawlStats(sourceId: string): Promise<{
    total: number;
    pending: number;
    fetched: number;
    articles: number;
    failed: number;
    skipped: number;
  }> {
    return crawlerService.getCrawlStats(sourceId);
  }

  /**
   * List all sources
   */
  async listSources(activeOnly: boolean = false): Promise<BlogSource[]> {
    const supabase = getSupabaseClient();

    let query = supabase
      .from('blog_sources')
      .select('*')
      .order('created_at', { ascending: false });

    if (activeOnly) {
      query = query.eq('active', true);
    }

    const { data, error } = await query;

    if (error || !data) {
      logger.error('Failed to list sources', { error });
      return [];
    }

    return data as BlogSource[];
  }

  /**
   * Get a source by ID
   */
  async getSource(sourceId: string): Promise<BlogSource | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('blog_sources')
      .select('*')
      .eq('id', sourceId)
      .single();

    if (error || !data) {
      return null;
    }

    return data as BlogSource;
  }

  /**
   * Toggle source active status
   */
  async toggleSource(sourceId: string, active: boolean): Promise<BlogSource | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('blog_sources')
      .update({ active })
      .eq('id', sourceId)
      .select()
      .single();

    if (error || !data) {
      logger.error('Failed to toggle source', { error, sourceId });
      return null;
    }

    return data as BlogSource;
  }

  /**
   * Delete a source and its articles (cascade delete handled by DB)
   */
  async deleteSource(sourceId: string): Promise<boolean> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('blog_sources')
      .delete()
      .eq('id', sourceId);

    if (error) {
      logger.error('Failed to delete source', { error, sourceId });
      return false;
    }

    logger.info(`Deleted blog source`, { sourceId });
    return true;
  }

  /**
   * Update a source
   */
  async updateSource(
    sourceId: string,
    updates: Partial<Pick<BlogSource, 'name' | 'home_url' | 'type' | 'active'>>
  ): Promise<BlogSource | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('blog_sources')
      .update(updates)
      .eq('id', sourceId)
      .select()
      .single();

    if (error || !data) {
      logger.error('Failed to update source', { error, sourceId });
      return null;
    }

    // If home_url was changed, trigger rediscovery
    if (updates.home_url) {
      this.initializeSourceDiscovery(sourceId, updates.home_url).catch(error => {
        logger.error('Background discovery failed after update', { sourceId, error });
      });
    }

    return data as BlogSource;
  }

  /**
   * Force a crawl run for a specific source
   */
  async forceCrawl(sourceId: string): Promise<FetchResult> {
    const source = await this.getSource(sourceId);
    if (!source) {
      return {
        success: false,
        articlesFound: 0,
        articlesNew: 0,
        errors: ['Source not found'],
      };
    }

    // If source has a feed, use feed-based checking
    if (source.discovered_feed_url || source.type === 'feed' || source.type === 'rss') {
      return this.checkFeedSource(source);
    }

    // Otherwise, run crawler for this source
    const result = await crawlerService.crawlSource({
      id: source.id,
      name: source.name,
      home_url: source.home_url,
      discovered_feed_url: source.discovered_feed_url,
      type: source.type,
      robots_txt_rules: source.robots_txt_rules as any,
    });

    return {
      success: result.errors.length === 0,
      articlesFound: result.pagesProcessed,
      articlesNew: result.articlesFound,
      errors: result.errors,
    };
  }
}

export const sourceWatcherService = new SourceWatcherService();
