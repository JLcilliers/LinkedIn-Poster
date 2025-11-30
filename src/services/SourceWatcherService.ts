import Parser from 'rss-parser';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import type { BlogSource, FetchResult, RSSFeedItem } from '../types';

const parser = new Parser<unknown, RSSFeedItem>({
  timeout: 30000,
  headers: {
    'User-Agent': 'LinkedIn Blog Reposter/1.0',
    'Accept': 'application/rss+xml, application/xml, text/xml',
  },
});

export class SourceWatcherService {
  /**
   * Check all active sources for new articles
   */
  async checkAllSources(): Promise<FetchResult[]> {
    const sources = await prisma.blogSource.findMany({
      where: { active: true },
    });

    logger.info(`Checking ${sources.length} active sources`);

    const results: FetchResult[] = [];
    for (const source of sources) {
      try {
        const result = await this.checkSource(source);
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
    logger.info(`Checking source: ${source.name}`, { sourceId: source.id, feedUrl: source.feedUrl });

    const result: FetchResult = {
      success: true,
      articlesFound: 0,
      articlesNew: 0,
      errors: [],
    };

    try {
      switch (source.type) {
        case 'RSS':
          await this.fetchRSSFeed(source, result);
          break;
        case 'SITEMAP':
          await this.fetchSitemap(source, result);
          break;
        case 'CUSTOM_SCRAPER':
          logger.warn(`Custom scraper not implemented for source: ${source.name}`);
          break;
        default:
          throw new Error(`Unknown source type: ${source.type}`);
      }

      // Update last checked timestamp
      await prisma.blogSource.update({
        where: { id: source.id },
        data: { lastCheckedAt: new Date() },
      });

      // Log activity
      await this.logActivity('SOURCE_CHECKED', 'BlogSource', source.id,
        `Checked source "${source.name}": found ${result.articlesFound} articles, ${result.articlesNew} new`);

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
    const feed = await parser.parseURL(source.feedUrl);
    const items = feed.items || [];
    result.articlesFound = items.length;

    logger.debug(`Fetched ${items.length} items from RSS feed`, { sourceId: source.id });

    let latestPublishedAt: Date | null = null;
    let latestExternalId: string | null = null;

    for (const item of items) {
      const externalId = item.guid || item.link || '';
      if (!externalId) {
        logger.warn('RSS item has no guid or link, skipping', { sourceId: source.id });
        continue;
      }

      const publishedAt = item.isoDate ? new Date(item.isoDate) :
                         item.pubDate ? new Date(item.pubDate) : null;

      // Skip if older than last seen (if we have a reference)
      if (source.lastSeenPublishedAt && publishedAt && publishedAt <= source.lastSeenPublishedAt) {
        continue;
      }

      // Check if article already exists
      const existing = await prisma.article.findUnique({
        where: {
          sourceId_externalId: {
            sourceId: source.id,
            externalId,
          },
        },
      });

      if (existing) {
        continue;
      }

      // Create new article
      try {
        await prisma.article.create({
          data: {
            sourceId: source.id,
            externalId,
            url: item.link || '',
            title: item.title || 'Untitled',
            rawSummary: item.contentSnippet || item.content || null,
            publishedAt,
            status: 'NEW',
          },
        });

        result.articlesNew++;
        logger.info(`New article discovered: ${item.title}`, {
          sourceId: source.id,
          url: item.link,
        });

        // Log activity
        await this.logActivity('ARTICLE_DISCOVERED', 'Article', externalId,
          `New article: "${item.title}" from ${source.name}`);

        // Track latest for updating source
        if (publishedAt && (!latestPublishedAt || publishedAt > latestPublishedAt)) {
          latestPublishedAt = publishedAt;
          latestExternalId = externalId;
        }
      } catch (error) {
        // Handle unique constraint violation (race condition)
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          logger.debug('Article already exists (race condition)', { externalId });
        } else {
          throw error;
        }
      }
    }

    // Update source with latest seen article
    if (latestPublishedAt || latestExternalId) {
      await prisma.blogSource.update({
        where: { id: source.id },
        data: {
          lastSeenPublishedAt: latestPublishedAt || undefined,
          lastSeenExternalId: latestExternalId || undefined,
        },
      });
    }
  }

  /**
   * Fetch and process sitemap
   */
  private async fetchSitemap(source: BlogSource, result: FetchResult): Promise<void> {
    // Basic sitemap support - can be extended
    logger.warn('Sitemap parsing is basic - consider implementing full support', { sourceId: source.id });

    const response = await fetch(source.feedUrl);
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
      const existing = await prisma.article.findUnique({
        where: {
          sourceId_externalId: {
            sourceId: source.id,
            externalId,
          },
        },
      });

      if (existing) {
        continue;
      }

      // Create new article with minimal info (will be enriched by ArticleFetcher)
      await prisma.article.create({
        data: {
          sourceId: source.id,
          externalId,
          url,
          title: 'Pending fetch',
          status: 'NEW',
        },
      });

      result.articlesNew++;
    }
  }

  /**
   * Log an activity to the database
   */
  private async logActivity(type: string, entityType: string, entityId: string, message: string): Promise<void> {
    try {
      await prisma.activityLog.create({
        data: {
          type,
          entityType,
          entityId,
          message,
        },
      });
    } catch (error) {
      logger.error('Failed to log activity', { error, type, message });
    }
  }

  /**
   * Add a new blog source
   */
  async addSource(name: string, feedUrl: string, type: 'RSS' | 'SITEMAP' | 'CUSTOM_SCRAPER' = 'RSS'): Promise<BlogSource> {
    const source = await prisma.blogSource.create({
      data: {
        name,
        feedUrl,
        type,
        active: true,
      },
    });

    await this.logActivity('SOURCE_ADDED', 'BlogSource', source.id, `Added new source: ${name}`);
    logger.info(`Added new blog source: ${name}`, { sourceId: source.id, feedUrl });

    return source;
  }

  /**
   * List all sources
   */
  async listSources(activeOnly: boolean = false): Promise<BlogSource[]> {
    return prisma.blogSource.findMany({
      where: activeOnly ? { active: true } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Toggle source active status
   */
  async toggleSource(sourceId: string, active: boolean): Promise<BlogSource> {
    return prisma.blogSource.update({
      where: { id: sourceId },
      data: { active },
    });
  }

  /**
   * Delete a source and its articles
   */
  async deleteSource(sourceId: string): Promise<void> {
    await prisma.blogSource.delete({
      where: { id: sourceId },
    });
    logger.info(`Deleted blog source`, { sourceId });
  }
}

export const sourceWatcherService = new SourceWatcherService();
