import axios, { AxiosError } from 'axios';
import { prisma } from '../config/database';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { encrypt, decrypt } from '../utils/crypto';
import type { PublishResult, LinkedInPostStatus } from '../types';

const LINKEDIN_API_BASE = 'https://api.linkedin.com/v2';
const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2';

interface LinkedInAPIError {
  message: string;
  status: number;
  serviceErrorCode?: number;
}

export class LinkedInPublisherService {
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
   * Get the current user's member URN
   */
  async getMemberUrn(accessToken: string): Promise<string> {
    try {
      const response = await axios.get(`${LINKEDIN_API_BASE}/userinfo`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      // The sub claim contains the member ID
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
   * Store token in database (encrypted)
   */
  async storeToken(
    memberUrn: string,
    accessToken: string,
    expiresIn: number,
    refreshToken?: string,
    scopes: string[] = []
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    await prisma.linkedInToken.upsert({
      where: { memberUrn },
      create: {
        memberUrn,
        accessToken: encrypt(accessToken),
        refreshToken: refreshToken ? encrypt(refreshToken) : null,
        expiresAt,
        scopes: JSON.stringify(scopes),
      },
      update: {
        accessToken: encrypt(accessToken),
        refreshToken: refreshToken ? encrypt(refreshToken) : null,
        expiresAt,
        scopes: JSON.stringify(scopes),
      },
    });

    logger.info('Stored LinkedIn token', { memberUrn, expiresAt });
  }

  /**
   * Get active access token
   */
  async getAccessToken(): Promise<string> {
    // First check environment variable
    if (config.linkedin.accessToken) {
      return config.linkedin.accessToken;
    }

    // Then check database
    const token = await prisma.linkedInToken.findFirst({
      where: {
        expiresAt: { gt: new Date() },
      },
      orderBy: { expiresAt: 'desc' },
    });

    if (!token) {
      throw new Error('No valid LinkedIn access token available. Please authenticate.');
    }

    return decrypt(token.accessToken);
  }

  /**
   * Get member URN
   */
  async getMemberUrnFromConfig(): Promise<string> {
    // First check environment variable
    if (config.linkedin.memberUrn) {
      return config.linkedin.memberUrn;
    }

    // Then check database
    const token = await prisma.linkedInToken.findFirst({
      where: {
        expiresAt: { gt: new Date() },
      },
      orderBy: { expiresAt: 'desc' },
    });

    if (!token) {
      throw new Error('No LinkedIn member URN available. Please authenticate.');
    }

    return token.memberUrn;
  }

  /**
   * Check if we can post today (rate limit)
   */
  async canPostToday(): Promise<{ canPost: boolean; remaining: number; limit: number }> {
    const criteria = await prisma.criteriaConfig.findFirst({
      where: { active: true },
    });

    const maxPerDay = criteria?.maxPostsPerDay || 3;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const postedToday = await prisma.linkedInPost.count({
      where: {
        status: 'PUBLISHED',
        createdAt: { gte: todayStart },
      },
    });

    return {
      canPost: postedToday < maxPerDay,
      remaining: Math.max(0, maxPerDay - postedToday),
      limit: maxPerDay,
    };
  }

  /**
   * Publish a LinkedIn post
   */
  async publishPost(postId: string): Promise<PublishResult> {
    const result: PublishResult = {
      postId,
      success: false,
    };

    try {
      // Check rate limit
      const rateLimit = await this.canPostToday();
      if (!rateLimit.canPost) {
        result.error = `Daily post limit reached (${rateLimit.limit})`;
        logger.warn('Cannot publish - daily limit reached', { postId, limit: rateLimit.limit });
        return result;
      }

      // Get post from database
      const post = await prisma.linkedInPost.findUnique({
        where: { id: postId },
        include: { article: true },
      });

      if (!post) {
        result.error = 'Post not found';
        return result;
      }

      if (post.status === 'PUBLISHED') {
        result.error = 'Post already published';
        return result;
      }

      // Get access token and member URN
      const accessToken = await this.getAccessToken();
      const memberUrn = await this.getMemberUrnFromConfig();

      // Mark as publishing
      await prisma.linkedInPost.update({
        where: { id: postId },
        data: { status: 'PUBLISHING' },
      });

      // Create the post on LinkedIn
      const linkedInResponse = await this.createLinkedInPost(
        accessToken,
        memberUrn,
        post.contentDraft
      );

      // Update post with LinkedIn info
      await prisma.linkedInPost.update({
        where: { id: postId },
        data: {
          status: 'PUBLISHED',
          contentFinal: post.contentDraft,
          linkedInPostUrn: linkedInResponse.id,
          linkedInPostUrl: linkedInResponse.activity
            ? `https://www.linkedin.com/feed/update/${linkedInResponse.activity}`
            : null,
        },
      });

      // Update article status
      await prisma.article.update({
        where: { id: post.articleId },
        data: { status: 'POSTED_TO_LINKEDIN' },
      });

      // Log activity
      await this.logActivity('POST_PUBLISHED', 'LinkedInPost', postId,
        `Published to LinkedIn: ${linkedInResponse.id}`);

      result.success = true;
      result.linkedInUrn = linkedInResponse.id;
      result.linkedInUrl = linkedInResponse.activity
        ? `https://www.linkedin.com/feed/update/${linkedInResponse.activity}`
        : undefined;

      logger.info('Successfully published to LinkedIn', {
        postId,
        linkedInUrn: linkedInResponse.id,
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';

      // Mark as failed
      await prisma.linkedInPost.update({
        where: { id: postId },
        data: {
          status: 'FAILED',
          errorMessage: result.error,
        },
      });

      await this.logActivity('POST_FAILED', 'LinkedInPost', postId,
        `Failed to publish: ${result.error}`);

      logger.error('Failed to publish to LinkedIn', { postId, error: result.error });
    }

    return result;
  }

  /**
   * Create a post on LinkedIn using the UGC API
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
      const errorCode = axiosError.response?.data?.serviceErrorCode;

      logger.error('LinkedIn API error', {
        status: axiosError.response?.status,
        message: errorMessage,
        serviceErrorCode: errorCode,
      });

      throw new Error(`LinkedIn API error: ${errorMessage}`);
    }
  }

  /**
   * Approve a post for publishing
   */
  async approvePost(postId: string): Promise<void> {
    await prisma.linkedInPost.update({
      where: { id: postId },
      data: { status: 'APPROVED' },
    });

    await this.logActivity('POST_APPROVED', 'LinkedInPost', postId, 'Post approved for publishing');
    logger.info('Post approved', { postId });
  }

  /**
   * Reject a post
   */
  async rejectPost(postId: string, reason?: string): Promise<void> {
    await prisma.linkedInPost.update({
      where: { id: postId },
      data: {
        status: 'FAILED',
        errorMessage: reason || 'Rejected by reviewer',
      },
    });

    logger.info('Post rejected', { postId, reason });
  }

  /**
   * Publish all approved posts (respecting rate limits)
   */
  async publishApprovedPosts(): Promise<PublishResult[]> {
    const rateLimit = await this.canPostToday();
    if (!rateLimit.canPost) {
      logger.info('Daily post limit reached, skipping publication');
      return [];
    }

    const approvedPosts = await prisma.linkedInPost.findMany({
      where: {
        OR: [
          { status: 'APPROVED' },
          // Also pick up DRAFT posts in auto mode
          ...(config.autoPostToLinkedIn && !config.manualReviewMode
            ? [{ status: 'DRAFT' as LinkedInPostStatus }]
            : []),
        ],
      },
      take: rateLimit.remaining,
      orderBy: { createdAt: 'asc' },
    });

    const results: PublishResult[] = [];

    for (const post of approvedPosts) {
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
   * Test the LinkedIn connection
   */
  async testConnection(): Promise<{ success: boolean; memberUrn?: string; error?: string }> {
    try {
      const accessToken = await this.getAccessToken();
      const memberUrn = await this.getMemberUrn(accessToken);

      return { success: true, memberUrn };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Log activity
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
}

export const linkedInPublisherService = new LinkedInPublisherService();
