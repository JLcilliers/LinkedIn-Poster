import axios, { AxiosError } from 'axios';
import crypto from 'crypto';
import OAuth from 'oauth-1.0a';
import { getSupabaseClient, logActivity } from '../config/supabase';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { encrypt, decrypt } from '../utils/crypto';
import { BasePublisherService, PublishResult, PlatformCredentials } from './BasePublisherService';

const X_API_BASE = 'https://api.twitter.com/2';
const X_UPLOAD_URL = 'https://upload.twitter.com/1.1/media/upload.json';

interface XCredentials extends PlatformCredentials {
  accessToken: string;
  accessTokenSecret: string;
  userId?: string;
  username?: string;
}

export class XPublisherService extends BasePublisherService {
  private oauth: OAuth;

  constructor() {
    super('x');

    // Initialize OAuth 1.0a for X API
    this.oauth = new OAuth({
      consumer: {
        key: config.x.apiKey,
        secret: config.x.apiSecret,
      },
      signature_method: 'HMAC-SHA1',
      hash_function(baseString: string, key: string) {
        return crypto
          .createHmac('sha1', key)
          .update(baseString)
          .digest('base64');
      },
    });
  }

  /**
   * Store X credentials
   */
  async storeCredentials(credentials: {
    accessToken: string;
    accessTokenSecret: string;
    userId?: string;
    username?: string;
  }): Promise<void> {
    const xCredentials: XCredentials = {
      accessToken: encrypt(credentials.accessToken),
      accessTokenSecret: encrypt(credentials.accessTokenSecret),
      userId: credentials.userId,
      username: credentials.username,
    };

    await super.saveCredentials(xCredentials);
    logger.info('Stored X credentials', { userId: credentials.userId, username: credentials.username });
  }

  /**
   * Get X credentials
   */
  async getXCredentials(): Promise<XCredentials | null> {
    // First check environment variables
    if (config.x.accessToken && config.x.accessTokenSecret) {
      return {
        accessToken: config.x.accessToken,
        accessTokenSecret: config.x.accessTokenSecret,
        userId: config.x.userId,
      };
    }

    // Then check Supabase
    const credentials = await this.getCredentials() as XCredentials | null;

    if (!credentials) {
      return null;
    }

    // Decrypt sensitive fields
    return {
      ...credentials,
      accessToken: credentials.accessToken ? decrypt(credentials.accessToken) : '',
      accessTokenSecret: credentials.accessTokenSecret ? decrypt(credentials.accessTokenSecret) : '',
    };
  }

