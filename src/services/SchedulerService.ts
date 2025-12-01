import { getSupabaseClient, Platform, logActivity } from '../config/supabase';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { sourceWatcherService } from './SourceWatcherService';
import { articleFetcherService } from './ArticleFetcherService';
import { relevanceFilterService } from './RelevanceFilterService';
import { canonicalPostGenerator } from './CanonicalPostGenerator';
import { postFormattingService } from './PostFormattingService';
import { linkedInPublisherService } from './LinkedInPublisherService';
import { facebookPublisherService } from './FacebookPublisherService';
import { instagramPublisherService } from './InstagramPublisherService';
import { xPublisherService } from './XPublisherService';
import { BasePublisherService, PublishResult } from './BasePublisherService';

interface SchedulerConfig {
  // How often to check for new RSS articles (in ms)
  sourceCheckInterval: number;
  // How often to run the full pipeline (in ms)
  pipelineInterval: number;
  // Minimum delay between posts on the same platform (in ms)
  minPostDelay: number;
  // Maximum posts per run
  maxPostsPerRun: number;
}

interface PipelineResults {
  sourcesChecked: number;
  articlesFound: number;
  articlesFetched: number;
  articlesFiltered: number;
  canonicalPostsGenerated: number;
  postsFormatted: number;
  postsPublished: {
    linkedin: number;
    facebook: number;
    instagram: number;
    x: number;
  };
  errors: string[];
}

const publisherServices: Record<Platform, BasePublisherService> = {
  linkedin: linkedInPublisherService,
  facebook: facebookPublisherService,
  instagram: instagramPublisherService,
  x: xPublisherService,
};

export class SchedulerService {
  private isRunning: boolean = false;
  private sourceCheckTimer: NodeJS.Timeout | null = null;
  private pipelineTimer: NodeJS.Timeout | null = null;
  private config: SchedulerConfig;

  constructor() {
    this.config = {
      sourceCheckInterval: 30 * 60 * 1000, // 30 minutes
      pipelineInterval: 60 * 60 * 1000, // 1 hour
      minPostDelay: 5 * 60 * 1000, // 5 minutes between posts
      maxPostsPerRun: 10,
    };
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Scheduler is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting scheduler service');

    // Run immediately, then on schedule
    this.runSourceCheck();
    this.runPipeline();

    // Set up intervals
    this.sourceCheckTimer = setInterval(
      () => this.runSourceCheck(),
      this.config.sourceCheckInterval
    );

    this.pipelineTimer = setInterval(
      () => this.runPipeline(),
      this.config.pipelineInterval
    );

    logActivity('SCHEDULER_STARTED', 'Scheduler service started', 'System');
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.sourceCheckTimer) {
      clearInterval(this.sourceCheckTimer);
      this.sourceCheckTimer = null;
    }

    if (this.pipelineTimer) {
      clearInterval(this.pipelineTimer);
      this.pipelineTimer = null;
    }

