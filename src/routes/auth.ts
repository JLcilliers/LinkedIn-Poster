import { Router, Request, Response } from 'express';
import { linkedInPublisherService } from '../services/LinkedInPublisherService';
import { logger } from '../utils/logger';

const router = Router();

// Start LinkedIn OAuth flow
router.get('/linkedin', (req: Request, res: Response) => {
  try {
    const state = req.query.state as string || 'linkedin_auth';
    const authUrl = linkedInPublisherService.getAuthorizationUrl(state);

    logger.info('Redirecting to LinkedIn for authorization');
    res.redirect(authUrl);
  } catch (error) {
    logger.error('Failed to start OAuth flow', { error });
    res.status(500).json({ error: 'Failed to start OAuth flow' });
  }
});

// LinkedIn OAuth callback
router.get('/linkedin/callback', async (req: Request, res: Response) => {
  try {
    const { code, error, error_description, state } = req.query;

    if (error) {
      logger.error('LinkedIn OAuth error', { error, error_description });
      res.status(400).json({
        error: 'LinkedIn authorization failed',
        details: error_description,
      });
      return;
    }

    if (!code) {
      res.status(400).json({ error: 'No authorization code received' });
      return;
    }

    // Exchange code for token
    const tokenData = await linkedInPublisherService.exchangeCodeForToken(code as string);

    // Get member URN
    const memberUrn = await linkedInPublisherService.getMemberUrn(tokenData.accessToken);

    // Store token in database
    await linkedInPublisherService.storeToken(
      memberUrn,
      tokenData.accessToken,
      tokenData.expiresIn,
      tokenData.refreshToken,
      ['openid', 'profile', 'email', 'w_member_social']
    );

    logger.info('LinkedIn authorization successful', { memberUrn });

    // Return success page with instructions
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>LinkedIn Authorization Successful</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            background: #f5f5f5;
          }
          .card {
            background: white;
            border-radius: 8px;
            padding: 30px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          h1 { color: #0077b5; margin-top: 0; }
          .success { color: #28a745; }
          code {
            background: #f0f0f0;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 14px;
          }
          .info { margin-top: 20px; padding: 15px; background: #f0f9ff; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>LinkedIn Authorization <span class="success">Successful!</span></h1>
          <p>Your LinkedIn account has been connected successfully.</p>

          <div class="info">
            <strong>Member URN:</strong><br>
            <code>${memberUrn}</code>
          </div>

          <p style="margin-top: 20px;">
            You can now close this window. The LinkedIn Blog Reposter will use this
            authorization to post content on your behalf.
          </p>

          <p style="color: #666; font-size: 14px;">
            Note: If you want to use environment variables instead of the database token,
            add the following to your <code>.env</code> file:
          </p>

          <pre style="background: #f0f0f0; padding: 10px; border-radius: 4px; overflow-x: auto;">
LINKEDIN_MEMBER_URN="${memberUrn}"
LINKEDIN_ACCESS_TOKEN="[token stored securely in database]"</pre>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    logger.error('LinkedIn OAuth callback failed', { error });
    res.status(500).json({ error: 'Authorization failed. Please try again.' });
  }
});

// Test LinkedIn connection
router.get('/linkedin/test', async (req: Request, res: Response) => {
  try {
    const result = await linkedInPublisherService.testConnection();
    res.json(result);
  } catch (error) {
    logger.error('LinkedIn test failed', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Get rate limit status
router.get('/linkedin/rate-limit', async (req: Request, res: Response) => {
  try {
    const status = await linkedInPublisherService.canPostToday();
    res.json(status);
  } catch (error) {
    logger.error('Failed to check rate limit', { error });
    res.status(500).json({ error: 'Failed to check rate limit' });
  }
});

export default router;