  /**
   * Generate OAuth headers for a request
   */
  private getOAuthHeaders(
    url: string,
    method: string,
    credentials: XCredentials
  ): Record<string, string> {
    const token = {
      key: credentials.accessToken,
      secret: credentials.accessTokenSecret,
    };

    const authHeader = this.oauth.toHeader(
      this.oauth.authorize({ url, method }, token)
    );

    return {
      ...authHeader,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Publish a post to X (Twitter)
   */
  async publishPost(postId: string): Promise<PublishResult> {
    const result: PublishResult = {
      postId,
      platform: 'x',
      success: false,
    };

    try {
      // Check rate limit
      const rateLimit = await this.canPostToday();
      if (!rateLimit.canPost) {
        result.error = `Daily post limit reached (${rateLimit.limit})`;
        logger.warn('Cannot publish to X - daily limit reached', { postId, limit: rateLimit.limit });
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

      // Ensure content is within X's 280 character limit
      const tweetText = content.length > 280 ? content.substring(0, 277) + '...' : content;

      // Get credentials
      const credentials = await this.getXCredentials();
      if (!credentials) {
        result.error = 'X credentials not configured';
        return result;
      }

      // Get media URLs if any
      const mediaUrls = await this.getPostMediaUrls(post);

      // Create the tweet
      let xResponse: { id: string; text: string };

      if (mediaUrls.length > 0) {
        // Upload media first, then tweet with media
        xResponse = await this.createTweetWithMedia(
          credentials,
          tweetText,
          mediaUrls[0]
        );
      } else {
        // Text-only tweet
        xResponse = await this.createTweet(credentials, tweetText);
      }

      // Build the tweet URL
      const tweetUrl = credentials.username
        ? `https://x.com/${credentials.username}/status/${xResponse.id}`
        : `https://x.com/i/web/status/${xResponse.id}`;

      // Update post status
      const supabase = getSupabaseClient();
      await supabase
        .from('social_posts')
        .update({
          status: 'PUBLISHED',
          content_final: tweetText,
          external_post_id: xResponse.id,
          published_at: new Date().toISOString(),
        })
        .eq('id', postId);

      await logActivity(
        'POST_PUBLISHED',
        `Published to X: ${xResponse.id}`,
        'SocialPost',
        postId,
        { tweetId: xResponse.id, tweetUrl }
      );

      result.success = true;
      result.externalPostId = xResponse.id;
      result.externalPostUrl = tweetUrl;

      logger.info('Successfully published to X', {
        postId,
        tweetId: xResponse.id,
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';

      await this.updatePostStatus(postId, 'FAILED', undefined, result.error);

      await logActivity(
        'POST_FAILED',
        `Failed to publish to X: ${result.error}`,
        'SocialPost',
        postId
      );

      logger.error('Failed to publish to X', { postId, error: result.error });
    }

    return result;
  }

  /**
   * Create a text-only tweet using X API v2
   */
  private async createTweet(
    credentials: XCredentials,
    text: string
  ): Promise<{ id: string; text: string }> {
    const url = `${X_API_BASE}/tweets`;
    const method = 'POST';

    try {
      const response = await axios.post(
        url,
        { text },
        {
          headers: this.getOAuthHeaders(url, method, credentials),
        }
      );

      return {
        id: response.data.data.id,
        text: response.data.data.text,
      };
    } catch (error) {
      const axiosError = error as AxiosError<{ errors?: Array<{ message: string; code?: number }> }>;
      const errorMessage = axiosError.response?.data?.errors?.[0]?.message || axiosError.message;

      logger.error('X API error', {
        status: axiosError.response?.status,
        message: errorMessage,
      });

      throw new Error(`X API error: ${errorMessage}`);
    }
  }

  /**
   * Create a tweet with media
   */
  private async createTweetWithMedia(
    credentials: XCredentials,
    text: string,
    imageUrl: string
  ): Promise<{ id: string; text: string }> {
    try {
      // First, upload the media
      const mediaId = await this.uploadMedia(credentials, imageUrl);

      // Then create the tweet with the media ID
      const url = `${X_API_BASE}/tweets`;
      const method = 'POST';

      const response = await axios.post(
        url,
        {
          text,
          media: {
            media_ids: [mediaId],
          },
        },
        {
          headers: this.getOAuthHeaders(url, method, credentials),
        }
      );

      return {
        id: response.data.data.id,
        text: response.data.data.text,
      };
    } catch (error) {
      // If media upload fails, try text-only tweet
      logger.warn('Media upload failed, trying text-only tweet', { error });
      return this.createTweet(credentials, text);
    }
  }

  /**
   * Upload media to X (Twitter)
   */
  private async uploadMedia(
    credentials: XCredentials,
    imageUrl: string
  ): Promise<string> {
    // Download the image first
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);
    const base64Image = imageBuffer.toString('base64');

    // Determine media type from URL or default to jpeg
    const mediaType = imageUrl.includes('.png') ? 'image/png' :
                      imageUrl.includes('.gif') ? 'image/gif' : 'image/jpeg';

    // Upload using v1.1 media upload endpoint
    const token = {
      key: credentials.accessToken,
      secret: credentials.accessTokenSecret,
    };

    const formData = new URLSearchParams();
    formData.append('media_data', base64Image);

    const authHeader = this.oauth.toHeader(
      this.oauth.authorize({
        url: X_UPLOAD_URL,
        method: 'POST',
      }, token)
    );

    const response = await axios.post(
      X_UPLOAD_URL,
      formData.toString(),
      {
        headers: {
          ...authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    return response.data.media_id_string;
  }

  /**
   * Test the X connection
   */
  async testConnection(): Promise<{ success: boolean; details?: Record<string, unknown>; error?: string }> {
    try {
      const credentials = await this.getXCredentials();

      if (!credentials) {
        return {
          success: false,
          error: 'X credentials not configured',
        };
      }

      // Get user info to verify token
      const url = `${X_API_BASE}/users/me`;
      const method = 'GET';

      const response = await axios.get(url, {
        headers: this.getOAuthHeaders(url, method, credentials),
      });

      return {
        success: true,
        details: {
          userId: response.data.data.id,
          username: response.data.data.username,
          name: response.data.data.name,
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
   * Create a thread (multiple connected tweets)
   */
  async createThread(
    postId: string,
    tweets: string[]
  ): Promise<PublishResult> {
    const result: PublishResult = {
      postId,
      platform: 'x',
      success: false,
    };

    if (tweets.length === 0) {
      result.error = 'No tweets provided for thread';
      return result;
    }

    try {
      const credentials = await this.getXCredentials();
      if (!credentials) {
        result.error = 'X credentials not configured';
        return result;
      }

      const tweetIds: string[] = [];
      let previousTweetId: string | undefined;

      for (const tweetText of tweets) {
        const text = tweetText.length > 280 ? tweetText.substring(0, 277) + '...' : tweetText;

        const url = `${X_API_BASE}/tweets`;
        const method = 'POST';

        const payload: Record<string, unknown> = { text };
        if (previousTweetId) {
          payload.reply = { in_reply_to_tweet_id: previousTweetId };
        }

        const response = await axios.post(
          url,
          payload,
          {
            headers: this.getOAuthHeaders(url, method, credentials),
          }
        );

        previousTweetId = response.data.data.id;
        tweetIds.push(previousTweetId);
      }

      // Update post status with first tweet ID
      const supabase = getSupabaseClient();
      await supabase
        .from('social_posts')
        .update({
          status: 'PUBLISHED',
          external_post_id: tweetIds[0],
          published_at: new Date().toISOString(),
        })
        .eq('id', postId);

      result.success = true;
      result.externalPostId = tweetIds[0];
      result.externalPostUrl = credentials.username
        ? `https://x.com/${credentials.username}/status/${tweetIds[0]}`
        : `https://x.com/i/web/status/${tweetIds[0]}`;

      logger.info('Successfully published X thread', {
        postId,
        tweetCount: tweetIds.length,
        firstTweetId: tweetIds[0],
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to publish X thread', { postId, error: result.error });
    }

    return result;
  }

  /**
   * Split long content into multiple tweets for a thread
   */
  splitIntoThread(content: string, maxLength: number = 280): string[] {
    const tweets: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        tweets.push(remaining);
        break;
      }

      // Find a good breaking point
      let breakPoint = maxLength;
      const lastSpace = remaining.substring(0, maxLength).lastIndexOf(' ');
      const lastNewline = remaining.substring(0, maxLength).lastIndexOf('\n');
      const lastPeriod = remaining.substring(0, maxLength).lastIndexOf('.');

      if (lastNewline > maxLength * 0.5) {
        breakPoint = lastNewline;
      } else if (lastPeriod > maxLength * 0.7) {
        breakPoint = lastPeriod + 1;
      } else if (lastSpace > maxLength * 0.5) {
        breakPoint = lastSpace;
      }

      tweets.push(remaining.substring(0, breakPoint).trim());
      remaining = remaining.substring(breakPoint).trim();
    }

    // Add thread numbering if more than 1 tweet
    if (tweets.length > 1) {
      return tweets.map((tweet, i) => {
        const prefix = `${i + 1}/${tweets.length} `;
        const maxContent = maxLength - prefix.length;
        const truncated = tweet.length > maxContent
          ? tweet.substring(0, maxContent - 3) + '...'
          : tweet;
        return prefix + truncated;
      });
    }

    return tweets;
  }
}

export const xPublisherService = new XPublisherService();
