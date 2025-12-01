import { checkSupabaseConnection, getSupabaseClient, Platform } from '../config/supabase';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { linkedInPublisherService } from './LinkedInPublisherService';
import { facebookPublisherService } from './FacebookPublisherService';
import { instagramPublisherService } from './InstagramPublisherService';
import { xPublisherService } from './XPublisherService';
import { schedulerService } from './SchedulerService';

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number;
  checks: {
    database: ServiceCheck;
    storage: ServiceCheck;
    openai: ServiceCheck;
    platforms: Record<Platform, PlatformCheck>;
    scheduler: ServiceCheck;
  };
  stats: {
    sources: number;
    articles: number;
    pendingPosts: number;
    publishedToday: Record<Platform, number>;
  };
}

interface ServiceCheck {
  status: 'ok' | 'warning' | 'error';
  message?: string;
  latency?: number;
}

interface PlatformCheck extends ServiceCheck {
  configured: boolean;
  authenticated: boolean;
  rateLimitRemaining?: number;
}

const startTime = Date.now();

export class HealthCheckService {
  /**
   * Run a comprehensive health check
   */
  async runHealthCheck(): Promise<HealthStatus> {
    const timestamp = new Date().toISOString();
    const uptime = Math.floor((Date.now() - startTime) / 1000);

    // Run all checks in parallel
    const [
      databaseCheck,
      storageCheck,
      openaiCheck,
      platformChecks,
      schedulerCheck,
      stats,
    ] = await Promise.all([
      this.checkDatabase(),
      this.checkStorage(),
      this.checkOpenAI(),
      this.checkAllPlatforms(),
      this.checkScheduler(),
      this.getStats(),
    ]);

    // Determine overall status
    const allChecks = [
      databaseCheck,
      storageCheck,
      openaiCheck,
      schedulerCheck,
      ...Object.values(platformChecks),
    ];

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    if (allChecks.some(c => c.status === 'error')) {
      status = databaseCheck.status === 'error' ? 'unhealthy' : 'degraded';
    } else if (allChecks.some(c => c.status === 'warning')) {
      status = 'degraded';
    }

    return {
      status,
      timestamp,
      version: '2.0.0',
      uptime,
      checks: {
        database: databaseCheck,
        storage: storageCheck,
        openai: openaiCheck,
        platforms: platformChecks,
        scheduler: schedulerCheck,
      },
      stats,
    };
  }

  /**
   * Quick liveness check
   */
  async isAlive(): Promise<boolean> {
    try {
      await checkSupabaseConnection();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check database connection
   */
  private async checkDatabase(): Promise<ServiceCheck> {
    const start = Date.now();

    try {
      const connected = await checkSupabaseConnection();
      const latency = Date.now() - start;

      if (!connected) {
        return {
          status: 'error',
          message: 'Cannot connect to Supabase',
          latency,
        };
      }

      // Check if we can query
      const supabase = getSupabaseClient();
      const { error } = await supabase.from('blog_sources').select('id').limit(1);

      if (error) {
        return {
          status: 'warning',
          message: `Query error: ${error.message}`,
          latency: Date.now() - start,
        };
      }

      return {
        status: 'ok',
        message: 'Database connected and responsive',
        latency: Date.now() - start,
      };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        latency: Date.now() - start,
      };
    }
  }

  /**
   * Check Supabase Storage
   */
  private async checkStorage(): Promise<ServiceCheck> {
    const start = Date.now();

    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.storage.from('media-assets').list('', { limit: 1 });

      if (error) {
        return {
          status: 'warning',
          message: `Storage error: ${error.message}`,
          latency: Date.now() - start,
        };
      }

      return {
        status: 'ok',
        message: 'Storage bucket accessible',
        latency: Date.now() - start,
      };
    } catch (error) {
      return {
        status: 'warning',
        message: error instanceof Error ? error.message : 'Storage check failed',
        latency: Date.now() - start,
      };
    }
  }

  /**
   * Check OpenAI configuration
   */
  private async checkOpenAI(): Promise<ServiceCheck> {
    if (!config.openai.apiKey) {
      return {
        status: 'warning',
        message: 'OpenAI API key not configured',
      };
    }

    // We don't actually call OpenAI to avoid costs - just check config
    return {
      status: 'ok',
      message: `OpenAI configured with model: ${config.openai.model}`,
    };
  }

  /**
   * Check all platform connections
   */
  private async checkAllPlatforms(): Promise<Record<Platform, PlatformCheck>> {
    const platforms: Platform[] = ['linkedin', 'facebook', 'instagram', 'x'];
    const results: Record<Platform, PlatformCheck> = {} as any;

    const checks = await Promise.all(
      platforms.map(async (platform) => {
        const check = await this.checkPlatform(platform);
        return { platform, check };
      })
    );

    checks.forEach(({ platform, check }) => {
      results[platform] = check;
    });

    return results;
  }

