import axios, { AxiosError } from 'axios';
import { getSupabaseClient, logActivity } from '../config/supabase';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { encrypt, decrypt } from '../utils/crypto';
import { BasePublisherService, PublishResult, PlatformCredentials } from './BasePublisherService';

const LINKEDIN_API_BASE = 'https://api.linkedin.com/v2';
const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2';

interface LinkedInAPIError {
  message: string;
  status: number;
  serviceErrorCode?: number;
}

interface LinkedInCredentials extends PlatformCredentials {
  memberUrn: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scopes: string[];
}

export class LinkedInPublisherService extends BasePublisherService {
  constructor() {
    super('linkedin');
  }

  /**
   * Get OAuth authorization URL
   */
  getAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.linkedin.clientId,
      redirect_uri: config.linkedin.redirectUri,
      scope: 'openid profile email w_member_social',
      state: state || 'linkedin_auth',
    });

    return `${LINKEDIN_AUTH_URL}/authorization?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<{
    accessToken: string;
    expiresIn: number;
    refreshToken?: string;
  }> {
    try {
      const response = await axios.post(
        `${LINKEDIN_AUTH_URL}/accessToken`,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: config.linkedin.redirectUri,
          client_id: config.linkedin.clientId,
          client_secret: config.linkedin.clientSecret,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in,
        refreshToken: response.data.refresh_token,
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Failed to exchange code for token', {
        status: axiosError.response?.status,
        data: axiosError.response?.data,
      });
      throw new Error('Failed to exchange authorization code');
    }
  }

  /**
   * Get the current user's member URN from access token
   */
  async fetchMemberUrn(accessToken: string): Promise<string> {
    try {
      const response = await axios.get(`${LINKEDIN_API_BASE}/userinfo`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const memberId = response.data.sub;
      return `urn:li:person:${memberId}`;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Failed to get member URN', {
        status: axiosError.response?.status,
      });
      throw new Error('Failed to get LinkedIn member info');
    }
  }

  /**
   * Store credentials after OAuth
   */
  async storeCredentialsFromOAuth(
    accessToken: string,
    expiresIn: number,
    refreshToken?: string,
    scopes: string[] = []
  ): Promise<void> {
    const memberUrn = await this.fetchMemberUrn(accessToken);
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    const credentials: LinkedInCredentials = {
      memberUrn,
      accessToken: encrypt(accessToken),
      refreshToken: refreshToken ? encrypt(refreshToken) : undefined,
      expiresAt: expiresAt.toISOString(),
      scopes,
    };

    await this.saveCredentials(credentials);
    logger.info('Stored LinkedIn credentials', { memberUrn, expiresAt });
  }

  /**
   * Get active access token
   */
  async getAccessToken(): Promise<string> {
    // First check environment variable
    if (config.linkedin.accessToken) {
      return config.linkedin.accessToken;
    }

    // Then check Supabase
    const credentials = await this.getCredentials() as LinkedInCredentials | null;

    if (!credentials) {
      throw new Error('No LinkedIn credentials available. Please authenticate.');
    }

    // Check if expired
    if (new Date(credentials.expiresAt) <= new Date()) {
      throw new Error('LinkedIn access token expired. Please re-authenticate.');
    }

    return decrypt(credentials.accessToken);
  }

  /**
   * Get member URN
   */
  async getMemberUrn(): Promise<string> {
    // First check environment variable
    if (config.linkedin.memberUrn) {
      return config.linkedin.memberUrn;
    }

    // Then check Supabase
    const credentials = await this.getCredentials() as LinkedInCredentials | null;

    if (!credentials) {
      throw new Error('No LinkedIn member URN available. Please authenticate.');
    }

    return credentials.memberUrn;
  }

  /**
   * Publish a post to LinkedIn
   */
  async publishPost(postId: string): Promise<PublishResult> {
    const result: PublishResult = {
      postId,
      platform: 'linkedin',
      success: false,
    };

    try {
      // Check rate limit
      const rateLimit = await this.canPostToday();
      if (!rateLimit.canPost) {
        result.error = `Daily post limit reached (${rateLimit.limit})`;
        logger.warn('Cannot publish to LinkedIn - daily limit reached', { postId, limit: rateLimit.limit });
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

      // Get content to post
      const content = post.content_final || post.content_draft;
      if (!content) {
        result.error = 'No content to post';
        return result;
      }

      // Get credentials
      const accessToken = await this.getAccessToken();
      const memberUrn = await this.getMemberUrn();

      // Get media URLs if any
      const mediaUrls = await this.getPostMediaUrls(post);

      // Create the post on LinkedIn
      let linkedInResponse: { id: string; activity?: string };

      if (mediaUrls.length > 0) {
        // Post with image
        linkedInResponse = await this.createLinkedInPostWithImage(
          accessToken,
          memberUrn,
          content,
          mediaUrls[0] // LinkedIn only supports one image via UGC
        );
      } else {
        // Text-only post
        linkedInResponse = await this.createLinkedInPost(
          accessToken,
          memberUrn,
          content
        );
      }

      // Build the post URL
      const postUrl = linkedInResponse.activity
        ? `https://www.linkedin.com/feed/update/${linkedInResponse.activity}`
        : undefined;

      // Update post status
      const supabase = getSupabaseClient();
      await supabase
        .from('social_posts')
        .update({
          status: 'PUBLISHED',
          content_final: content,
          external_post_id: linkedInResponse.id,
          published_at: new Date().toISOString(),
        })
        .eq('id', postId);

      await logActivity(
        'POST_PUBLISHED',
        `Published to LinkedIn: ${linkedInResponse.id}`,
        'SocialPost',
        postId,
        { linkedInUrn: linkedInResponse.id, linkedInUrl: postUrl }
      );

      result.success = true;
      result.externalPostId = linkedInResponse.id;
      result.externalPostUrl = postUrl;

      logger.info('Successfully published to LinkedIn', {
        postId,
        linkedInUrn: linkedInResponse.id,
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';

      await this.updatePostStatus(postId, 'FAILED', undefined, result.error);

      await logActivity(
        'POST_FAILED',
        `Failed to publish to LinkedIn: ${result.error}`,
        'SocialPost',
        postId
      );

      logger.error('Failed to publish to LinkedIn', { postId, error: result.error });
    }

    return result;
  }

  /**
   * Create a text-only post on LinkedIn
   */
  private async createLinkedInPost(
    accessToken: string,
    memberUrn: string,
    text: string
  ): Promise<{ id: string; activity?: string }> {
    const payload = {
      author: memberUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    };

    try {
      const response = await axios.post(
        `${LINKEDIN_API_BASE}/ugcPosts`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
          },
        }
      );

      return {
        id: response.data.id,
        activity: response.headers['x-restli-id'],
      };
    } catch (error) {
      const axiosError = error as AxiosError<LinkedInAPIError>;
      const errorMessage = axiosError.response?.data?.message || axiosError.message;

      logger.error('LinkedIn API error', {
        status: axiosError.response?.status,
        message: errorMessage,
        serviceErrorCode: axiosError.response?.data?.serviceErrorCode,
      });

      throw new Error(`LinkedIn API error: ${errorMessage}`);
    }
  }

  /**
   * Create a post with image on LinkedIn
   */
  private async createLinkedInPostWithImage(
    accessToken: string,
    memberUrn: string,
    text: string,
    imageUrl: string
  ): Promise<{ id: string; activity?: string }> {
    // For now, we'll use a link share with the image URL
    // Full image upload requires more complex flow with registerUpload
    const payload = {
      author: memberUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: 'ARTICLE',
          media: [
            {
              status: 'READY',
              originalUrl: imageUrl,
            },
          ],
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    };

    try {
      const response = await axios.post(
        `${LINKEDIN_API_BASE}/ugcPosts`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
          },
        }
      );

      return {
        id: response.data.id,
        activity: response.headers['x-restli-id'],
      };
    } catch (error) {
      // If image post fails, try text-only
      logger.warn('Image post failed, trying text-only', { error });
      return this.createLinkedInPost(accessToken, memberUrn, text);
    }
  }

  /**
   * Test the LinkedIn connection
   */
  async testConnection(): Promise<{ success: boolean; details?: Record<string, unknown>; error?: string }> {
    try {
      const accessToken = await this.getAccessToken();
      const memberUrn = await this.fetchMemberUrn(accessToken);

      return {
        success: true,
        details: { memberUrn },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

export const linkedInPublisherService = new LinkedInPublisherService();