    logger.info('Scheduler service stopped');
    logActivity('SCHEDULER_STOPPED', 'Scheduler service stopped', 'System');
  }

  /**
   * Run a source check (fetch new articles from RSS feeds)
   */
  async runSourceCheck(): Promise<void> {
    try {
      logger.info('Running source check...');
      await sourceWatcherService.checkAllSources();
      logger.info('Source check complete');
    } catch (error) {
      logger.error('Source check failed', { error });
    }
  }

  /**
   * Run the full content pipeline
   */
  async runPipeline(): Promise<PipelineResults> {
    const results: PipelineResults = {
      sourcesChecked: 0,
      articlesFound: 0,
      articlesFetched: 0,
      articlesFiltered: 0,
      canonicalPostsGenerated: 0,
      postsFormatted: 0,
      postsPublished: { linkedin: 0, facebook: 0, instagram: 0, x: 0 },
      errors: [],
    };

    logger.info('Running full content pipeline...');

    try {
      // Step 1: Fetch full content for new articles
      logger.info('Step 1: Fetching article content...');
      const fetchResults = await articleFetcherService.fetchAllPending();
      results.articlesFetched = fetchResults.success;

      // Step 2: Filter articles for relevance
      logger.info('Step 2: Filtering articles...');
      const filterResults = await relevanceFilterService.filterAllPending();
      results.articlesFiltered = filterResults.passed;

      // Step 3: Generate canonical posts
      logger.info('Step 3: Generating canonical posts...');
      const canonicalResults = await canonicalPostGenerator.generateAllPending();
      results.canonicalPostsGenerated = canonicalResults.success;

      // Step 4: Format posts for each platform
      logger.info('Step 4: Formatting posts for platforms...');
      const formatResults = await postFormattingService.formatAllPending();
      results.postsFormatted = formatResults.success;

      // Step 5: Publish approved posts (respecting rate limits)
      logger.info('Step 5: Publishing approved posts...');
      const publishResults = await this.publishAllPlatforms();
      results.postsPublished = publishResults;

      logger.info('Pipeline complete', results);

      await logActivity(
        'PIPELINE_COMPLETE',
        `Pipeline run completed: ${results.postsFormatted} formatted, ${Object.values(results.postsPublished).reduce((a, b) => a + b, 0)} published`,
        'System',
        undefined,
        results
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      results.errors.push(errorMsg);
      logger.error('Pipeline failed', { error });

      await logActivity(
        'PIPELINE_FAILED',
        `Pipeline run failed: ${errorMsg}`,
        'System'
      );
    }

    return results;
  }

  /**
   * Publish posts to all platforms (respecting rate limits)
   */
  private async publishAllPlatforms(): Promise<Record<Platform, number>> {
    const results: Record<Platform, number> = {
      linkedin: 0,
      facebook: 0,
      instagram: 0,
      x: 0,
    };

    const enabledPlatforms = config.autoPostPlatforms as Platform[];

    for (const platform of enabledPlatforms) {
      const publisher = publisherServices[platform];
      if (!publisher) {
        logger.warn(`No publisher service for platform: ${platform}`);
        continue;
      }

      try {
        // Check rate limit for this platform
        const rateLimit = await publisher.canPostToday();
        if (!rateLimit.canPost) {
          logger.info(`Platform ${platform} has reached daily limit`, { limit: rateLimit.limit });
          continue;
        }

        // Get approved posts for this platform
        const posts = await publisher.getPostsReadyToPublish(rateLimit.remaining);

        for (const post of posts) {
          // Add delay between posts
          if (results[platform] > 0) {
            await this.delay(this.config.minPostDelay);
          }

          const result = await publisher.publishPost(post.id);
          if (result.success) {
            results[platform]++;
          }

          // Check rate limit again after each post
          const newLimit = await publisher.canPostToday();
          if (!newLimit.canPost) {
            break;
          }
        }

        logger.info(`Published ${results[platform]} posts to ${platform}`);
      } catch (error) {
        logger.error(`Failed to publish to ${platform}`, { error });
      }
    }

    return results;
  }

  /**
   * Get rate limit status for all platforms
   */
  async getRateLimitStatus(): Promise<Record<Platform, { canPost: boolean; remaining: number; limit: number }>> {
    const status: Record<Platform, { canPost: boolean; remaining: number; limit: number }> = {} as any;

    for (const [platform, publisher] of Object.entries(publisherServices)) {
      status[platform as Platform] = await publisher.canPostToday();
    }

    return status;
  }

  /**
   * Get pending counts for the pipeline
   */
  async getPipelineStatus(): Promise<{
    pendingArticles: number;
    pendingCanonical: number;
    pendingFormatting: number;
    pendingPublish: Record<Platform, number>;
  }> {
    const supabase = getSupabaseClient();

    // Count articles at each stage
    const { count: pendingArticles } = await supabase
      .from('articles')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'NEW');

    const { count: pendingCanonical } = await supabase
      .from('articles')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'READY_FOR_POST');

    const { count: pendingFormatting } = await supabase
      .from('social_posts')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'DRAFT')
      .or('content_draft.is.null,content_draft.eq.');

    const pendingPublish: Record<Platform, number> = {
      linkedin: 0,
      facebook: 0,
      instagram: 0,
      x: 0,
    };

    for (const platform of Object.keys(pendingPublish) as Platform[]) {
      const { count } = await supabase
        .from('social_posts')
        .select('*', { count: 'exact', head: true })
        .eq('platform', platform)
        .in('status', ['DRAFT', 'APPROVED'])
        .not('content_draft', 'eq', '');

      pendingPublish[platform] = count || 0;
    }

    return {
      pendingArticles: pendingArticles || 0,
      pendingCanonical: pendingCanonical || 0,
      pendingFormatting: pendingFormatting || 0,
      pendingPublish,
    };
  }

  /**
   * Manual trigger to publish a specific post
   */
  async publishPost(postId: string): Promise<PublishResult> {
    const supabase = getSupabaseClient();

    const { data: post, error } = await supabase
      .from('social_posts')
      .select('platform')
      .eq('id', postId)
      .single();

    if (error || !post) {
      return {
        postId,
        platform: 'linkedin', // default
        success: false,
        error: 'Post not found',
      };
    }

    const publisher = publisherServices[post.platform as Platform];
    if (!publisher) {
      return {
        postId,
        platform: post.platform,
        success: false,
        error: `No publisher for platform: ${post.platform}`,
      };
    }

    return publisher.publishPost(postId);
  }

  /**
   * Update scheduler configuration
   */
  setConfig(config: Partial<SchedulerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('Scheduler config updated', { config: this.config });

    // Restart timers if running
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  /**
   * Get current scheduler status
   */
  getStatus(): {
    isRunning: boolean;
    config: SchedulerConfig;
  } {
    return {
      isRunning: this.isRunning,
      config: this.config,
    };
  }

  /**
   * Helper to add delay between operations
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Test connections to all platforms
   */
  async testAllConnections(): Promise<Record<Platform, { success: boolean; details?: Record<string, unknown>; error?: string }>> {
    const results: Record<Platform, { success: boolean; details?: Record<string, unknown>; error?: string }> = {} as any;

    for (const [platform, publisher] of Object.entries(publisherServices)) {
      results[platform as Platform] = await publisher.testConnection();
    }

    return results;
  }
}

export const schedulerService = new SchedulerService();
