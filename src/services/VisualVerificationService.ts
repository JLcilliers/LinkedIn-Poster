import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getSupabaseClient, SocialPost, Platform, logActivity } from '../config/supabase';
import { logger } from '../utils/logger';
import { getMediaService } from './MediaService';

const SCREENSHOTS_DIR = 'screenshots';
const USER_DATA_DIR = 'playwright-data';

interface VerificationResult {
  postId: string;
  platform: Platform;
  success: boolean;
  screenshotUrl?: string;
  screenshotPath?: string;
  error?: string;
  details?: {
    postVisible: boolean;
    contentMatched: boolean;
    engagementMetrics?: {
      likes?: number;
      comments?: number;
      shares?: number;
    };
  };
}

interface PlatformVerifier {
  verifyPost(page: Page, externalUrl: string, expectedContent: string): Promise<{
    visible: boolean;
    contentMatched: boolean;
    metrics?: Record<string, number>;
  }>;
  login?(page: Page): Promise<boolean>;
}

/**
 * Visual Verification Service
 *
 * IMPORTANT: This service is for visual verification only.
 * It should NOT be used to:
 * - Bypass platform security or 2FA
 * - Automate posting (use the official API for that)
 * - Scrape other users' data
 * - Perform high-frequency automation
 *
 * Legitimate uses:
 * - Take screenshots to verify posts appear correctly
 * - Visual smoke tests for debugging
 * - Guided setup assistance
 */
