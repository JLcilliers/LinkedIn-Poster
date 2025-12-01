import axios, { AxiosError } from 'axios';
import { getSupabaseClient, logActivity } from '../config/supabase';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { encrypt, decrypt } from '../utils/crypto';
import { BasePublisherService, PublishResult, PlatformCredentials } from './BasePublisherService';

const INSTAGRAM_GRAPH_URL = 'https://graph.facebook.com/v18.0';

interface InstagramCredentials extends PlatformCredentials {
  instagramAccountId: string;
  accessToken: string;
  facebookPageId?: string;
  tokenExpiresAt?: string;
}

export class InstagramPublisherService extends BasePublisherService {
  constructor() {
    super('instagram');
  }

  /**
   * Store Instagram credentials
   */
  async storeCredentials(credentials: {
    instagramAccountId: string;
    accessToken: string;
    facebookPageId?: string;
    tokenExpiresAt?: Date;
  }): Promise<void> {
    const igCredentials: InstagramCredentials = {
      instagramAccountId: credentials.instagramAccountId,
      accessToken: encrypt(credentials.accessToken),
      facebookPageId: credentials.facebookPageId,
      tokenExpiresAt: credentials.tokenExpiresAt?.toISOString(),
    };

    await super.saveCredentials(igCredentials);
    logger.info('Stored Instagram credentials', { accountId: credentials.instagramAccountId });
  }

  /**
   * Get Instagram credentials
   */
  async getInstagramCredentials(): Promise<InstagramCredentials | null> {
    // First check environment variables
    if (config.instagram.accessToken && config.instagram.accountId) {
      return {
        instagramAccountId: config.instagram.accountId,
        accessToken: config.instagram.accessToken,
        facebookPageId: config.instagram.facebookPageId,
      };
    }

    // Then check Supabase
    const credentials = await this.getCredentials() as InstagramCredentials | null;

    if (!credentials) {
      return null;
    }

    // Decrypt sensitive fields
    return {
      ...credentials,
      accessToken: credentials.accessToken ? decrypt(credentials.accessToken) : '',
    };
  }

