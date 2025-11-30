const https = require('https');
const querystring = require('querystring');

// Simple router for serverless
function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Route handling
  if (path === '/' || path === '/api') {
    return handleHealth(req, res);
  }

  if (path === '/auth/linkedin' || path === '/api/auth/linkedin') {
    return handleLinkedInAuth(req, res);
  }

  if (path === '/auth/linkedin/callback' || path === '/api/auth/linkedin/callback') {
    return handleLinkedInCallback(req, res, url);
  }

  if (path === '/api/status') {
    return handleStatus(req, res);
  }

  // 404 for unknown routes
  res.status(404).json({
    error: 'Not Found',
    path: path,
    availableRoutes: [
      'GET / - Health check',
      'GET /auth/linkedin - Start LinkedIn OAuth',
      'GET /auth/linkedin/callback - OAuth callback',
      'GET /api/status - API status'
    ]
  });
}

// Health check endpoint
function handleHealth(req, res) {
  res.status(200).json({
    name: 'LinkedIn Blog Reposter',
    version: '1.0.0',
    status: 'running',
    message: 'API is working on Vercel!',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
}

// API status endpoint
function handleStatus(req, res) {
  const hasLinkedInCreds = !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAccessToken = !!process.env.LINKEDIN_ACCESS_TOKEN;

  res.status(200).json({
    status: 'operational',
    timestamp: new Date().toISOString(),
    configuration: {
      linkedInAppConfigured: hasLinkedInCreds,
      linkedInAuthenticated: hasAccessToken,
      openAIConfigured: hasOpenAI,
      openAIModel: process.env.OPENAI_MODEL || 'gpt-4o'
    },
    features: {
      autoPost: process.env.AUTO_POST_TO_LINKEDIN === 'true',
      manualReview: process.env.MANUAL_REVIEW_MODE === 'true'
    }
  });
}

// Start LinkedIn OAuth flow
function handleLinkedInAuth(req, res) {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    res.status(500).json({
      error: 'LinkedIn OAuth not configured',
      message: 'Missing LINKEDIN_CLIENT_ID or LINKEDIN_REDIRECT_URI'
    });
    return;
  }

  const state = Math.random().toString(36).substring(7);
  const scopes = ['openid', 'profile', 'email', 'w_member_social'];

  const authUrl = 'https://www.linkedin.com/oauth/v2/authorization?' + querystring.stringify({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: state,
    scope: scopes.join(' ')
  });

  res.writeHead(302, { Location: authUrl });
  res.end();
}

// Handle LinkedIn OAuth callback
function handleLinkedInCallback(req, res, url) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  if (error) {
    res.status(400).json({
      error: 'LinkedIn OAuth Error',
      code: error,
      description: errorDescription
    });
    return;
  }

  if (!code) {
    res.status(400).json({
      error: 'Missing authorization code',
      message: 'No code parameter received from LinkedIn'
    });
    return;
  }

  // Exchange code for access token
  const tokenData = querystring.stringify({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
    client_id: process.env.LINKEDIN_CLIENT_ID,
    client_secret: process.env.LINKEDIN_CLIENT_SECRET
  });

  const options = {
    hostname: 'www.linkedin.com',
    path: '/oauth/v2/accessToken',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(tokenData)
    }
  };

  const tokenReq = https.request(options, (tokenRes) => {
    let body = '';
    tokenRes.on('data', chunk => body += chunk);
    tokenRes.on('end', () => {
      try {
        const tokenResponse = JSON.parse(body);

        if (tokenResponse.error) {
          res.status(400).json({
            error: 'Token Exchange Failed',
            details: tokenResponse
          });
          return;
        }

        // Success! Return the token info
        // In production, you'd store this securely
        res.status(200).json({
          success: true,
          message: 'LinkedIn authentication successful!',
          instructions: 'Copy the access_token and add it to your Vercel environment variables as LINKEDIN_ACCESS_TOKEN',
          tokenInfo: {
            access_token: tokenResponse.access_token,
            expires_in: tokenResponse.expires_in,
            scope: tokenResponse.scope
          },
          nextSteps: [
            '1. Copy the access_token above',
            '2. Go to Vercel Dashboard > Settings > Environment Variables',
            '3. Add LINKEDIN_ACCESS_TOKEN with the copied value',
            '4. Redeploy the application'
          ]
        });
      } catch (e) {
        res.status(500).json({
          error: 'Failed to parse token response',
          body: body
        });
      }
    });
  });

  tokenReq.on('error', (e) => {
    res.status(500).json({
      error: 'Token request failed',
      message: e.message
    });
  });

  tokenReq.write(tokenData);
  tokenReq.end();
}

module.exports = handleRequest;
