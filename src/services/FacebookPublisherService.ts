import axios, { AxiosError } from 'axios';
import { getSupabaseClient, logActivity } from '../config/supabase';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { encrypt, decrypt } from '../utils/crypto';
import { BasePublisherService, PublishResult, PlatformCredentials } from './BasePublisherService';

const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com/v18.0';

interface FacebookCredentials extends PlatformCredentials {
  appId: string;
  appSecret: string;
  pageId: string;
  pageAccessToken: string;
  tokenExpiresAt?: string;
}

export class FacebookPublisherService extends BasePublisherService {
  constructor() {
    super('facebook');
  }

  /**
   * Store Facebook credentials
   */
  async storeCredentials(credentials: {
    appId: string;
    appSecret: string;
    pageId: string;
    pageAccessToken: string;
    tokenExpiresAt?: Date;
  }): Promise<void> {
    const fbCredentials: FacebookCredentials = {
      appId: credentials.appId,
      appSecret: encrypt(credentials.appSecret),
      pageId: credentials.pageId,
      pageAccessToken: encrypt(credentials.pageAccessToken),
      tokenExpiresAt: credentials.tokenExpiresAt?.toISOString(),
    };

    await super.saveCredentials(fbCredentials);
    logger.info('Stored Facebook credentials', { pageId: credentials.pageId });
  }

  /**
   * Get Facebook credentials
   */
  async getFacebookCredentials(): Promise<FacebookCredentials | null> {
    // First check environment variables
    if (config.facebook.pageAccessToken && config.facebook.pageId) {
      return {
        appId: config.facebook.appId,
        appSecret: config.facebook.appSecret,
        pageId: config.facebook.pageId,
        pageAccessToken: config.facebook.pageAccessToken,
      };
    }

    // Then check Supabase
    const credentials = await this.getCredentials() as FacebookCredentials | null;

    if (!credentials) {
      return null;
    }

    // Decrypt sensitive fields
    return {
      ...credentials,
      appSecret: credentials.appSecret ? decrypt(credentials.appSecret) : '',
      pageAccessToken: credentials.pageAccessToken ? decrypt(credentials.pageAccessToken) : '',
    };
  }

