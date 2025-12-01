import axios from 'axios';
import * as cheerio from 'cheerio';
import { getSupabaseClient, logActivity } from '../config/supabase';
import { logger } from '../utils/logger';

interface DiscoveredFeed {
  url: string;
  type: 'rss' | 'atom';
  title?: string;
}

interface DiscoveredSitemap {
  url: string;
  type: 'standard' | 'index' | 'news' | 'image' | 'video';
}

interface RobotsTxtRules {
  disallowedPaths: string[];
  allowedPaths: string[];
  crawlDelay?: number;
  sitemaps: string[];
}

interface DiscoveryResult {
  feeds: DiscoveredFeed[];
  sitemaps: DiscoveredSitemap[];
  robotsRules: RobotsTxtRules;
  suggestedType: 'feed' | 'sitemap' | 'homepage';
}

export class SourceDiscoveryService {
  private readonly userAgent = 'SocialAutoposterBot/1.0 (+https://github.com/social-autoposter)';
  private readonly timeout = 15000;

  /**
   * Discover feeds, sitemaps, and robots rules for a given homepage URL
   */
  async discoverSource(homeUrl: string): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
      feeds: [],
      sitemaps: [],
      robotsRules: {
        disallowedPaths: [],
        allowedPaths: [],
        sitemaps: [],
      },
      suggestedType: 'homepage',
    };

    const baseUrl = new URL(homeUrl);
    const origin = baseUrl.origin;

    // Run discovery in parallel
    const [robotsResult, feedsResult, sitemapResult] = await Promise.allSettled([
      this.discoverRobotsTxt(origin),
      this.discoverFeedsFromPage(homeUrl),
      this.discoverSitemaps(origin),
    ]);

    // Process robots.txt result
    if (robotsResult.status === 'fulfilled') {
      result.robotsRules = robotsResult.value;
      // Add sitemaps from robots.txt
      for (const sitemapUrl of robotsResult.value.sitemaps) {
        if (!result.sitemaps.some(s => s.url === sitemapUrl)) {
          result.sitemaps.push({ url: sitemapUrl, type: 'standard' });
        }
      }
    }

    // Process feeds result
    if (feedsResult.status === 'fulfilled') {
      result.feeds = feedsResult.value;
    }

    // Process sitemap discovery result
    if (sitemapResult.status === 'fulfilled') {
      for (const sitemap of sitemapResult.value) {
        if (!result.sitemaps.some(s => s.url === sitemap.url)) {
          result.sitemaps.push(sitemap);
        }
      }
    }

    // Determine suggested type
    if (result.feeds.length > 0) {
      result.suggestedType = 'feed';
    } else if (result.sitemaps.length > 0) {
      result.suggestedType = 'sitemap';
    } else {
      result.suggestedType = 'homepage';
    }

    logger.info('Source discovery completed', {
      homeUrl,
      feedCount: result.feeds.length,
      sitemapCount: result.sitemaps.length,
      suggestedType: result.suggestedType,
    });

    return result;
  }

  /**
   * Discover RSS/Atom feeds from the page's HTML head
   */
  async discoverFeedsFromPage(pageUrl: string): Promise<DiscoveredFeed[]> {
    const feeds: DiscoveredFeed[] = [];

    try {
      const response = await axios.get(pageUrl, {
        headers: { 'User-Agent': this.userAgent },
        timeout: this.timeout,
        maxRedirects: 5,
      });

      const $ = cheerio.load(response.data);

      // Look for RSS feeds
      $('link[rel="alternate"][type="application/rss+xml"]').each((_, el) => {
        const href = $(el).attr('href');
        const title = $(el).attr('title');
        if (href) {
          feeds.push({
            url: this.resolveUrl(href, pageUrl),
            type: 'rss',
            title: title || undefined,
          });
        }
      });

      // Look for Atom feeds
      $('link[rel="alternate"][type="application/atom+xml"]').each((_, el) => {
        const href = $(el).attr('href');
        const title = $(el).attr('title');
        if (href) {
          feeds.push({
            url: this.resolveUrl(href, pageUrl),
            type: 'atom',
            title: title || undefined,
          });
        }
      });

      // Also check for common feed URL patterns if none found
      if (feeds.length === 0) {
        const commonFeedPaths = ['/feed', '/feed/', '/rss', '/rss/', '/feed.xml', '/rss.xml', '/atom.xml'];
        const baseUrl = new URL(pageUrl);

        for (const path of commonFeedPaths) {
          try {
            const feedUrl = `${baseUrl.origin}${path}`;
            const feedResponse = await axios.head(feedUrl, {
              headers: { 'User-Agent': this.userAgent },
              timeout: 5000,
              maxRedirects: 3,
            });

            const contentType = feedResponse.headers['content-type'] || '';
            if (contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom')) {
              feeds.push({
                url: feedUrl,
                type: contentType.includes('atom') ? 'atom' : 'rss',
              });
              break; // Found one, that's enough
            }
          } catch {
            // Feed doesn't exist at this path, continue
          }
        }
      }

      logger.debug('Discovered feeds from page', { pageUrl, feedCount: feeds.length });
    } catch (error) {
      logger.warn('Failed to discover feeds from page', {
        pageUrl,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    return feeds;
  }

  /**
   * Parse robots.txt and extract rules
   */
  async discoverRobotsTxt(origin: string): Promise<RobotsTxtRules> {
    const rules: RobotsTxtRules = {
      disallowedPaths: [],
      allowedPaths: [],
      sitemaps: [],
    };

    try {
      const robotsUrl = `${origin}/robots.txt`;
      const response = await axios.get(robotsUrl, {
        headers: { 'User-Agent': this.userAgent },
        timeout: this.timeout,
        responseType: 'text',
      });

      const lines = response.data.split('\n');
      let inUserAgentBlock = false;
      let isRelevantUserAgent = false;

      for (const rawLine of lines) {
        const line = rawLine.trim();

        // Skip comments and empty lines
        if (line.startsWith('#') || line === '') continue;

        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;

        const directive = line.substring(0, colonIndex).trim().toLowerCase();
        const value = line.substring(colonIndex + 1).trim();

        switch (directive) {
          case 'user-agent':
            inUserAgentBlock = true;
            // Check if this is for us or all bots
            isRelevantUserAgent = value === '*' ||
              value.toLowerCase().includes('bot') ||
              value.toLowerCase() === 'socialautoposterbot';
            break;

          case 'disallow':
            if (inUserAgentBlock && isRelevantUserAgent && value) {
              rules.disallowedPaths.push(value);
            }
            break;

          case 'allow':
            if (inUserAgentBlock && isRelevantUserAgent && value) {
              rules.allowedPaths.push(value);
            }
            break;

          case 'crawl-delay':
            if (inUserAgentBlock && isRelevantUserAgent) {
              const delay = parseInt(value, 10);
              if (!isNaN(delay)) {
                rules.crawlDelay = delay;
              }
            }
            break;

          case 'sitemap':
            // Sitemaps are global, not per user-agent
            if (value.startsWith('http')) {
              rules.sitemaps.push(value);
            }
            break;
        }
      }

      logger.debug('Parsed robots.txt', {
        origin,
        disallowCount: rules.disallowedPaths.length,
        sitemapCount: rules.sitemaps.length,
      });
    } catch (error) {
      // robots.txt not found or error - that's OK, proceed without restrictions
      logger.debug('Could not fetch robots.txt', {
        origin,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    return rules;
  }

  /**
   * Discover sitemaps from standard locations
   */
  async discoverSitemaps(origin: string): Promise<DiscoveredSitemap[]> {
    const sitemaps: DiscoveredSitemap[] = [];
    const commonSitemapPaths = [
      '/sitemap.xml',
      '/sitemap_index.xml',
      '/sitemap-index.xml',
      '/sitemaps.xml',
      '/sitemap/',
      '/post-sitemap.xml',
      '/page-sitemap.xml',
      '/news-sitemap.xml',
    ];

    for (const path of commonSitemapPaths) {
      try {
        const sitemapUrl = `${origin}${path}`;
        const response = await axios.head(sitemapUrl, {
          headers: { 'User-Agent': this.userAgent },
          timeout: 5000,
          maxRedirects: 3,
        });

        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('xml') || response.status === 200) {
          // Determine sitemap type based on name
          let type: DiscoveredSitemap['type'] = 'standard';
          if (path.includes('index')) type = 'index';
          else if (path.includes('news')) type = 'news';
          else if (path.includes('image')) type = 'image';
          else if (path.includes('video')) type = 'video';

          sitemaps.push({ url: sitemapUrl, type });
        }
      } catch {
        // Sitemap doesn't exist at this path
      }
    }

    return sitemaps;
  }

  /**
   * Check if a URL is allowed to be crawled based on robots rules
   */
  isUrlAllowed(url: string, rules: RobotsTxtRules): boolean {
    const urlPath = new URL(url).pathname;

    // Check allow rules first (they take precedence)
    for (const allowPath of rules.allowedPaths) {
      if (this.pathMatches(urlPath, allowPath)) {
        return true;
      }
    }

    // Then check disallow rules
    for (const disallowPath of rules.disallowedPaths) {
      if (this.pathMatches(urlPath, disallowPath)) {
        return false;
      }
    }

    // Default: allowed
    return true;
  }

  /**
   * Check if a URL path matches a robots.txt pattern
   */
  private pathMatches(urlPath: string, pattern: string): boolean {
    // Handle wildcard patterns
    if (pattern.includes('*')) {
      const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      return new RegExp(`^${regexPattern}`).test(urlPath);
    }

    // Handle $ (end anchor)
    if (pattern.endsWith('$')) {
      return urlPath === pattern.slice(0, -1);
    }

    // Simple prefix match
    return urlPath.startsWith(pattern);
  }

  /**
   * Resolve a potentially relative URL to an absolute URL
   */
  private resolveUrl(href: string, baseUrl: string): string {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  }

  /**
   * Initialize a new source with discovery
   */
  async initializeSource(sourceId: string, homeUrl: string): Promise<void> {
    const supabase = getSupabaseClient();

    try {
      logger.info('Initializing source with discovery', { sourceId, homeUrl });

      // Run discovery
      const discovery = await this.discoverSource(homeUrl);

      // Update the source with discovered info
      const updateData: Record<string, unknown> = {
        robots_txt_rules: discovery.robotsRules,
        type: discovery.suggestedType,
      };

      // If we found a feed, store it
      if (discovery.feeds.length > 0) {
        updateData.discovered_feed_url = discovery.feeds[0].url;
      }

      await supabase
        .from('blog_sources')
        .update(updateData)
        .eq('id', sourceId);

      // Store discovered sitemaps
      if (discovery.sitemaps.length > 0) {
        const sitemapRecords = discovery.sitemaps.map(sitemap => ({
          source_id: sourceId,
          sitemap_url: sitemap.url,
          sitemap_type: sitemap.type,
          status: 'PENDING',
        }));

        await supabase
          .from('discovered_sitemaps')
          .upsert(sitemapRecords, {
            onConflict: 'source_id,sitemap_url',
          });
      }

      // Seed the crawl queue with the home URL
      await supabase
        .from('crawl_queue')
        .upsert({
          source_id: sourceId,
          url: homeUrl,
          depth: 0,
          status: 'PENDING',
        }, {
          onConflict: 'source_id,url',
        });

      await logActivity(
        'SOURCE_INITIALIZED',
        `Initialized source: ${discovery.feeds.length} feeds, ${discovery.sitemaps.length} sitemaps found`,
        'BlogSource',
        sourceId,
        {
          feedCount: discovery.feeds.length,
          sitemapCount: discovery.sitemaps.length,
          suggestedType: discovery.suggestedType,
        }
      );

      logger.info('Source initialized successfully', {
        sourceId,
        suggestedType: discovery.suggestedType,
        feedCount: discovery.feeds.length,
        sitemapCount: discovery.sitemaps.length,
      });
    } catch (error) {
      logger.error('Failed to initialize source', {
        sourceId,
        homeUrl,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Validate a URL and extract its normalized form
   */
  validateAndNormalizeUrl(url: string): { valid: boolean; normalizedUrl?: string; error?: string } {
    try {
      const parsed = new URL(url);

      // Must be http or https
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { valid: false, error: 'URL must use HTTP or HTTPS protocol' };
      }

      // Remove trailing slash for consistency
      let normalized = parsed.origin + parsed.pathname;
      if (normalized.endsWith('/') && normalized.length > parsed.origin.length + 1) {
        normalized = normalized.slice(0, -1);
      }

      return { valid: true, normalizedUrl: normalized };
    } catch {
      return { valid: false, error: 'Invalid URL format' };
    }
  }
}

export const sourceDiscoveryService = new SourceDiscoveryService();