  /**
   * Check a single platform
   */
  private async checkPlatform(platform: Platform): Promise<PlatformCheck> {
    const start = Date.now();
    const isEnabled = config.autoPostPlatforms.includes(platform);

    if (!isEnabled) {
      return {
        status: 'ok',
        message: 'Platform not enabled',
        configured: false,
        authenticated: false,
      };
    }

    try {
      let result: { success: boolean; details?: Record<string, unknown>; error?: string };
      let rateLimit: { canPost: boolean; remaining: number; limit: number };

      switch (platform) {
        case 'linkedin':
          result = await linkedInPublisherService.testConnection();
          rateLimit = await linkedInPublisherService.canPostToday();
          break;
        case 'facebook':
          result = await facebookPublisherService.testConnection();
          rateLimit = await facebookPublisherService.canPostToday();
          break;
        case 'instagram':
          result = await instagramPublisherService.testConnection();
          rateLimit = await instagramPublisherService.canPostToday();
          break;
        case 'x':
          result = await xPublisherService.testConnection();
          rateLimit = await xPublisherService.canPostToday();
          break;
        default:
          return {
            status: 'warning',
            message: 'Unknown platform',
            configured: false,
            authenticated: false,
          };
      }

      if (!result.success) {
        return {
          status: 'warning',
          message: result.error || 'Connection test failed',
          configured: true,
          authenticated: false,
          latency: Date.now() - start,
        };
      }

      return {
        status: 'ok',
        message: 'Connected and authenticated',
        configured: true,
        authenticated: true,
        rateLimitRemaining: rateLimit.remaining,
        latency: Date.now() - start,
      };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        configured: true,
        authenticated: false,
        latency: Date.now() - start,
      };
    }
  }

  /**
   * Check scheduler status
   */
  private async checkScheduler(): Promise<ServiceCheck> {
    const status = schedulerService.getStatus();

    if (!status.isRunning) {
      return {
        status: 'warning',
        message: 'Scheduler not running',
      };
    }

    return {
      status: 'ok',
      message: 'Scheduler running',
    };
  }

  /**
   * Get system statistics
   */
  private async getStats(): Promise<{
    sources: number;
    articles: number;
    pendingPosts: number;
    publishedToday: Record<Platform, number>;
  }> {
    try {
      const supabase = getSupabaseClient();

      // Count sources
      const { count: sourcesCount } = await supabase
        .from('blog_sources')
        .select('*', { count: 'exact', head: true })
        .eq('active', true);

      // Count articles
      const { count: articlesCount } = await supabase
        .from('articles')
        .select('*', { count: 'exact', head: true });

      // Count pending posts
      const { count: pendingCount } = await supabase
        .from('social_posts')
        .select('*', { count: 'exact', head: true })
        .in('status', ['DRAFT', 'APPROVED']);

      // Count published today per platform
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const publishedToday: Record<Platform, number> = {
        linkedin: 0,
        facebook: 0,
        instagram: 0,
        x: 0,
      };

      for (const platform of Object.keys(publishedToday) as Platform[]) {
        const { count } = await supabase
          .from('social_posts')
          .select('*', { count: 'exact', head: true })
          .eq('platform', platform)
          .eq('status', 'PUBLISHED')
          .gte('published_at', todayStart.toISOString());

        publishedToday[platform] = count || 0;
      }

      return {
        sources: sourcesCount || 0,
        articles: articlesCount || 0,
        pendingPosts: pendingCount || 0,
        publishedToday,
      };
    } catch (error) {
      logger.error('Failed to get stats', { error });
      return {
        sources: 0,
        articles: 0,
        pendingPosts: 0,
        publishedToday: { linkedin: 0, facebook: 0, instagram: 0, x: 0 },
      };
    }
  }

  /**
   * Get activity log summary
   */
  async getRecentActivity(limit: number = 20): Promise<Array<{
    type: string;
    message: string;
    timestamp: string;
    details?: Record<string, unknown>;
  }>> {
    try {
      const supabase = getSupabaseClient();

      const { data, error } = await supabase
        .from('activity_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error || !data) {
        return [];
      }

      return data.map(log => ({
        type: log.type,
        message: log.message,
        timestamp: log.created_at,
        details: log.details_json,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get pipeline status
   */
  async getPipelineStatus(): Promise<{
    articlesNew: number;
    articlesFetching: number;
    articlesReady: number;
    postsFormatting: number;
    postsApproved: number;
  }> {
    try {
      const supabase = getSupabaseClient();

      const [newCount, fetchingCount, readyCount, formattingCount, approvedCount] = await Promise.all([
        supabase.from('articles').select('*', { count: 'exact', head: true }).eq('status', 'NEW'),
        supabase.from('articles').select('*', { count: 'exact', head: true }).eq('status', 'FETCHING'),
        supabase.from('articles').select('*', { count: 'exact', head: true }).eq('status', 'READY_FOR_POST'),
        supabase.from('social_posts').select('*', { count: 'exact', head: true })
          .eq('status', 'DRAFT').or('content_draft.is.null,content_draft.eq.'),
        supabase.from('social_posts').select('*', { count: 'exact', head: true }).eq('status', 'APPROVED'),
      ]);

      return {
        articlesNew: newCount.count || 0,
        articlesFetching: fetchingCount.count || 0,
        articlesReady: readyCount.count || 0,
        postsFormatting: formattingCount.count || 0,
        postsApproved: approvedCount.count || 0,
      };
    } catch {
      return {
        articlesNew: 0,
        articlesFetching: 0,
        articlesReady: 0,
        postsFormatting: 0,
        postsApproved: 0,
      };
    }
  }
}

export const healthCheckService = new HealthCheckService();