  /**
   * Publish a post to Facebook Page
   */
  async publishPost(postId: string): Promise<PublishResult> {
    const result: PublishResult = {
      postId,
      platform: 'facebook',
      success: false,
    };

    try {
      // Check rate limit
      const rateLimit = await this.canPostToday();
      if (!rateLimit.canPost) {
        result.error = `Daily post limit reached (${rateLimit.limit})`;
        logger.warn('Cannot publish to Facebook - daily limit reached', { postId, limit: rateLimit.limit });
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

      // Get credentials
      const credentials = await this.getFacebookCredentials();
      if (!credentials) {
        result.error = 'Facebook credentials not configured';
        return result;
      }

      // Get media URLs if any
      const mediaUrls = await this.getPostMediaUrls(post);

      // Create the post on Facebook
      let facebookResponse: { id: string };

      if (mediaUrls.length > 0) {
        // Post with photo
        facebookResponse = await this.createPhotoPost(
          credentials.pageId,
          credentials.pageAccessToken,
          content,
          mediaUrls[0]
        );
      } else {
        // Text-only post
        facebookResponse = await this.createTextPost(
          credentials.pageId,
          credentials.pageAccessToken,
          content
        );
      }

      // Build the post URL
      const postUrl = `https://www.facebook.com/${facebookResponse.id.replace('_', '/posts/')}`;

      // Update post status
      const supabase = getSupabaseClient();
      await supabase
        .from('social_posts')
        .update({
          status: 'PUBLISHED',
          content_final: content,
          external_post_id: facebookResponse.id,
          published_at: new Date().toISOString(),
        })
        .eq('id', postId);

      await logActivity(
        'POST_PUBLISHED',
        `Published to Facebook: ${facebookResponse.id}`,
        'SocialPost',
        postId,
        { facebookPostId: facebookResponse.id, facebookUrl: postUrl }
      );

      result.success = true;
      result.externalPostId = facebookResponse.id;
      result.externalPostUrl = postUrl;

      logger.info('Successfully published to Facebook', {
        postId,
        facebookPostId: facebookResponse.id,
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';

      await this.updatePostStatus(postId, 'FAILED', undefined, result.error);

      await logActivity(
        'POST_FAILED',
        `Failed to publish to Facebook: ${result.error}`,
        'SocialPost',
        postId
      );

      logger.error('Failed to publish to Facebook', { postId, error: result.error });
    }

    return result;
  }

  /**
   * Create a text-only post on Facebook Page
   */
  private async createTextPost(
    pageId: string,
    accessToken: string,
    message: string
  ): Promise<{ id: string }> {
    try {
      const response = await axios.post(
        `${FACEBOOK_GRAPH_URL}/${pageId}/feed`,
        {
          message,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return { id: response.data.id };
    } catch (error) {
      const axiosError = error as AxiosError<{ error?: { message: string } }>;
      const errorMessage = axiosError.response?.data?.error?.message || axiosError.message;

      logger.error('Facebook API error', {
        status: axiosError.response?.status,
        message: errorMessage,
      });

      throw new Error(`Facebook API error: ${errorMessage}`);
    }
  }

  /**
   * Create a photo post on Facebook Page
   */
  private async createPhotoPost(
    pageId: string,
    accessToken: string,
    message: string,
    imageUrl: string
  ): Promise<{ id: string }> {
    try {
      const response = await axios.post(
        `${FACEBOOK_GRAPH_URL}/${pageId}/photos`,
        {
          url: imageUrl,
          caption: message,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return { id: response.data.post_id || response.data.id };
    } catch (error) {
      // If photo post fails, try text-only with link
      logger.warn('Photo post failed, trying text-only with link', { error });
      return this.createTextPost(pageId, accessToken, `${message}\n\n${imageUrl}`);
    }
  }

  /**
   * Test the Facebook connection
   */
  async testConnection(): Promise<{ success: boolean; details?: Record<string, unknown>; error?: string }> {
    try {
      const credentials = await this.getFacebookCredentials();

      if (!credentials) {
        return {
          success: false,
          error: 'Facebook credentials not configured',
        };
      }

      // Get page info to verify token
      const response = await axios.get(
        `${FACEBOOK_GRAPH_URL}/${credentials.pageId}`,
        {
          params: {
            fields: 'id,name,access_token',
            access_token: credentials.pageAccessToken,
          },
        }
      );

      return {
        success: true,
        details: {
          pageId: response.data.id,
          pageName: response.data.name,
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
   * Exchange short-lived token for long-lived token
   */
  async exchangeForLongLivedToken(shortLivedToken: string): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    const credentials = await this.getFacebookCredentials();

    if (!credentials) {
      throw new Error('Facebook app credentials not configured');
    }

    try {
      const response = await axios.get(`${FACEBOOK_GRAPH_URL}/oauth/access_token`, {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: credentials.appId,
          client_secret: credentials.appSecret,
          fb_exchange_token: shortLivedToken,
        },
      });

      return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in || 5184000, // ~60 days
      };
    } catch (error) {
      const axiosError = error as AxiosError<{ error?: { message: string } }>;
      throw new Error(`Token exchange failed: ${axiosError.response?.data?.error?.message || axiosError.message}`);
    }
  }

  /**
   * Get page access token from user access token
   */
  async getPageAccessToken(userAccessToken: string, pageId?: string): Promise<{
    pageId: string;
    pageName: string;
    pageAccessToken: string;
  }> {
    try {
      const response = await axios.get(`${FACEBOOK_GRAPH_URL}/me/accounts`, {
        params: {
          access_token: userAccessToken,
        },
      });

      const pages = response.data.data;

      if (!pages || pages.length === 0) {
        throw new Error('No pages found for this user');
      }

      // If pageId specified, find that page; otherwise use first page
      const page = pageId
        ? pages.find((p: { id: string }) => p.id === pageId)
        : pages[0];

      if (!page) {
        throw new Error(`Page ${pageId} not found`);
      }

      return {
        pageId: page.id,
        pageName: page.name,
        pageAccessToken: page.access_token,
      };
    } catch (error) {
      const axiosError = error as AxiosError<{ error?: { message: string } }>;
      throw new Error(`Failed to get page access token: ${axiosError.response?.data?.error?.message || axiosError.message}`);
    }
  }
}

export const facebookPublisherService = new FacebookPublisherService();