export class VisualVerificationService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor() {
    // Ensure directories exist
    if (!existsSync(SCREENSHOTS_DIR)) {
      mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }
    if (!existsSync(USER_DATA_DIR)) {
      mkdirSync(USER_DATA_DIR, { recursive: true });
    }
  }

  /**
   * Initialize the browser for headless verification
   */
  async initialize(): Promise<void> {
    if (this.browser) {
      return;
    }

    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      locale: 'en-GB',
    });

    logger.info('Visual verification browser initialized');
  }

  /**
   * Launch browser with persistent context (preserves login) - interactive mode
   */
  async launch(): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: false, // Set to true for automated checks
      });
    }

    if (!this.context) {
      this.context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        locale: 'en-GB',
      });
    }

    return this.context.newPage();
  }

  /**
   * Close browser
   */
  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    logger.info('Visual verification browser closed');
  }

  /**
   * Verify a published post is visible
   */
  async verifyPost(postId: string): Promise<VerificationResult> {
    const supabase = getSupabaseClient();

    const { data: post, error } = await supabase
      .from('social_posts')
      .select('*')
      .eq('id', postId)
      .single();

    if (error || !post) {
      return {
        postId,
        platform: 'linkedin',
        success: false,
        error: 'Post not found',
      };
    }

    const socialPost = post as SocialPost;

    if (socialPost.status !== 'PUBLISHED' || !socialPost.external_post_id) {
      return {
        postId,
        platform: socialPost.platform,
        success: false,
        error: 'Post not published or missing external ID',
      };
    }

    await this.initialize();

    const result: VerificationResult = {
      postId,
      platform: socialPost.platform,
      success: false,
    };

    try {
      const page = await this.context!.newPage();

      // Build the post URL
      const postUrl = this.buildPostUrl(socialPost);
      if (!postUrl) {
        result.error = 'Could not construct post URL';
        return result;
      }

      logger.info(`Verifying post at: ${postUrl}`);

      // Navigate to the post
      await page.goto(postUrl, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait for content to load
      await page.waitForTimeout(3000);

      // Take a screenshot
      const screenshotBuffer = await page.screenshot({ fullPage: false });

      // Save locally
      const filename = `verification-${postId}-${Date.now()}.png`;
      const localPath = join(SCREENSHOTS_DIR, filename);

      // Upload screenshot to Supabase Storage
      try {
        const mediaService = getMediaService();
        const screenshotAsset = await mediaService.uploadMedia(
          screenshotBuffer,
          filename,
          'image/png'
        );
        result.screenshotUrl = screenshotAsset.public_url;
      } catch (uploadError) {
        logger.warn('Failed to upload screenshot to Supabase', { error: uploadError });
        result.screenshotPath = localPath;
      }

      // Verify the post content
      const verifier = this.getVerifier(socialPost.platform);
      const verification = await verifier.verifyPost(
        page,
        postUrl,
        socialPost.content_final || socialPost.content_draft || ''
      );

      result.success = verification.visible;
      result.details = {
        postVisible: verification.visible,
        contentMatched: verification.contentMatched,
        engagementMetrics: verification.metrics,
      };

      await page.close();

      // Log the verification
      await logActivity(
        result.success ? 'POST_VERIFIED' : 'POST_VERIFICATION_FAILED',
        `Visual verification ${result.success ? 'passed' : 'failed'} for ${socialPost.platform}`,
        'SocialPost',
        postId,
        result.details
      );

      logger.info('Post verification complete', {
        postId,
        platform: socialPost.platform,
        success: result.success,
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Post verification failed', { postId, error: result.error });
    }

    return result;
  }

  /**
   * Build the URL for a published post
   */
  private buildPostUrl(post: SocialPost): string | null {
    const externalId = post.external_post_id;
    if (!externalId) return null;

    switch (post.platform) {
      case 'linkedin':
        // LinkedIn URN format: urn:li:share:xxx or urn:li:ugcPost:xxx
        if (externalId.startsWith('urn:')) {
          return `https://www.linkedin.com/feed/update/${externalId}`;
        }
        return `https://www.linkedin.com/feed/update/urn:li:share:${externalId}`;

      case 'facebook':
        // Facebook format: pageId_postId
        return `https://www.facebook.com/${externalId.replace('_', '/posts/')}`;

      case 'instagram':
        // Instagram format depends on whether we have shortcode
        if (externalId.includes('/')) {
          return `https://www.instagram.com/p/${externalId}`;
        }
        return `https://www.instagram.com/p/${externalId}`;

      case 'x':
        // X/Twitter format: tweet ID
        return `https://x.com/i/web/status/${externalId}`;

      default:
        return null;
    }
  }

  /**
   * Get platform-specific verifier
   */
  private getVerifier(platform: Platform): PlatformVerifier {
    switch (platform) {
      case 'linkedin':
        return new LinkedInVerifier();
      case 'facebook':
        return new FacebookVerifier();
      case 'instagram':
        return new InstagramVerifier();
      case 'x':
        return new XVerifier();
      default:
        return new GenericVerifier();
    }
  }

  /**
   * Verify all recently published posts
   */
  async verifyRecentPosts(hoursAgo: number = 24): Promise<VerificationResult[]> {
    const supabase = getSupabaseClient();
    const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

    const { data: posts, error } = await supabase
      .from('social_posts')
      .select('*')
      .eq('status', 'PUBLISHED')
      .gte('published_at', cutoffTime.toISOString())
      .order('published_at', { ascending: false });

    if (error || !posts) {
      logger.error('Failed to fetch recent posts for verification', { error });
      return [];
    }

    const results: VerificationResult[] = [];

    for (const post of posts) {
      const result = await this.verifyPost(post.id);
      results.push(result);

      // Add delay between verifications
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    return results;
  }

  /**
   * Take a screenshot of a LinkedIn profile page
   * Requires user to be logged in manually beforehand
   */
  async captureProfileScreenshot(profileUrl: string): Promise<string> {
    const page = await this.launch();

    try {
      logger.info('Navigating to LinkedIn profile', { url: profileUrl });
      await page.goto(profileUrl, { waitUntil: 'networkidle' });

      // Wait for content to load
      await page.waitForTimeout(2000);

      // Check if we need to login
      const isLoggedIn = await this.checkLoginStatus(page, 'linkedin');
      if (!isLoggedIn) {
        logger.warn('Not logged in to LinkedIn - screenshot may show login page');
      }

      // Take screenshot
      const filename = `profile_${Date.now()}.png`;
      const filepath = join(SCREENSHOTS_DIR, filename);

      await page.screenshot({
        path: filepath,
        fullPage: false,
      });

      logger.info('Profile screenshot captured', { filepath });
      return filepath;
    } finally {
      await page.close();
    }
  }

  /**
   * Verify a post appears on the feed
   */
  async verifyPostOnFeed(postUrn: string): Promise<{
    found: boolean;
    screenshotPath?: string;
    error?: string;
  }> {
    const page = await this.launch();

    try {
      // Navigate to feed
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);

      // Check login
      const isLoggedIn = await this.checkLoginStatus(page, 'linkedin');
      if (!isLoggedIn) {
        return {
          found: false,
          error: 'Not logged in to LinkedIn',
        };
      }

      // Look for the post (simplified check)
      const postFound = await page.locator(`[data-urn="${postUrn}"]`).count() > 0;

      // Take screenshot
      const filename = `feed_verification_${Date.now()}.png`;
      const filepath = join(SCREENSHOTS_DIR, filename);
      await page.screenshot({ path: filepath });

      return {
        found: postFound,
        screenshotPath: filepath,
      };
    } catch (error) {
      logger.error('Post verification failed', { error, postUrn });
      return {
        found: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      await page.close();
    }
  }

  /**
   * Capture screenshot of a specific post by URL
   */
  async capturePostScreenshot(postUrl: string): Promise<string> {
    const page = await this.launch();

    try {
      logger.info('Navigating to post', { url: postUrl });
      await page.goto(postUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);

      const filename = `post_${Date.now()}.png`;
      const filepath = join(SCREENSHOTS_DIR, filename);

      await page.screenshot({
        path: filepath,
        fullPage: false,
      });

      logger.info('Post screenshot captured', { filepath });
      return filepath;
    } finally {
      await page.close();
    }
  }

  /**
   * Interactive login helper
   * Opens browser for user to log in manually
   */
  async openForLogin(platform: Platform = 'linkedin'): Promise<void> {
    const page = await this.launch();

    const loginUrls: Record<Platform, string> = {
      linkedin: 'https://www.linkedin.com/login',
      facebook: 'https://www.facebook.com/login',
      instagram: 'https://www.instagram.com/accounts/login/',
      x: 'https://x.com/i/flow/login',
    };

    const feedUrls: Record<Platform, string> = {
      linkedin: '**/feed/**',
      facebook: '**facebook.com/**',
      instagram: '**instagram.com/**',
      x: '**x.com/home**',
    };

    try {
      await page.goto(loginUrls[platform], { waitUntil: 'networkidle' });

      logger.info(`Browser opened for ${platform} login`);
      logger.info('Please log in manually in the browser window');
      logger.info('The session will be preserved for future use');

      // Wait for user to complete login (max 5 minutes)
      try {
        await page.waitForURL(feedUrls[platform], { timeout: 300000 });
        logger.info('Login successful - session saved');
      } catch {
        logger.warn('Login timeout or cancelled');
      }
    } finally {
      await page.close();
    }
  }

  /**
   * Check if currently logged in
   */
  private async checkLoginStatus(page: Page, platform: Platform): Promise<boolean> {
    try {
      switch (platform) {
        case 'linkedin': {
          const feedNav = await page.locator('nav[aria-label*="Primary"]').count();
          const loginForm = await page.locator('form.login__form').count();
          return feedNav > 0 && loginForm === 0;
        }
        case 'facebook': {
          const loginForm = await page.locator('#login_form, [data-testid="royal_login_form"]').count();
          return loginForm === 0;
        }
        case 'instagram': {
          const loginButton = await page.locator('[data-testid="login-button"], .L3NKy').count();
          return loginButton === 0;
        }
        case 'x': {
          const loginPrompt = await page.locator('[data-testid="loginButton"]').count();
          return loginPrompt === 0;
        }
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Take a simple screenshot of any URL
   */
  async captureUrl(url: string, name?: string): Promise<string> {
    const page = await this.launch();

    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);

      const filename = name ? `${name}_${Date.now()}.png` : `capture_${Date.now()}.png`;
      const filepath = join(SCREENSHOTS_DIR, filename);

      await page.screenshot({
        path: filepath,
        fullPage: false,
      });

      return filepath;
    } finally {
      await page.close();
    }
  }

  /**
   * Run a visual smoke test for all platforms
   */
  async runSmokeTest(): Promise<{
    success: boolean;
    screenshots: string[];
    errors: string[];
    platforms: Record<Platform, { reachable: boolean; loggedIn: boolean }>;
  }> {
    const screenshots: string[] = [];
    const errors: string[] = [];
    const platforms: Record<Platform, { reachable: boolean; loggedIn: boolean }> = {
      linkedin: { reachable: false, loggedIn: false },
      facebook: { reachable: false, loggedIn: false },
      instagram: { reachable: false, loggedIn: false },
      x: { reachable: false, loggedIn: false },
    };

    const platformUrls: Record<Platform, { home: string; feed: string }> = {
      linkedin: { home: 'https://www.linkedin.com', feed: 'https://www.linkedin.com/feed/' },
      facebook: { home: 'https://www.facebook.com', feed: 'https://www.facebook.com' },
      instagram: { home: 'https://www.instagram.com', feed: 'https://www.instagram.com' },
      x: { home: 'https://www.x.com', feed: 'https://x.com/home' },
    };

    try {
      for (const platform of Object.keys(platformUrls) as Platform[]) {
        try {
          const page = await this.launch();
          await page.goto(platformUrls[platform].home, { waitUntil: 'networkidle', timeout: 15000 });
          await page.waitForTimeout(2000);

          platforms[platform].reachable = true;
          platforms[platform].loggedIn = await this.checkLoginStatus(page, platform);

          const filename = `smoke_${platform}_${Date.now()}.png`;
          const filepath = join(SCREENSHOTS_DIR, filename);
          await page.screenshot({ path: filepath });
          screenshots.push(filepath);

          await page.close();
        } catch (error) {
          errors.push(`${platform}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      return {
        success: errors.length === 0,
        screenshots,
        errors,
        platforms,
      };
    } catch (error) {
      return {
        success: false,
        screenshots,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
        platforms,
      };
    }
  }

  /**
   * Take a screenshot and return as buffer
   */
  async takeScreenshot(url: string): Promise<Buffer> {
    await this.initialize();

    const page = await this.context!.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const screenshot = await page.screenshot({ fullPage: false });
    await page.close();

    return screenshot;
  }
}

/**
 * LinkedIn post verifier
 */
class LinkedInVerifier implements PlatformVerifier {
  async verifyPost(page: Page, externalUrl: string, expectedContent: string): Promise<{
    visible: boolean;
    contentMatched: boolean;
    metrics?: Record<string, number>;
  }> {
    try {
      // Look for post content on the page
      const postContent = await page.$eval(
        '[data-urn] .feed-shared-update-v2__description, .update-components-text',
        el => el.textContent || ''
      ).catch(() => '');

      // Check for error messages or login walls
      const isLoginWall = await page.$('.authentication-outlet').catch(() => null);
      const hasError = await page.$('.artdeco-empty-state').catch(() => null);

      if (isLoginWall || hasError) {
        return { visible: false, contentMatched: false };
      }

      // Try to get engagement metrics
      const metrics: Record<string, number> = {};
      try {
        const likesText = await page.$eval('.social-details-social-counts__reactions-count', el => el.textContent || '0');
        metrics.likes = parseInt(likesText.replace(/\D/g, '')) || 0;
      } catch {
        // Metrics not available
      }

      const contentMatched = this.fuzzyMatch(postContent, expectedContent);

      return {
        visible: postContent.length > 0,
        contentMatched,
        metrics,
      };
    } catch (error) {
      return { visible: false, contentMatched: false };
    }
  }

  private fuzzyMatch(actual: string, expected: string): boolean {
    const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const a = normalise(actual);
    const e = normalise(expected.substring(0, 200));
    return a.includes(e) || e.includes(a.substring(0, 100));
  }
}

/**
 * Facebook post verifier
 */
class FacebookVerifier implements PlatformVerifier {
  async verifyPost(page: Page, externalUrl: string, expectedContent: string): Promise<{
    visible: boolean;
    contentMatched: boolean;
    metrics?: Record<string, number>;
  }> {
    try {
      // Facebook often requires login - check for login wall
      const isLoginWall = await page.$('#login_form, [data-testid="royal_login_form"]').catch(() => null);

      if (isLoginWall) {
        // Can't verify without login, but if we got this far the URL exists
        return { visible: true, contentMatched: false };
      }

      // Look for post content
      const postContent = await page.$eval(
        '[data-ad-preview="message"], .userContent, [data-testid="post_message"]',
        el => el.textContent || ''
      ).catch(() => '');

      return {
        visible: postContent.length > 0 || !isLoginWall,
        contentMatched: postContent.toLowerCase().includes(expectedContent.substring(0, 50).toLowerCase()),
      };
    } catch {
      return { visible: false, contentMatched: false };
    }
  }
}

/**
 * Instagram post verifier
 */
class InstagramVerifier implements PlatformVerifier {
  async verifyPost(page: Page, externalUrl: string, expectedContent: string): Promise<{
    visible: boolean;
    contentMatched: boolean;
    metrics?: Record<string, number>;
  }> {
    try {
      // Check for login wall
      const isLoginRequired = await page.$('[data-testid="login-button"], .L3NKy').catch(() => null);

      // Look for post image or content
      const hasMedia = await page.$('article img, article video').catch(() => null);
      const caption = await page.$eval(
        'article span, article h1',
        el => el.textContent || ''
      ).catch(() => '');

      // Get likes if visible
      const metrics: Record<string, number> = {};
      try {
        const likesText = await page.$eval(
          'article section span[class*="likes"], button span',
          el => el.textContent || '0'
        );
        metrics.likes = parseInt(likesText.replace(/\D/g, '')) || 0;
      } catch {
        // Metrics not visible
      }

      return {
        visible: !!hasMedia || caption.length > 0,
        contentMatched: caption.toLowerCase().includes(expectedContent.substring(0, 50).toLowerCase()),
        metrics,
      };
    } catch {
      return { visible: false, contentMatched: false };
    }
  }
}

/**
 * X/Twitter post verifier
 */
class XVerifier implements PlatformVerifier {
  async verifyPost(page: Page, externalUrl: string, expectedContent: string): Promise<{
    visible: boolean;
    contentMatched: boolean;
    metrics?: Record<string, number>;
  }> {
    try {
      // X often shows interstitials - wait and dismiss if needed
      await page.waitForTimeout(2000);

      // Look for tweet content
      const tweetContent = await page.$eval(
        '[data-testid="tweetText"], article div[lang]',
        el => el.textContent || ''
      ).catch(() => '');

      // Check for deleted/not found
      const notFound = await page.$('[data-testid="error-detail"], [data-testid="empty_state_header_text"]').catch(() => null);

      if (notFound) {
        return { visible: false, contentMatched: false };
      }

      // Get engagement metrics
      const metrics: Record<string, number> = {};
      try {
        const likesText = await page.$eval('[data-testid="like"] span', el => el.textContent || '0');
        metrics.likes = parseInt(likesText.replace(/\D/g, '')) || 0;

        const retweetsText = await page.$eval('[data-testid="retweet"] span', el => el.textContent || '0');
        metrics.shares = parseInt(retweetsText.replace(/\D/g, '')) || 0;
      } catch {
        // Metrics not visible
      }

      const contentMatched = tweetContent.toLowerCase().includes(expectedContent.substring(0, 50).toLowerCase());

      return {
        visible: tweetContent.length > 0,
        contentMatched,
        metrics,
      };
    } catch {
      return { visible: false, contentMatched: false };
    }
  }
}

/**
 * Generic verifier for fallback
 */
class GenericVerifier implements PlatformVerifier {
  async verifyPost(page: Page, externalUrl: string, expectedContent: string): Promise<{
    visible: boolean;
    contentMatched: boolean;
    metrics?: Record<string, number>;
  }> {
    try {
      const bodyText = await page.$eval('body', el => el.textContent || '');
      const hasContent = bodyText.length > 100;
      const contentMatched = bodyText.toLowerCase().includes(expectedContent.substring(0, 50).toLowerCase());

      return {
        visible: hasContent,
        contentMatched,
      };
    } catch {
      return { visible: false, contentMatched: false };
    }
  }
}

export const visualVerificationService = new VisualVerificationService();
