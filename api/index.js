const https = require('https');
const querystring = require('querystring');

// HTML Dashboard
function getDashboardHTML(config) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LinkedIn Blog Reposter</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    h1 {
      color: #1a1a2e;
      margin-bottom: 8px;
    }
    h2 {
      color: #333;
      margin-bottom: 16px;
      font-size: 1.25rem;
    }
    .subtitle {
      color: #666;
      margin-bottom: 20px;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .status-item {
      background: #f8f9fa;
      padding: 16px;
      border-radius: 8px;
      border-left: 4px solid #667eea;
    }
    .status-item.success { border-left-color: #28a745; }
    .status-item.warning { border-left-color: #ffc107; }
    .status-item.error { border-left-color: #dc3545; }
    .status-label {
      font-size: 0.85rem;
      color: #666;
      margin-bottom: 4px;
    }
    .status-value {
      font-weight: 600;
      color: #1a1a2e;
    }
    .btn {
      display: inline-block;
      padding: 12px 24px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      transition: transform 0.2s, box-shadow 0.2s;
      cursor: pointer;
      border: none;
      font-size: 1rem;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    .btn-primary {
      background: linear-gradient(135deg, #0077b5 0%, #005582 100%);
      color: white;
    }
    .btn-secondary {
      background: #f8f9fa;
      color: #333;
      border: 2px solid #ddd;
    }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .alert {
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .alert-info {
      background: #e7f3ff;
      border: 1px solid #b3d7ff;
      color: #004085;
    }
    .alert-success {
      background: #d4edda;
      border: 1px solid #c3e6cb;
      color: #155724;
    }
    .alert-warning {
      background: #fff3cd;
      border: 1px solid #ffeeba;
      color: #856404;
    }
    .steps {
      list-style: none;
      counter-reset: step;
    }
    .steps li {
      counter-increment: step;
      padding: 12px 0;
      padding-left: 40px;
      position: relative;
      border-bottom: 1px solid #eee;
    }
    .steps li:last-child { border-bottom: none; }
    .steps li::before {
      content: counter(step);
      position: absolute;
      left: 0;
      width: 28px;
      height: 28px;
      background: #667eea;
      color: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 0.85rem;
    }
    .steps li.completed::before {
      background: #28a745;
      content: "✓";
    }
    code {
      background: #f4f4f4;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
    }
    .footer {
      text-align: center;
      color: rgba(255,255,255,0.8);
      padding: 20px;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>🔗 LinkedIn Blog Reposter</h1>
      <p class="subtitle">Automatically share your blog content on LinkedIn</p>

      <div class="status-grid">
        <div class="status-item ${config.linkedInAppConfigured ? 'success' : 'error'}">
          <div class="status-label">LinkedIn App</div>
          <div class="status-value">${config.linkedInAppConfigured ? '✓ Configured' : '✗ Not Configured'}</div>
        </div>
        <div class="status-item ${config.linkedInAuthenticated ? 'success' : 'warning'}">
          <div class="status-label">LinkedIn Auth</div>
          <div class="status-value">${config.linkedInAuthenticated ? '✓ Connected' : '⚠ Not Connected'}</div>
        </div>
        <div class="status-item ${config.openAIConfigured ? 'success' : 'warning'}">
          <div class="status-label">OpenAI API</div>
          <div class="status-value">${config.openAIConfigured ? '✓ Configured' : '⚠ Not Set'}</div>
        </div>
        <div class="status-item">
          <div class="status-label">AI Model</div>
          <div class="status-value">${config.openAIModel}</div>
        </div>
      </div>
    </div>

    ${!config.linkedInAuthenticated ? `
    <div class="card">
      <h2>🚀 Get Started</h2>
      <div class="alert alert-info">
        <strong>Step 1:</strong> Connect your LinkedIn account to enable automatic posting.
      </div>
      <div class="actions">
        <a href="/auth/linkedin" class="btn btn-primary">
          Connect LinkedIn Account
        </a>
      </div>
    </div>
    ` : `
    <div class="card">
      <h2>✅ LinkedIn Connected</h2>
      <div class="alert alert-success">
        Your LinkedIn account is connected and ready for automatic posting!
      </div>
    </div>
    `}

    <div class="card">
      <h2>📋 Setup Checklist</h2>
      <ol class="steps">
        <li class="${config.linkedInAppConfigured ? 'completed' : ''}">
          <strong>LinkedIn Developer App</strong><br>
          <small>Create an app at <a href="https://www.linkedin.com/developers/apps" target="_blank">LinkedIn Developers</a></small>
        </li>
        <li class="${config.linkedInAuthenticated ? 'completed' : ''}">
          <strong>Authorize LinkedIn</strong><br>
          <small>Click "Connect LinkedIn Account" above to authorize</small>
        </li>
        <li class="${config.openAIConfigured ? 'completed' : ''}">
          <strong>Add OpenAI API Key</strong><br>
          <small>Set <code>OPENAI_API_KEY</code> in Vercel environment variables</small>
        </li>
        <li>
          <strong>Add Blog Sources</strong><br>
          <small>Configure RSS feeds to monitor for new content</small>
        </li>
      </ol>
    </div>

    <div class="card">
      <h2>🔧 API Endpoints</h2>
      <div class="status-grid">
        <div class="status-item">
          <div class="status-label">GET /</div>
          <div class="status-value">Dashboard (this page)</div>
        </div>
        <div class="status-item">
          <div class="status-label">GET /api/status</div>
          <div class="status-value">JSON status</div>
        </div>
        <div class="status-item">
          <div class="status-label">GET /auth/linkedin</div>
          <div class="status-value">Start OAuth flow</div>
        </div>
        <div class="status-item">
          <div class="status-label">GET /auth/linkedin/callback</div>
          <div class="status-value">OAuth callback</div>
        </div>
      </div>
    </div>
  </div>

  <div class="footer">
    LinkedIn Blog Reposter v1.0.0 | Powered by Vercel
  </div>
</body>
</html>
`;
}

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
    return handleDashboard(req, res);
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
      'GET / - Dashboard',
      'GET /auth/linkedin - Start LinkedIn OAuth',
      'GET /auth/linkedin/callback - OAuth callback',
      'GET /api/status - API status'
    ]
  });
}

// Dashboard with HTML UI
function handleDashboard(req, res) {
  const config = {
    linkedInAppConfigured: !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET),
    linkedInAuthenticated: !!process.env.LINKEDIN_ACCESS_TOKEN,
    openAIConfigured: !!process.env.OPENAI_API_KEY,
    openAIModel: process.env.OPENAI_MODEL || 'gpt-4o'
  };

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(getDashboardHTML(config));
}

// API status endpoint (JSON)
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
    res.setHeader('Content-Type', 'text/html');
    res.status(400).send(getErrorHTML('LinkedIn OAuth Error', errorDescription || error));
    return;
  }

  if (!code) {
    res.setHeader('Content-Type', 'text/html');
    res.status(400).send(getErrorHTML('Missing Code', 'No authorization code received from LinkedIn'));
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
          res.setHeader('Content-Type', 'text/html');
          res.status(400).send(getErrorHTML('Token Exchange Failed', tokenResponse.error_description || tokenResponse.error));
          return;
        }

        // Success! Show the token with copy functionality
        res.setHeader('Content-Type', 'text/html');
        res.status(200).send(getSuccessHTML(tokenResponse));
      } catch (e) {
        res.setHeader('Content-Type', 'text/html');
        res.status(500).send(getErrorHTML('Parse Error', 'Failed to parse LinkedIn response'));
      }
    });
  });

  tokenReq.on('error', (e) => {
    res.setHeader('Content-Type', 'text/html');
    res.status(500).send(getErrorHTML('Request Failed', e.message));
  });

  tokenReq.write(tokenData);
  tokenReq.end();
}

function getSuccessHTML(tokenResponse) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LinkedIn Connected!</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #28a745 0%, #20c997 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 600px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.2);
      text-align: center;
    }
    .icon { font-size: 4rem; margin-bottom: 20px; }
    h1 { color: #28a745; margin-bottom: 16px; }
    p { color: #666; margin-bottom: 24px; line-height: 1.6; }
    .token-box {
      background: #f8f9fa;
      border: 2px solid #e9ecef;
      border-radius: 8px;
      padding: 16px;
      margin: 20px 0;
      word-break: break-all;
      font-family: monospace;
      font-size: 0.85rem;
      text-align: left;
      max-height: 150px;
      overflow-y: auto;
    }
    .btn {
      display: inline-block;
      padding: 14px 28px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      cursor: pointer;
      border: none;
      font-size: 1rem;
      margin: 8px;
      transition: transform 0.2s;
    }
    .btn:hover { transform: translateY(-2px); }
    .btn-primary { background: #28a745; color: white; }
    .btn-secondary { background: #6c757d; color: white; }
    .steps {
      text-align: left;
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 8px;
      padding: 20px;
      margin-top: 24px;
    }
    .steps h3 { color: #856404; margin-bottom: 12px; }
    .steps ol { margin-left: 20px; color: #856404; }
    .steps li { margin-bottom: 8px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>LinkedIn Connected!</h1>
    <p>Your LinkedIn account has been successfully authorized. Copy the access token below and add it to your Vercel environment variables.</p>

    <div class="token-box" id="token">${tokenResponse.access_token}</div>

    <button class="btn btn-primary" onclick="copyToken()">📋 Copy Token</button>
    <a href="https://vercel.com" target="_blank" class="btn btn-secondary">Open Vercel Dashboard</a>

    <div class="steps">
      <h3>⚠️ Next Steps:</h3>
      <ol>
        <li>Copy the token above</li>
        <li>Go to Vercel Dashboard → Your Project → Settings → Environment Variables</li>
        <li>Add/Update <code>LINKEDIN_ACCESS_TOKEN</code> with the copied value</li>
        <li>Click "Redeploy" to apply changes</li>
        <li>Return to the <a href="/">Dashboard</a></li>
      </ol>
    </div>

    <p style="margin-top: 20px; font-size: 0.9rem; color: #999;">
      Token expires in: ${Math.floor(tokenResponse.expires_in / 86400)} days
    </p>
  </div>

  <script>
    function copyToken() {
      const token = document.getElementById('token').textContent;
      navigator.clipboard.writeText(token).then(() => {
        alert('Token copied to clipboard!');
      });
    }
  </script>
</body>
</html>
`;
}

function getErrorHTML(title, message) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - ${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #dc3545 0%, #c82333 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.2);
      text-align: center;
    }
    .icon { font-size: 4rem; margin-bottom: 20px; }
    h1 { color: #dc3545; margin-bottom: 16px; }
    p { color: #666; margin-bottom: 24px; line-height: 1.6; }
    .btn {
      display: inline-block;
      padding: 14px 28px;
      background: #dc3545;
      color: white;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
    }
    .btn:hover { background: #c82333; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/" class="btn">← Back to Dashboard</a>
  </div>
</body>
</html>
`;
}

module.exports = handleRequest;
