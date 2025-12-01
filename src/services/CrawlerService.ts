import axios from 'axios';
import * as cheerio from 'cheerio';
import { getSupabaseClient, logActivity } from '../config/supabase';
import { logger } from '../utils/logger';
import { sourceDiscoveryService, SourceDiscoveryService } from './SourceDiscoveryService';
import { articleDetectionService } from './ArticleDetectionService';
import { relevanceFilterService } from './RelevanceFilterService';

interface CrawlConfig {
  maxDepth: number;
  maxPagesPerSource: number;
  maxPagesPerRun: number;
  requestDelayMs: number;
  timeoutMs: number;
  respectRobotsTxt: boolean;
}

interface CrawlQueueEntry {
  id: string;
  source_id: string;
  url: string;
  status: string;
  depth: number;
  discovered_at: string;
  last_tried_at: string | null;
  fetch_count: number;
  error_message: string | null;
}

interface CrawlResult {
  sourceId: string;
  pagesProcessed: number;
  articlesFound: number;
  linksDiscovered: number;
  errors: string[];
}

interface SourceWithRules {
  id: string;
  name: string;
  home_url: string;
  discovered_feed_url: string | null;
  type: string;
  robots_txt_rules: {
    disallowedPaths: string[];
    allowedPaths: string[];
    crawlDelay?: number;
    sitemaps: string[];
  } | null;
}

const DEFAULT_CONFIG: CrawlConfig = {
  maxDepth: 3,
  maxPagesPerSource: 500,
  maxPagesPerRun: 20,
  requestDelayMs: 1000,
  timeoutMs: 15000,
  respectRobotsTxt: true,
};

export class CrawlerService {
  private config: CrawlConfig;
  private readonly userAgent = 'SocialAutoposterBot/1.0 (+https://github.com/social-autoposter)';
  private lastRequestTime: Map<string, number> = new Map();

