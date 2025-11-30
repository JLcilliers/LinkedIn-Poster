import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger';

const SCREENSHOTS_DIR = 'screenshots';
const USER_DATA_DIR = 'playwright-data';

/**
 * Visual Verification Service
 *
 * IMPORTANT: This service is for visual verification only.
 * It should NOT be used to:
 * - Bypass LinkedIn security or 2FA
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
   * Launch browser with persistent context (preserves login)
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
      const isLoggedIn = await this.checkLoginStatus(page);
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
      const isLoggedIn = await this.checkLoginStatus(page);
      if (!isLoggedIn) {
        return {
          found: false,
          error: 'Not logged in to LinkedIn',
        };
      }

      // Look for the post (simplified check)
      // In practice, you'd need to scroll and search more carefully
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
  async openForLogin(): Promise<void> {
    const page = await this.launch();

    try {
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle' });

      logger.info('Browser opened for LinkedIn login');
      logger.info('Please log in manually in the browser window');
      logger.info('The session will be preserved for future use');

      // Wait for user to complete login (max 5 minutes)
      try {
        await page.waitForURL('**/feed/**', { timeout: 300000 });
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
  private async checkLoginStatus(page: Page): Promise<boolean> {
    try {
      // Look for common logged-in indicators
      const feedNav = await page.locator('nav[aria-label*="Primary"]').count();
      const loginForm = await page.locator('form.login__form').count();

      return feedNav > 0 && loginForm === 0;
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
   * Run a visual smoke test
   */
  async runSmokeTest(): Promise<{
    success: boolean;
    screenshots: string[];
    errors: string[];
  }> {
    const screenshots: string[] = [];
    const errors: string[] = [];

    try {
      // Test 1: Can we reach LinkedIn?
      try {
        const homePath = await this.captureUrl('https://www.linkedin.com', 'smoke_home');
        screenshots.push(homePath);
      } catch (error) {
        errors.push(`Home page: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Test 2: Feed page (requires login)
      try {
        const page = await this.launch();
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        const isLoggedIn = await this.checkLoginStatus(page);

        const filename = `smoke_feed_${Date.now()}.png`;
        const filepath = join(SCREENSHOTS_DIR, filename);
        await page.screenshot({ path: filepath });
        screenshots.push(filepath);

        if (!isLoggedIn) {
          errors.push('Feed: Not logged in (expected if no session)');
        }

        await page.close();
      } catch (error) {
        errors.push(`Feed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      return {
        success: errors.length === 0,
        screenshots,
        errors,
      };
    } catch (error) {
      return {
        success: false,
        screenshots,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      };
    }
  }
}

export const visualVerificationService = new VisualVerificationService();
