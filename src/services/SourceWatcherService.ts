import Parser from 'rss-parser';
import { getSupabaseClient, BlogSource, Article, logActivity, SourceType } from '../config/supabase';
import { logger } from '../utils/logger';

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
    'User-Agent': 'Social Autoposter/1.0',
    'Accept': 'application/rss+xml, application/xml, text/xml',
  },
  // Handle redirects
  requestOptions: {
    redirect: 'follow',
  },
});

export class SourceWatcherService {
  /**
   * Check all active sources for new articles
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
    for (const source of sources) {
      try {
        const result = await this.checkSource(source as BlogSource);
        results.push(result);
      } catch (error) {
        logger.error(`Error checking source ${source.name}`, { error, sourceId: source.id });
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
   * Check a single source for new articles
   */
  async checkSource(source: BlogSource): Promise<FetchResult> {
    logger.info(`Checking source: ${source.name}`, { sourceId: source.id, feedUrl: source.feed_url });

    const result: FetchResult = {
      success: true,
      articlesFound: 0,
      articlesNew: 0,
      errors: [],
    };

    try {
      switch (source.type) {
        case 'rss':
          await this.fetchRSSFeed(source, result);
          break;
        case 'sitemap':
          await this.fetchSitemap(source, result);
          break;
        case 'custom':
          logger.warn(`Custom scraper not implemented for source: ${source.name}`);
          break;
        default:
          throw new Error(`Unknown source type: ${source.type}`);
      }

      // Update last checked timestamp
      const supabase = getSupabaseClient();
      await supabase
        .from('blog_sources')
        .update({ last_checked_at: new Date().toISOString() })
        .eq('id', source.id);

      // Log activity
      await logActivity(
        'SOURCE_CHECKED',
        `Checked source "${source.name}": found ${result.articlesFound} articles, ${result.articlesNew} new`,
        'BlogSource',
        source.id
      );

    } catch (error) {
      result.success = false;
      result.errors.push(error instanceof Error ? error.message : 'Unknown error');
      logger.error(`Failed to check source: ${source.name}`, { error, sourceId: source.id });
    }

    return result;
  }

  /**
   * Fetch and process RSS feed
   */
  private async fetchRSSFeed(source: BlogSource, result: FetchResult): Promise<void> {
    const supabase = getSupabaseClient();
    const feed = await parser.parseURL(source.feed_url);
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
          // Handle unique constraint violation (race condition)
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

        // Log activity
        await logActivity(
          'ARTICLE_DISCOVERED',
          `New article: "${item.title}" from ${source.name}`,
          'Article',
          externalId
        );

        // Track latest for updating source
        if (publishedAtDate && (!latestPublishedAt || publishedAtDate > new Date(latestPublishedAt))) {
          latestPublishedAt = publishedAtDate.toISOString();
          latestExternalId = externalId;
        }
      } catch (error) {
        logger.error('Failed to create article', { error, externalId });
        throw error;
      }
    }

    // Update source with latest seen article
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
   * Fetch and process sitemap
   */
  private async fetchSitemap(source: BlogSource, result: FetchResult): Promise<void> {
    const supabase = getSupabaseClient();
    logger.warn('Sitemap parsing is basic - consider implementing full support', { sourceId: source.id });

    const response = await fetch(source.feed_url);
    const text = await response.text();

    // Simple regex to extract URLs from sitemap
    const urlRegex = /<loc>([^<]+)<\/loc>/g;
    let match;
    const urls: string[] = [];

    while ((match = urlRegex.exec(text)) !== null) {
      if (match[1]) {
        urls.push(match[1]);
      }
    }

    result.articlesFound = urls.length;
    logger.debug(`Found ${urls.length} URLs in sitemap`, { sourceId: source.id });

    for (const url of urls.slice(0, 50)) { // Limit to 50 for safety
      const externalId = url;

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

      // Create new article with minimal info (will be enriched by ArticleFetcher)
      const { error: insertError } = await supabase
        .from('articles')
        .insert({
          source_id: source.id,
          external_id: externalId,
          url,
          title: 'Pending fetch',
          status: 'NEW',
        });

      if (!insertError) {
        result.articlesNew++;
      }
    }
  }

  /**
   * Add a new blog source
   */
  async addSource(name: string, feedUrl: string, type: SourceType = 'rss'): Promise<BlogSource | null> {
    const supabase = getSupabaseClient();

    const { data: source, error } = await supabase
      .from('blog_sources')
      .insert({
        name,
        feed_url: feedUrl,
        type,
        active: true,
      })
      .select()
      .single();

    if (error || !source) {
      logger.error('Failed to add source', { error, name, feedUrl });
      return null;
    }

    await logActivity('SOURCE_ADDED', `Added new source: ${name}`, 'BlogSource', source.id);
    logger.info(`Added new blog source: ${name}`, { sourceId: source.id, feedUrl });

    return source as BlogSource;
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
    updates: Partial<Pick<BlogSource, 'name' | 'feed_url' | 'type' | 'active'>>
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

    return data as BlogSource;
  }
}

export const sourceWatcherService = new SourceWatcherService();