  /**
   * Publish a post to Instagram
   * Instagram requires a two-step process: create media container, then publish
   */
  async publishPost(postId: string): Promise<PublishResult> {
    const result: PublishResult = {
      postId,
      platform: 'instagram',
      success: false,
    };

    try {
      // Check rate limit
      const rateLimit = await this.canPostToday();
      if (!rateLimit.canPost) {
        result.error = `Daily post limit reached (${rateLimit.limit})`;
        logger.warn('Cannot publish to Instagram - daily limit reached', { postId, limit: rateLimit.limit });
        return result;
      }

      // Get post
      const post = await this.getPost(postId);
      if (!post) {
        result.error = 'Post not found';
        return result;
      }

      if (post.status === 'PUBLISHED') {
        result.error = 'Post already published';
        return result;
      }

      // Get content
      const content = post.content_final || post.content_draft;
      if (!content) {
        result.error = 'No content to post';
        return result;
      }

      // Ensure content is within Instagram's 2200 character limit
      const caption = content.length > 2200 ? content.substring(0, 2197) + '...' : content;

      // Get credentials
      const credentials = await this.getInstagramCredentials();
      if (!credentials) {
        result.error = 'Instagram credentials not configured';
        return result;
      }

      // Get media URLs - Instagram REQUIRES an image
      const mediaUrls = await this.getPostMediaUrls(post);
      if (mediaUrls.length === 0) {
        result.error = 'Instagram requires an image for posts';
        return result;
      }

      // Create the post on Instagram (two-step process)
      const instagramResponse = await this.createInstagramPost(
        credentials.instagramAccountId,
        credentials.accessToken,
        caption,
        mediaUrls[0]
      );

      // Build the post URL
      const postUrl = `https://www.instagram.com/p/${instagramResponse.shortcode || ''}`;

      // Update post status
      const supabase = getSupabaseClient();
      await supabase
        .from('social_posts')
        .update({
          status: 'PUBLISHED',
          content_final: caption,
          external_post_id: instagramResponse.id,
          published_at: new Date().toISOString(),
        })
        .eq('id', postId);

      await logActivity(
        'POST_PUBLISHED',
        `Published to Instagram: ${instagramResponse.id}`,
        'SocialPost',
        postId,
        { instagramPostId: instagramResponse.id, instagramUrl: postUrl }
      );

      result.success = true;
      result.externalPostId = instagramResponse.id;
      result.externalPostUrl = postUrl;

      logger.info('Successfully published to Instagram', {
        postId,
        instagramPostId: instagramResponse.id,
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';

      await this.updatePostStatus(postId, 'FAILED', undefined, result.error);

      await logActivity(
        'POST_FAILED',
        `Failed to publish to Instagram: ${result.error}`,
        'SocialPost',
        postId
      );

      logger.error('Failed to publish to Instagram', { postId, error: result.error });
    }

    return result;
  }

  /**
   * Create an Instagram post (two-step: container creation + publish)
   */
  private async createInstagramPost(
    accountId: string,
    accessToken: string,
    caption: string,
    imageUrl: string
  ): Promise<{ id: string; shortcode?: string }> {
    try {
      // Step 1: Create media container
      const containerResponse = await axios.post(
        `${INSTAGRAM_GRAPH_URL}/${accountId}/media`,
        {
          image_url: imageUrl,
          caption,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const containerId = containerResponse.data.id;
      logger.debug('Created Instagram media container', { containerId });

      // Step 2: Wait for container to be ready (optional polling)
      await this.waitForContainerReady(containerId, accessToken);

      // Step 3: Publish the container
      const publishResponse = await axios.post(
        `${INSTAGRAM_GRAPH_URL}/${accountId}/media_publish`,
        {
          creation_id: containerId,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const mediaId = publishResponse.data.id;

      // Get the shortcode for the URL
      let shortcode: string | undefined;
      try {
        const mediaDetails = await axios.get(
          `${INSTAGRAM_GRAPH_URL}/${mediaId}`,
          {
            params: {
              fields: 'shortcode,permalink',
              access_token: accessToken,
            },
          }
        );
        shortcode = mediaDetails.data.shortcode;
      } catch {
        logger.warn('Could not fetch Instagram shortcode', { mediaId });
      }

      return { id: mediaId, shortcode };
    } catch (error) {
      const axiosError = error as AxiosError<{ error?: { message: string; code?: number } }>;
      const errorMessage = axiosError.response?.data?.error?.message || axiosError.message;

      logger.error('Instagram API error', {
        status: axiosError.response?.status,
        message: errorMessage,
        code: axiosError.response?.data?.error?.code,
      });

      throw new Error(`Instagram API error: ${errorMessage}`);
    }
  }

  /**
   * Wait for media container to be ready
   */
  private async waitForContainerReady(
    containerId: string,
    accessToken: string,
    maxAttempts: number = 10
  ): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await axios.get(
          `${INSTAGRAM_GRAPH_URL}/${containerId}`,
          {
            params: {
              fields: 'status_code',
              access_token: accessToken,
            },
          }
        );

        const status = response.data.status_code;

        if (status === 'FINISHED') {
          return;
        }

        if (status === 'ERROR') {
          throw new Error('Media container creation failed');
        }

        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        if (attempt === maxAttempts - 1) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Assume ready if no error after max attempts
    logger.warn('Container status check timed out, proceeding anyway', { containerId });
  }

  /**
   * Test the Instagram connection
   */
  async testConnection(): Promise<{ success: boolean; details?: Record<string, unknown>; error?: string }> {
    try {
      const credentials = await this.getInstagramCredentials();

      if (!credentials) {
        return {
          success: false,
          error: 'Instagram credentials not configured',
        };
      }

      // Get account info to verify token
      const response = await axios.get(
        `${INSTAGRAM_GRAPH_URL}/${credentials.instagramAccountId}`,
        {
          params: {
            fields: 'id,username,name,profile_picture_url',
            access_token: credentials.accessToken,
          },
        }
      );

      return {
        success: true,
        details: {
          accountId: response.data.id,
          username: response.data.username,
          name: response.data.name,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get Instagram Business Account ID from Facebook Page
   */
  async getInstagramAccountFromPage(pageAccessToken: string, pageId: string): Promise<{
    instagramAccountId: string;
    username: string;
  }> {
    try {
      const response = await axios.get(
        `${INSTAGRAM_GRAPH_URL}/${pageId}`,
        {
          params: {
            fields: 'instagram_business_account{id,username}',
            access_token: pageAccessToken,
          },
        }
      );

      const igAccount = response.data.instagram_business_account;

      if (!igAccount) {
        throw new Error('No Instagram Business account linked to this Facebook Page');
      }

      return {
        instagramAccountId: igAccount.id,
        username: igAccount.username,
      };
    } catch (error) {
      const axiosError = error as AxiosError<{ error?: { message: string } }>;
      throw new Error(`Failed to get Instagram account: ${axiosError.response?.data?.error?.message || axiosError.message}`);
    }
  }

  /**
   * Create a carousel post (multiple images)
   */
  async createCarouselPost(
    postId: string,
    imageUrls: string[]
  ): Promise<PublishResult> {
    const result: PublishResult = {
      postId,
      platform: 'instagram',
      success: false,
    };

    if (imageUrls.length < 2 || imageUrls.length > 10) {
      result.error = 'Carousel requires 2-10 images';
      return result;
    }

    try {
      const credentials = await this.getInstagramCredentials();
      if (!credentials) {
        result.error = 'Instagram credentials not configured';
        return result;
      }

      const post = await this.getPost(postId);
      if (!post) {
        result.error = 'Post not found';
        return result;
      }

      const caption = (post.content_final || post.content_draft || '').substring(0, 2200);

      // Step 1: Create child containers for each image
      const childContainerIds: string[] = [];
      for (const imageUrl of imageUrls) {
        const childResponse = await axios.post(
          `${INSTAGRAM_GRAPH_URL}/${credentials.instagramAccountId}/media`,
          {
            image_url: imageUrl,
            is_carousel_item: true,
          },
          {
            headers: {
              Authorization: `Bearer ${credentials.accessToken}`,
              'Content-Type': 'application/json',
            },
          }
        );
        childContainerIds.push(childResponse.data.id);
      }

      // Step 2: Create carousel container
      const carouselResponse = await axios.post(
        `${INSTAGRAM_GRAPH_URL}/${credentials.instagramAccountId}/media`,
        {
          media_type: 'CAROUSEL',
          caption,
          children: childContainerIds.join(','),
        },
        {
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const carouselContainerId = carouselResponse.data.id;

      // Wait for container to be ready
      await this.waitForContainerReady(carouselContainerId, credentials.accessToken);

      // Step 3: Publish the carousel
      const publishResponse = await axios.post(
        `${INSTAGRAM_GRAPH_URL}/${credentials.instagramAccountId}/media_publish`,
        {
          creation_id: carouselContainerId,
        },
        {
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      result.success = true;
      result.externalPostId = publishResponse.data.id;

      // Update post status
      const supabase = getSupabaseClient();
      await supabase
        .from('social_posts')
        .update({
          status: 'PUBLISHED',
          external_post_id: publishResponse.data.id,
          published_at: new Date().toISOString(),
        })
        .eq('id', postId);

      logger.info('Successfully published Instagram carousel', {
        postId,
        instagramPostId: publishResponse.data.id,
        imageCount: imageUrls.length,
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to publish Instagram carousel', { postId, error: result.error });
    }

    return result;
  }
}

export const instagramPublisherService = new InstagramPublisherService();