  constructor(config?: Partial<CrawlConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run a crawl cycle for all active sources
   */
  async runCrawlCycle(): Promise<CrawlResult[]> {
    const supabase = getSupabaseClient();
    const results: CrawlResult[] = [];

    try {
      // Get all active sources
      const { data: sources, error } = await supabase
        .from('blog_sources')
        .select('id, name, home_url, discovered_feed_url, type, robots_txt_rules')
        .eq('active', true);

      if (error || !sources) {
        logger.error('Failed to fetch sources for crawling', { error });
        return results;
      }

      logger.info('Starting crawl cycle', { sourceCount: sources.length });

      for (const source of sources) {
        try {
          // Mark crawl started
          await supabase
            .from('blog_sources')
            .update({ last_crawl_started_at: new Date().toISOString() })
            .eq('id', source.id);

          const result = await this.crawlSource(source as SourceWithRules);
          results.push(result);

          // Mark crawl completed
          await supabase
            .from('blog_sources')
            .update({
              last_crawl_completed_at: new Date().toISOString(),
              last_checked_at: new Date().toISOString(),
            })
            .eq('id', source.id);

        } catch (error) {
          logger.error('Failed to crawl source', {
            sourceId: source.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          results.push({
            sourceId: source.id,
            pagesProcessed: 0,
            articlesFound: 0,
            linksDiscovered: 0,
            errors: [error instanceof Error ? error.message : 'Unknown error'],
          });
        }
      }

      logger.info('Crawl cycle completed', {
        sourcesProcessed: results.length,
        totalArticles: results.reduce((sum, r) => sum + r.articlesFound, 0),
      });

      return results;
    } catch (error) {
      logger.error('Crawl cycle failed', { error });
      return results;
    }
  }

  /**
   * Crawl a single source
   */
  async crawlSource(source: SourceWithRules): Promise<CrawlResult> {
    const supabase = getSupabaseClient();
    const result: CrawlResult = {
      sourceId: source.id,
      pagesProcessed: 0,
      articlesFound: 0,
      linksDiscovered: 0,
      errors: [],
    };

    try {
      // Ensure the crawl queue is seeded
      await this.seedCrawlQueue(source);

      // Get pending URLs from queue
      const { data: pendingUrls, error } = await supabase
        .from('crawl_queue')
        .select('*')
        .eq('source_id', source.id)
        .eq('status', 'PENDING')
        .order('depth', { ascending: true })
        .order('discovered_at', { ascending: true })
        .limit(this.config.maxPagesPerRun);

      if (error || !pendingUrls) {
        logger.error('Failed to fetch crawl queue', { sourceId: source.id, error });
        return result;
      }

      logger.info('Processing crawl queue', {
        sourceId: source.id,
        sourceName: source.name,
        pendingCount: pendingUrls.length,
      });

      for (const entry of pendingUrls as CrawlQueueEntry[]) {
        try {
          // Check robots.txt rules
          if (this.config.respectRobotsTxt && source.robots_txt_rules) {
            if (!sourceDiscoveryService.isUrlAllowed(entry.url, source.robots_txt_rules)) {
              await this.updateQueueEntry(entry.id, 'SKIPPED', 'Blocked by robots.txt');
              continue;
            }
          }

          // Apply crawl delay
          await this.applyCrawlDelay(source);

          // Fetch and process the page
          const pageResult = await this.processPage(entry, source);

          result.pagesProcessed++;
          result.articlesFound += pageResult.isArticle ? 1 : 0;
          result.linksDiscovered += pageResult.linksFound;

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          result.errors.push(`${entry.url}: ${errorMsg}`);

          await this.updateQueueEntry(entry.id, 'FAILED', errorMsg);
        }
      }

      await logActivity(
        'CRAWL_COMPLETED',
        `Crawled ${result.pagesProcessed} pages, found ${result.articlesFound} articles`,
        'BlogSource',
        source.id,
        result
      );

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(errorMsg);
      logger.error('Source crawl failed', { sourceId: source.id, error: errorMsg });
    }

    return result;
  }

  /**
   * Seed the crawl queue for a source
   */
  private async seedCrawlQueue(source: SourceWithRules): Promise<void> {
    const supabase = getSupabaseClient();

    // Check if queue already has entries
    const { count } = await supabase
      .from('crawl_queue')
      .select('*', { count: 'exact', head: true })
      .eq('source_id', source.id);

    if (count && count > 0) {
      return; // Queue already seeded
    }

    // Add home URL
    await supabase
      .from('crawl_queue')
      .upsert({
        source_id: source.id,
        url: source.home_url,
        depth: 0,
        status: 'PENDING',
      }, {
        onConflict: 'source_id,url',
      });

    // If we have sitemaps, seed URLs from them
    const { data: sitemaps } = await supabase
      .from('discovered_sitemaps')
      .select('*')
      .eq('source_id', source.id)
      .eq('status', 'PENDING');

    if (sitemaps && sitemaps.length > 0) {
      for (const sitemap of sitemaps) {
        await this.processSitemap(source.id, sitemap.sitemap_url);
      }
    }

    logger.debug('Crawl queue seeded', { sourceId: source.id });
  }

  /**
   * Process a sitemap and add URLs to the crawl queue
   */
  private async processSitemap(sourceId: string, sitemapUrl: string): Promise<void> {
    const supabase = getSupabaseClient();

    try {
      const response = await axios.get(sitemapUrl, {
        headers: { 'User-Agent': this.userAgent },
        timeout: this.config.timeoutMs,
      });

      const $ = cheerio.load(response.data, { xmlMode: true });
      const urls: string[] = [];

      // Check if it's a sitemap index
      $('sitemapindex sitemap loc').each((_, el) => {
        // This is a sitemap index, would need recursive processing
        // For now, skip nested sitemaps
      });

      // Process URL entries
      $('urlset url loc').each((_, el) => {
        const url = $(el).text().trim();
        if (url && this.shouldCrawlUrl(url, sourceId)) {
          urls.push(url);
        }
      });

      // Batch insert URLs into crawl queue
      if (urls.length > 0) {
        const entries = urls.slice(0, 200).map(url => ({
          source_id: sourceId,
          url,
          depth: 1,
          status: 'PENDING',
        }));

        await supabase
          .from('crawl_queue')
          .upsert(entries, { onConflict: 'source_id,url' });

        logger.info('Added URLs from sitemap', {
          sourceId,
          sitemapUrl,
          urlCount: entries.length,
        });
      }

      // Mark sitemap as fetched
      await supabase
        .from('discovered_sitemaps')
        .update({
          status: 'FETCHED',
          last_fetched_at: new Date().toISOString(),
          url_count: urls.length,
        })
        .eq('source_id', sourceId)
        .eq('sitemap_url', sitemapUrl);

    } catch (error) {
      logger.warn('Failed to process sitemap', {
        sourceId,
        sitemapUrl,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      await supabase
        .from('discovered_sitemaps')
        .update({
          status: 'FAILED',
          error_message: error instanceof Error ? error.message : 'Unknown error',
        })
        .eq('source_id', sourceId)
        .eq('sitemap_url', sitemapUrl);
    }
  }

  /**
   * Process a single page from the crawl queue
   */
  private async processPage(
    entry: CrawlQueueEntry,
    source: SourceWithRules
  ): Promise<{ isArticle: boolean; linksFound: number }> {
    const supabase = getSupabaseClient();

    // Mark as fetching
    await supabase
      .from('crawl_queue')
      .update({
        status: 'FETCHING',
        last_tried_at: new Date().toISOString(),
        fetch_count: entry.fetch_count + 1,
      })
      .eq('id', entry.id);

    try {
      // Fetch the page
      const response = await axios.get(entry.url, {
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html,application/xhtml+xml',
        },
        timeout: this.config.timeoutMs,
        maxRedirects: 5,
        validateStatus: (status) => status < 400,
      });

      // Check content type
      const contentType = response.headers['content-type'] || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        await this.updateQueueEntry(entry.id, 'SKIPPED', `Non-HTML content type: ${contentType}`);
        return { isArticle: false, linksFound: 0 };
      }

      const html = response.data;
      const $ = cheerio.load(html);

      // Extract page title for the queue entry
      const pageTitle = $('title').text().trim().substring(0, 255);

      // Analyze if this is an article
      const detection = articleDetectionService.analyzePageContent(entry.url, html);

      let linksFound = 0;

      // If this is an article, create an article record
      if (detection.isArticle) {
        await this.createArticleFromPage(entry, source, detection);
        await this.updateQueueEntry(entry.id, 'IS_ARTICLE', undefined, pageTitle, contentType, true);
      } else {
        // Extract and queue new links if not at max depth
        if (entry.depth < this.config.maxDepth) {
          linksFound = await this.extractAndQueueLinks($, entry, source);
        }
        await this.updateQueueEntry(entry.id, 'FETCHED', undefined, pageTitle, contentType, false);
      }

      return { isArticle: detection.isArticle, linksFound };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      await this.updateQueueEntry(entry.id, 'FAILED', errorMsg);
      throw error;
    }
  }

  /**
   * Create an article record from a detected article page
   */
  private async createArticleFromPage(
    entry: CrawlQueueEntry,
    source: SourceWithRules,
    detection: ReturnType<typeof articleDetectionService.analyzePageContent>
  ): Promise<void> {
    const supabase = getSupabaseClient();

    // Check if article already exists
    const { data: existing } = await supabase
      .from('articles')
      .select('id')
      .eq('source_id', source.id)
      .eq('url', entry.url)
      .single();

    if (existing) {
      logger.debug('Article already exists', { url: entry.url });
      return;
    }

    // Create article record
    const { data: article, error } = await supabase
      .from('articles')
      .insert({
        source_id: source.id,
        external_id: entry.url, // Use URL as external ID for crawled pages
        url: entry.url,
        title: detection.title || 'Untitled',
        raw_summary: detection.summary,
        raw_content: detection.content?.substring(0, 50000), // Limit content size
        published_at: detection.publishedAt?.toISOString(),
        status: 'NEW',
        crawl_queue_id: entry.id,
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to create article', { url: entry.url, error });
      return;
    }

    logger.info('Created article from crawled page', {
      articleId: article.id,
      url: entry.url,
      title: detection.title,
      confidence: detection.confidence,
    });

    // Run relevance filter immediately
    try {
      await relevanceFilterService.filterArticle(article.id);
    } catch (error) {
      logger.warn('Failed to filter article', {
        articleId: article.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    await logActivity(
      'ARTICLE_DISCOVERED',
      `Discovered article: ${detection.title || entry.url}`,
      'Article',
      article.id,
      {
        url: entry.url,
        confidence: detection.confidence,
        wordCount: detection.wordCount,
      }
    );
  }

  /**
   * Extract links from a page and add to crawl queue
   */
  private async extractAndQueueLinks(
    $: cheerio.CheerioAPI,
    entry: CrawlQueueEntry,
    source: SourceWithRules
  ): Promise<number> {
    const supabase = getSupabaseClient();
    const baseUrl = new URL(source.home_url);
    const links: string[] = [];

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      try {
        const absoluteUrl = new URL(href, entry.url).href;
        const urlObj = new URL(absoluteUrl);

        // Only same domain
        if (urlObj.hostname !== baseUrl.hostname) return;

        // Skip static files and common non-article paths
        if (!this.shouldCrawlUrl(absoluteUrl, source.id)) return;

        // Check robots.txt
        if (this.config.respectRobotsTxt && source.robots_txt_rules) {
          if (!sourceDiscoveryService.isUrlAllowed(absoluteUrl, source.robots_txt_rules)) {
            return;
          }
        }

        // Normalize URL (remove fragment, trailing slash)
        const normalizedUrl = urlObj.origin + urlObj.pathname.replace(/\/$/, '');

        if (!links.includes(normalizedUrl)) {
          links.push(normalizedUrl);
        }
      } catch {
        // Invalid URL, skip
      }
    });

    // Check total queue size for this source
    const { count: queueSize } = await supabase
      .from('crawl_queue')
      .select('*', { count: 'exact', head: true })
      .eq('source_id', source.id);

    const remainingSlots = this.config.maxPagesPerSource - (queueSize || 0);
    const linksToAdd = links.slice(0, Math.min(50, remainingSlots));

    if (linksToAdd.length > 0) {
      const entries = linksToAdd.map(url => ({
        source_id: source.id,
        url,
        depth: entry.depth + 1,
        status: 'PENDING',
      }));

      await supabase
        .from('crawl_queue')
        .upsert(entries, { onConflict: 'source_id,url', ignoreDuplicates: true });

      logger.debug('Queued new links', {
        sourceId: source.id,
        parentUrl: entry.url,
        linksAdded: linksToAdd.length,
      });
    }

    return linksToAdd.length;
  }

  /**
   * Check if a URL should be crawled
   */
  private shouldCrawlUrl(url: string, sourceId: string): boolean {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname.toLowerCase();

      // Skip static files
      const staticExtensions = [
        '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.zip', '.rar', '.tar', '.gz',
        '.css', '.js', '.json', '.xml',
        '.mp3', '.mp4', '.wav', '.avi', '.mov',
        '.woff', '.woff2', '.ttf', '.eot',
      ];

      for (const ext of staticExtensions) {
        if (path.endsWith(ext)) return false;
      }

      // Skip common non-content paths
      const skipPatterns = [
        /^\/?(wp-admin|wp-includes|wp-content\/plugins)/,
        /^\/?(admin|login|logout|register|signup|signin)/,
        /^\/?(cart|checkout|account|my-account)/,
        /^\/?(search|tag|category|author)\/?\?/,
        /^\/?(privacy|terms|cookie|legal)/,
        /\?(utm_|fbclid|gclid|ref=)/,
      ];

      for (const pattern of skipPatterns) {
        if (pattern.test(path)) return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Apply crawl delay based on robots.txt or default
   */
  private async applyCrawlDelay(source: SourceWithRules): Promise<void> {
    const hostname = new URL(source.home_url).hostname;
    const lastRequest = this.lastRequestTime.get(hostname) || 0;

    let delayMs = this.config.requestDelayMs;
    if (source.robots_txt_rules?.crawlDelay) {
      delayMs = Math.max(delayMs, source.robots_txt_rules.crawlDelay * 1000);
    }

    const elapsed = Date.now() - lastRequest;
    if (elapsed < delayMs) {
      await new Promise(resolve => setTimeout(resolve, delayMs - elapsed));
    }

    this.lastRequestTime.set(hostname, Date.now());
  }

  /**
   * Update a crawl queue entry
   */
  private async updateQueueEntry(
    id: string,
    status: string,
    errorMessage?: string,
    pageTitle?: string,
    contentType?: string,
    isArticle?: boolean
  ): Promise<void> {
    const supabase = getSupabaseClient();

    const update: Record<string, unknown> = { status };
    if (errorMessage !== undefined) update.error_message = errorMessage;
    if (pageTitle !== undefined) update.page_title = pageTitle;
    if (contentType !== undefined) update.content_type = contentType;
    if (isArticle !== undefined) update.is_article = isArticle;

    await supabase
      .from('crawl_queue')
      .update(update)
      .eq('id', id);
  }

  /**
   * Get crawl statistics for a source
   */
  async getCrawlStats(sourceId: string): Promise<{
    total: number;
    pending: number;
    fetched: number;
    articles: number;
    failed: number;
    skipped: number;
  }> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('crawl_queue')
      .select('status')
      .eq('source_id', sourceId);

    if (error || !data) {
      return { total: 0, pending: 0, fetched: 0, articles: 0, failed: 0, skipped: 0 };
    }

    return {
      total: data.length,
      pending: data.filter(e => e.status === 'PENDING').length,
      fetched: data.filter(e => e.status === 'FETCHED').length,
      articles: data.filter(e => e.status === 'IS_ARTICLE').length,
      failed: data.filter(e => e.status === 'FAILED').length,
      skipped: data.filter(e => e.status === 'SKIPPED').length,
    };
  }

  /**
   * Reset crawl queue for a source
   */
  async resetCrawlQueue(sourceId: string): Promise<void> {
    const supabase = getSupabaseClient();

    await supabase
      .from('crawl_queue')
      .delete()
      .eq('source_id', sourceId);

    await supabase
      .from('discovered_sitemaps')
      .update({ status: 'PENDING' })
      .eq('source_id', sourceId);

    logger.info('Reset crawl queue', { sourceId });
  }

  /**
   * Update crawler configuration
   */
  setConfig(config: Partial<CrawlConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export const crawlerService = new CrawlerService();
