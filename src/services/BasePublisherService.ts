import { getSupabaseClient, SocialPost, Platform, PlatformCredential, logActivity } from '../config/supabase';
import { logger } from '../utils/logger';
import { getMediaService } from './MediaService';
import { relevanceFilterService } from './RelevanceFilterService';

export interface PublishResult {
  postId: string;
  platform: Platform;
  success: boolean;
  externalPostId?: string;
  externalPostUrl?: string;
  error?: string;
}

export interface PlatformCredentials {
  [key: string]: unknown;
}

export abstract class BasePublisherService {
  protected platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
  }

  /**
   * Get credentials from Supabase
   */
  async getCredentials(): Promise<PlatformCredentials | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('platform_credentials')
      .select('*')
      .eq('platform', this.platform)
      .single();

    if (error || !data) {
      logger.warn(`No credentials found for ${this.platform}`);
      return null;
    }

    return (data as PlatformCredential).config_json as PlatformCredentials;
  }

  /**
   * Save credentials to Supabase
   */
  async saveCredentials(credentials: PlatformCredentials): Promise<boolean> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('platform_credentials')
      .upsert({
        platform: this.platform,
        config_json: credentials,
      }, {
        onConflict: 'platform',
      });

    if (error) {
      logger.error(`Failed to save credentials for ${this.platform}`, { error });
      return false;
    }

    return true;
  }

  /**
   * Check if we can post today (rate limiting)
   */
  async canPostToday(): Promise<{ canPost: boolean; remaining: number; limit: number }> {
    const supabase = getSupabaseClient();

    // Get rate limit from criteria config
    const criteria = await relevanceFilterService.getActiveCriteria();
    const limits = criteria?.maxPostsPerDayPerPlatform || { linkedin: 3, facebook: 3, instagram: 3, x: 5 };
    const maxPerDay = limits[this.platform] || 3;

    // Count posts published today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { count, error } = await supabase
      .from('social_posts')
      .select('*', { count: 'exact', head: true })
      .eq('platform', this.platform)
      .eq('status', 'PUBLISHED')
      .gte('published_at', todayStart.toISOString());

    const postedToday = error ? 0 : (count || 0);

    return {
      canPost: postedToday < maxPerDay,
      remaining: Math.max(0, maxPerDay - postedToday),
      limit: maxPerDay,
    };
  }

  /**
   * Get a social post by ID
   */
  async getPost(postId: string): Promise<SocialPost | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('social_posts')
      .select('*')
      .eq('id', postId)
      .single();

    if (error || !data) {
      return null;
    }

    return data as SocialPost;
  }

  /**
   * Get media assets for a post
   */
  async getPostMediaUrls(post: SocialPost): Promise<string[]> {
    if (!post.media_asset_ids || post.media_asset_ids.length === 0) {
      return [];
    }

    const mediaService = getMediaService();
    const assets = await mediaService.getMediaAssets(post.media_asset_ids);

    return assets.map(a => a.public_url);
  }

  /**
   * Update post status
   */
  async updatePostStatus(
    postId: string,
    status: 'DRAFT' | 'APPROVED' | 'PUBLISHED' | 'FAILED' | 'SKIPPED',
    externalPostId?: string,
    errorMessage?: string
  ): Promise<void> {
    const supabase = getSupabaseClient();

    const updateData: Record<string, unknown> = {
      status,
    };

    if (externalPostId) {
      updateData.external_post_id = externalPostId;
    }

    if (errorMessage) {
      updateData.error_message = errorMessage;
    }

    if (status === 'PUBLISHED') {
      updateData.published_at = new Date().toISOString();
    }

    await supabase
      .from('social_posts')
      .update(updateData)
      .eq('id', postId);
  }

  /**
   * Get posts ready for publishing
   */
  async getPostsReadyToPublish(limit?: number): Promise<SocialPost[]> {
    const supabase = getSupabaseClient();
    const rateLimit = await this.canPostToday();

    if (!rateLimit.canPost) {
      return [];
    }

    const effectiveLimit = limit ? Math.min(limit, rateLimit.remaining) : rateLimit.remaining;

    const { data, error } = await supabase
      .from('social_posts')
      .select('*')
      .eq('platform', this.platform)
      .in('status', ['APPROVED', 'DRAFT'])
      .not('content_draft', 'eq', '')
      .order('created_at', { ascending: true })
      .limit(effectiveLimit);

    if (error || !data) {
      return [];
    }

    return data as SocialPost[];
  }

  /**
   * Approve a post for publishing
   */
  async approvePost(postId: string): Promise<boolean> {
    await this.updatePostStatus(postId, 'APPROVED');
    await logActivity(
      'POST_APPROVED',
      `Post approved for ${this.platform}`,
      'SocialPost',
      postId
    );
    return true;
  }

  /**
   * Reject a post
   */
  async rejectPost(postId: string, reason?: string): Promise<boolean> {
    await this.updatePostStatus(postId, 'SKIPPED', undefined, reason || 'Rejected by reviewer');
    await logActivity(
      'POST_REJECTED',
      `Post rejected for ${this.platform}: ${reason || 'No reason given'}`,
      'SocialPost',
      postId
    );
    return true;
  }

  /**
   * Publish all approved posts
   */
  async publishApprovedPosts(): Promise<PublishResult[]> {
    const posts = await this.getPostsReadyToPublish();
    const results: PublishResult[] = [];

    for (const post of posts) {
      const result = await this.publishPost(post.id);
      results.push(result);

      // Check rate limit after each post
      const newLimit = await this.canPostToday();
      if (!newLimit.canPost) {
        break;
      }
    }

    return results;
  }

  /**
   * Abstract method to be implemented by each platform
   */
  abstract publishPost(postId: string): Promise<PublishResult>;

  /**
   * Abstract method to test the connection
   */
  abstract testConnection(): Promise<{ success: boolean; details?: Record<string, unknown>; error?: string }>;
}
