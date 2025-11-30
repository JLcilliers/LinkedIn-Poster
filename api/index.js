const https = require('https');
const querystring = require('querystring');

// In-memory storage (replace with Vercel KV or database in production)
let blogSources = [];
let articles = [];
let posts = [];

// Shared styles for all pages
const getStyles = () => `
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f7fa;
      min-height: 100vh;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px;
      color: white;
    }
    .header-content {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .logo { font-size: 1.5rem; font-weight: bold; }
    .nav {
      display: flex;
      gap: 8px;
    }
    .nav a {
      color: white;
      text-decoration: none;
      padding: 10px 20px;
      border-radius: 8px;
      transition: background 0.2s;
    }
    .nav a:hover, .nav a.active {
      background: rgba(255,255,255,0.2);
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    h1 { color: #1a1a2e; margin-bottom: 8px; }
    h2 { color: #333; font-size: 1.25rem; }
    .subtitle { color: #666; }
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
    .status-label { font-size: 0.85rem; color: #666; margin-bottom: 4px; }
    .status-value { font-weight: 600; color: #1a1a2e; }
    .btn {
      display: inline-block;
      padding: 12px 24px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      cursor: pointer;
      border: none;
      font-size: 0.95rem;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .btn-primary { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
    .btn-success { background: #28a745; color: white; }
    .btn-danger { background: #dc3545; color: white; }
    .btn-secondary { background: #6c757d; color: white; }
    .btn-sm { padding: 8px 16px; font-size: 0.85rem; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 6px; font-weight: 500; color: #333; }
    .form-control {
      width: 100%;
      padding: 12px;
      border: 2px solid #e1e5eb;
      border-radius: 8px;
      font-size: 1rem;
      transition: border-color 0.2s;
    }
    .form-control:focus { outline: none; border-color: #667eea; }
    textarea.form-control { min-height: 120px; resize: vertical; }
    .table {
      width: 100%;
      border-collapse: collapse;
    }
    .table th, .table td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #e1e5eb;
    }
    .table th { background: #f8f9fa; font-weight: 600; color: #333; }
    .table tr:hover { background: #f8f9fa; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-success { background: #d4edda; color: #155724; }
    .badge-warning { background: #fff3cd; color: #856404; }
    .badge-info { background: #d1ecf1; color: #0c5460; }
    .badge-secondary { background: #e2e3e5; color: #383d41; }
    .badge-primary { background: #cce5ff; color: #004085; }
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #666;
    }
    .empty-state .icon { font-size: 4rem; margin-bottom: 16px; opacity: 0.5; }
    .empty-state h3 { margin-bottom: 8px; color: #333; }
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay.active { display: flex; }
    .modal {
      background: white;
      border-radius: 12px;
      padding: 24px;
      max-width: 600px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .modal-close {
      background: none;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      color: #666;
    }
    .alert {
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 16px;
    }
    .alert-success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
    .alert-info { background: #d1ecf1; border: 1px solid #bee5eb; color: #0c5460; }
    .alert-warning { background: #fff3cd; border: 1px solid #ffeeba; color: #856404; }
    .actions { display: flex; gap: 8px; }
    .post-preview {
      background: #f8f9fa;
      border-radius: 8px;
      padding: 20px;
      margin: 16px 0;
      border-left: 4px solid #0077b5;
    }
    .post-preview .author { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .post-preview .avatar { width: 48px; height: 48px; background: #0077b5; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; }
    .post-preview .content { white-space: pre-wrap; line-height: 1.6; }
    .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 2px solid #e1e5eb; }
    .tab {
      padding: 12px 24px;
      cursor: pointer;
      border: none;
      background: none;
      font-size: 1rem;
      color: #666;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
      transition: all 0.2s;
    }
    .tab:hover { color: #667eea; }
    .tab.active { color: #667eea; border-bottom-color: #667eea; font-weight: 600; }
    .quick-action {
      background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
      border: 2px dashed #dee2e6;
      border-radius: 12px;
      padding: 24px;
      text-align: center;
      transition: all 0.2s;
    }
    .quick-action:hover { border-color: #667eea; background: white; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .footer { text-align: center; color: #999; padding: 20px; font-size: 0.9rem; }
  </style>
`;

// Main dashboard HTML
function getDashboardHTML(config) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LinkedIn Blog Reposter</title>
  ${getStyles()}
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="logo">🔗 LinkedIn Blog Reposter</div>
      <nav class="nav">
        <a href="/" class="active">Dashboard</a>
        <a href="/sources">Sources</a>
        <a href="/articles">Articles</a>
        <a href="/posts">Posts</a>
      </nav>
    </div>
  </div>

  <div class="container">
    <div class="card">
      <h1>Dashboard</h1>
      <p class="subtitle">Monitor and manage your automated LinkedIn posting</p>

      <div class="status-grid" style="margin-top: 20px;">
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
        <div class="status-item ${blogSources.length > 0 ? 'success' : 'warning'}">
          <div class="status-label">Blog Sources</div>
          <div class="status-value">${blogSources.length > 0 ? blogSources.length + ' Active' : '⚠ None Added'}</div>
        </div>
      </div>
    </div>

    ${!config.linkedInAuthenticated ? `
    <div class="card">
      <h2>🚀 Connect LinkedIn</h2>
      <p style="margin: 12px 0; color: #666;">Connect your LinkedIn account to enable automatic posting.</p>
      <a href="/auth/linkedin" class="btn btn-primary">Connect LinkedIn Account</a>
    </div>
    ` : ''}

    <div class="grid-2">
      <div class="card">
        <h2>📝 Quick Post</h2>
        <p style="margin: 12px 0; color: #666;">Generate a LinkedIn post from any article URL.</p>
        <form action="/api/generate" method="POST" style="margin-top: 16px;">
          <div class="form-group">
            <label for="url">Article URL</label>
            <input type="url" id="url" name="url" class="form-control" placeholder="https://example.com/article" required>
          </div>
          <button type="submit" class="btn btn-primary" ${!config.openAIConfigured ? 'disabled title="Add OpenAI API key first"' : ''}>
            Generate Post
          </button>
        </form>
      </div>

      <div class="card">
        <h2>📊 Activity Summary</h2>
        <div style="margin-top: 16px;">
          <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #eee;">
            <span>Articles Discovered</span>
            <strong>${articles.length}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #eee;">
            <span>Posts Generated</span>
            <strong>${posts.filter(p => p.status !== 'draft').length}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #eee;">
            <span>Posts Published</span>
            <strong>${posts.filter(p => p.status === 'published').length}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; padding: 12px 0;">
            <span>Pending Review</span>
            <strong>${posts.filter(p => p.status === 'pending').length}</strong>
          </div>
        </div>
      </div>
    </div>

    ${blogSources.length === 0 ? `
    <div class="card">
      <div class="empty-state">
        <div class="icon">📰</div>
        <h3>No Blog Sources Yet</h3>
        <p>Add your first RSS feed to start discovering articles automatically.</p>
        <a href="/sources" class="btn btn-primary" style="margin-top: 16px;">Add Blog Source</a>
      </div>
    </div>
    ` : ''}
  </div>

  <div class="footer">LinkedIn Blog Reposter v1.0.0 | Powered by Vercel</div>
</body>
</html>
`;
}

// Sources page HTML
function getSourcesHTML() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Blog Sources - LinkedIn Blog Reposter</title>
  ${getStyles()}
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="logo">🔗 LinkedIn Blog Reposter</div>
      <nav class="nav">
        <a href="/">Dashboard</a>
        <a href="/sources" class="active">Sources</a>
        <a href="/articles">Articles</a>
        <a href="/posts">Posts</a>
      </nav>
    </div>
  </div>

  <div class="container">
    <div class="card">
      <div class="card-header">
        <div>
          <h1>Blog Sources</h1>
          <p class="subtitle">RSS feeds to monitor for new content</p>
        </div>
        <button class="btn btn-primary" onclick="showAddModal()">+ Add Source</button>
      </div>

      ${blogSources.length === 0 ? `
        <div class="empty-state">
          <div class="icon">📡</div>
          <h3>No Sources Added</h3>
          <p>Add RSS feeds from blogs you want to share on LinkedIn.</p>
          <button class="btn btn-primary" style="margin-top: 16px;" onclick="showAddModal()">Add Your First Source</button>
        </div>
      ` : `
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Feed URL</th>
              <th>Status</th>
              <th>Last Checked</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${blogSources.map(source => `
              <tr>
                <td><strong>${source.name}</strong></td>
                <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${source.feedUrl}</td>
                <td><span class="badge ${source.active ? 'badge-success' : 'badge-secondary'}">${source.active ? 'Active' : 'Paused'}</span></td>
                <td>${source.lastChecked || 'Never'}</td>
                <td class="actions">
                  <button class="btn btn-sm btn-secondary" onclick="checkSource('${source.id}')">Check Now</button>
                  <button class="btn btn-sm btn-danger" onclick="deleteSource('${source.id}')">Delete</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>

    <div class="card">
      <h2>💡 Popular RSS Feeds</h2>
      <p style="margin: 12px 0 16px; color: #666;">Quick-add popular tech blogs:</p>
      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        <button class="btn btn-secondary btn-sm" onclick="quickAdd('TechCrunch', 'https://techcrunch.com/feed/')">TechCrunch</button>
        <button class="btn btn-secondary btn-sm" onclick="quickAdd('Hacker News', 'https://news.ycombinator.com/rss')">Hacker News</button>
        <button class="btn btn-secondary btn-sm" onclick="quickAdd('Dev.to', 'https://dev.to/feed')">Dev.to</button>
        <button class="btn btn-secondary btn-sm" onclick="quickAdd('CSS-Tricks', 'https://css-tricks.com/feed/')">CSS-Tricks</button>
        <button class="btn btn-secondary btn-sm" onclick="quickAdd('Smashing Magazine', 'https://www.smashingmagazine.com/feed/')">Smashing Magazine</button>
      </div>
    </div>
  </div>

  <!-- Add Source Modal -->
  <div class="modal-overlay" id="addModal">
    <div class="modal">
      <div class="modal-header">
        <h2>Add Blog Source</h2>
        <button class="modal-close" onclick="hideAddModal()">&times;</button>
      </div>
      <form action="/api/sources" method="POST" id="addSourceForm">
        <div class="form-group">
          <label for="name">Source Name</label>
          <input type="text" id="name" name="name" class="form-control" placeholder="My Company Blog" required>
        </div>
        <div class="form-group">
          <label for="feedUrl">RSS Feed URL</label>
          <input type="url" id="feedUrl" name="feedUrl" class="form-control" placeholder="https://example.com/feed.xml" required>
        </div>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button type="button" class="btn btn-secondary" onclick="hideAddModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Add Source</button>
        </div>
      </form>
    </div>
  </div>

  <div class="footer">LinkedIn Blog Reposter v1.0.0 | Powered by Vercel</div>

  <script>
    function showAddModal() { document.getElementById('addModal').classList.add('active'); }
    function hideAddModal() { document.getElementById('addModal').classList.remove('active'); }
    function quickAdd(name, url) {
      document.getElementById('name').value = name;
      document.getElementById('feedUrl').value = url;
      showAddModal();
    }
    function deleteSource(id) {
      if (confirm('Delete this source?')) {
        fetch('/api/sources/' + id, { method: 'DELETE' }).then(() => location.reload());
      }
    }
    function checkSource(id) {
      fetch('/api/sources/' + id + '/check', { method: 'POST' }).then(() => location.reload());
    }
    document.getElementById('addSourceForm').onsubmit = function(e) {
      e.preventDefault();
      const data = new FormData(this);
      fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.get('name'), feedUrl: data.get('feedUrl') })
      }).then(() => location.reload());
    };
    document.getElementById('addModal').onclick = function(e) {
      if (e.target === this) hideAddModal();
    };
  </script>
</body>
</html>
`;
}

// Articles page HTML
function getArticlesHTML() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Articles - LinkedIn Blog Reposter</title>
  ${getStyles()}
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="logo">🔗 LinkedIn Blog Reposter</div>
      <nav class="nav">
        <a href="/">Dashboard</a>
        <a href="/sources">Sources</a>
        <a href="/articles" class="active">Articles</a>
        <a href="/posts">Posts</a>
      </nav>
    </div>
  </div>

  <div class="container">
    <div class="card">
      <div class="card-header">
        <div>
          <h1>Discovered Articles</h1>
          <p class="subtitle">Articles found from your blog sources</p>
        </div>
        <button class="btn btn-secondary" onclick="checkAllSources()">🔄 Check All Sources</button>
      </div>

      ${articles.length === 0 ? `
        <div class="empty-state">
          <div class="icon">📄</div>
          <h3>No Articles Yet</h3>
          <p>Articles will appear here once your sources are checked.</p>
          <a href="/sources" class="btn btn-primary" style="margin-top: 16px;">Add Sources</a>
        </div>
      ` : `
        <table class="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Source</th>
              <th>Date</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${articles.map(article => `
              <tr>
                <td>
                  <strong>${article.title}</strong>
                  <br><small style="color: #666;">${article.url}</small>
                </td>
                <td>${article.sourceName || 'Unknown'}</td>
                <td>${article.publishedAt ? new Date(article.publishedAt).toLocaleDateString() : 'N/A'}</td>
                <td><span class="badge badge-${getStatusBadge(article.status)}">${article.status}</span></td>
                <td class="actions">
                  <button class="btn btn-sm btn-primary" onclick="generatePost('${article.id}')">Generate Post</button>
                  <a href="${article.url}" target="_blank" class="btn btn-sm btn-secondary">View</a>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  </div>

  <div class="footer">LinkedIn Blog Reposter v1.0.0 | Powered by Vercel</div>

  <script>
    function checkAllSources() {
      fetch('/api/sources/check-all', { method: 'POST' }).then(() => location.reload());
    }
    function generatePost(articleId) {
      fetch('/api/articles/' + articleId + '/generate', { method: 'POST' })
        .then(res => res.json())
        .then(() => window.location.href = '/posts');
    }
  </script>
</body>
</html>
`;
}

// Posts page HTML
function getPostsHTML() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Posts - LinkedIn Blog Reposter</title>
  ${getStyles()}
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="logo">🔗 LinkedIn Blog Reposter</div>
      <nav class="nav">
        <a href="/">Dashboard</a>
        <a href="/sources">Sources</a>
        <a href="/articles">Articles</a>
        <a href="/posts" class="active">Posts</a>
      </nav>
    </div>
  </div>

  <div class="container">
    <div class="card">
      <div class="card-header">
        <div>
          <h1>Generated Posts</h1>
          <p class="subtitle">Review and publish your LinkedIn posts</p>
        </div>
      </div>

      <div class="tabs">
        <button class="tab active" onclick="filterPosts('all')">All (${posts.length})</button>
        <button class="tab" onclick="filterPosts('pending')">Pending (${posts.filter(p => p.status === 'pending').length})</button>
        <button class="tab" onclick="filterPosts('approved')">Approved (${posts.filter(p => p.status === 'approved').length})</button>
        <button class="tab" onclick="filterPosts('published')">Published (${posts.filter(p => p.status === 'published').length})</button>
      </div>

      ${posts.length === 0 ? `
        <div class="empty-state">
          <div class="icon">✍️</div>
          <h3>No Posts Yet</h3>
          <p>Generate posts from articles or use Quick Post on the dashboard.</p>
          <a href="/" class="btn btn-primary" style="margin-top: 16px;">Go to Dashboard</a>
        </div>
      ` : `
        <div id="postsList">
          ${posts.map(post => `
            <div class="post-item" data-status="${post.status}" style="border: 1px solid #e1e5eb; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
              <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
                <div>
                  <h3 style="margin: 0;">${post.articleTitle || 'Untitled'}</h3>
                  <small style="color: #666;">Generated ${new Date(post.createdAt).toLocaleString()}</small>
                </div>
                <span class="badge badge-${getStatusBadge(post.status)}">${post.status}</span>
              </div>

              <div class="post-preview">
                <div class="author">
                  <div class="avatar">👤</div>
                  <div>
                    <strong>Your Name</strong><br>
                    <small style="color: #666;">Your Headline • Just now</small>
                  </div>
                </div>
                <div class="content">${post.content}</div>
              </div>

              <div class="actions" style="margin-top: 16px;">
                ${post.status === 'pending' ? `
                  <button class="btn btn-sm btn-success" onclick="approvePost('${post.id}')">✓ Approve</button>
                  <button class="btn btn-sm btn-secondary" onclick="editPost('${post.id}')">✎ Edit</button>
                  <button class="btn btn-sm btn-danger" onclick="deletePost('${post.id}')">✗ Delete</button>
                ` : ''}
                ${post.status === 'approved' ? `
                  <button class="btn btn-sm btn-primary" onclick="publishPost('${post.id}')">🚀 Publish to LinkedIn</button>
                  <button class="btn btn-sm btn-secondary" onclick="editPost('${post.id}')">✎ Edit</button>
                ` : ''}
                ${post.status === 'published' ? `
                  <a href="${post.linkedInUrl || '#'}" target="_blank" class="btn btn-sm btn-secondary">View on LinkedIn</a>
                ` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  </div>

  <!-- Edit Post Modal -->
  <div class="modal-overlay" id="editModal">
    <div class="modal">
      <div class="modal-header">
        <h2>Edit Post</h2>
        <button class="modal-close" onclick="hideEditModal()">&times;</button>
      </div>
      <form id="editPostForm">
        <input type="hidden" id="editPostId" name="id">
        <div class="form-group">
          <label for="editContent">Post Content</label>
          <textarea id="editContent" name="content" class="form-control" rows="8"></textarea>
        </div>
        <p style="color: #666; font-size: 0.85rem; margin-bottom: 16px;">
          💡 Tip: Use line breaks for readability. Add relevant hashtags at the end.
        </p>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button type="button" class="btn btn-secondary" onclick="hideEditModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
        </div>
      </form>
    </div>
  </div>

  <div class="footer">LinkedIn Blog Reposter v1.0.0 | Powered by Vercel</div>

  <script>
    function filterPosts(status) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');
      document.querySelectorAll('.post-item').forEach(p => {
        p.style.display = status === 'all' || p.dataset.status === status ? 'block' : 'none';
      });
    }
    function approvePost(id) {
      fetch('/api/posts/' + id + '/approve', { method: 'POST' }).then(() => location.reload());
    }
    function publishPost(id) {
      if (confirm('Publish this post to LinkedIn?')) {
        fetch('/api/posts/' + id + '/publish', { method: 'POST' }).then(() => location.reload());
      }
    }
    function deletePost(id) {
      if (confirm('Delete this post?')) {
        fetch('/api/posts/' + id, { method: 'DELETE' }).then(() => location.reload());
      }
    }
    function editPost(id) {
      const post = ${JSON.stringify(posts)}.find(p => p.id === id);
      if (post) {
        document.getElementById('editPostId').value = id;
        document.getElementById('editContent').value = post.content;
        document.getElementById('editModal').classList.add('active');
      }
    }
    function hideEditModal() {
      document.getElementById('editModal').classList.remove('active');
    }
    document.getElementById('editPostForm').onsubmit = function(e) {
      e.preventDefault();
      const id = document.getElementById('editPostId').value;
      const content = document.getElementById('editContent').value;
      fetch('/api/posts/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      }).then(() => location.reload());
    };
  </script>
</body>
</html>
`;
}

function getStatusBadge(status) {
  const badges = {
    'new': 'info',
    'pending': 'warning',
    'approved': 'primary',
    'published': 'success',
    'failed': 'danger'
  };
  return badges[status] || 'secondary';
}

// Simple router for serverless
function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Page routes
  if (path === '/' || path === '/api') return handleDashboard(req, res);
  if (path === '/sources') return handleSourcesPage(req, res);
  if (path === '/articles') return handleArticlesPage(req, res);
  if (path === '/posts') return handlePostsPage(req, res);

  // Auth routes
  if (path === '/auth/linkedin') return handleLinkedInAuth(req, res);
  if (path === '/auth/linkedin/callback') return handleLinkedInCallback(req, res, url);

  // API routes
  if (path === '/api/status') return handleStatus(req, res);
  if (path === '/api/sources' && method === 'POST') return handleAddSource(req, res);
  if (path === '/api/sources' && method === 'GET') return handleGetSources(req, res);
  if (path.startsWith('/api/sources/') && method === 'DELETE') return handleDeleteSource(req, res, path);
  if (path.startsWith('/api/sources/') && path.endsWith('/check')) return handleCheckSource(req, res, path);
  if (path === '/api/sources/check-all') return handleCheckAllSources(req, res);
  if (path === '/api/generate' && method === 'POST') return handleGenerateFromUrl(req, res);
  if (path.startsWith('/api/articles/') && path.endsWith('/generate')) return handleGenerateFromArticle(req, res, path);
  if (path.startsWith('/api/posts/') && path.endsWith('/approve')) return handleApprovePost(req, res, path);
  if (path.startsWith('/api/posts/') && path.endsWith('/publish')) return handlePublishPost(req, res, path);
  if (path.startsWith('/api/posts/') && method === 'PUT') return handleUpdatePost(req, res, path);
  if (path.startsWith('/api/posts/') && method === 'DELETE') return handleDeletePost(req, res, path);

  res.status(404).json({ error: 'Not Found', path });
}

// Page handlers
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

function handleSourcesPage(req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(getSourcesHTML());
}

function handleArticlesPage(req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(getArticlesHTML());
}

function handlePostsPage(req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(getPostsHTML());
}

// API handlers
function handleStatus(req, res) {
  res.status(200).json({
    status: 'operational',
    timestamp: new Date().toISOString(),
    sources: blogSources.length,
    articles: articles.length,
    posts: posts.length
  });
}

function handleAddSource(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { name, feedUrl } = JSON.parse(body);
      const source = {
        id: Date.now().toString(),
        name,
        feedUrl,
        active: true,
        lastChecked: null,
        createdAt: new Date().toISOString()
      };
      blogSources.push(source);
      res.status(201).json(source);
    } catch (e) {
      res.status(400).json({ error: 'Invalid JSON' });
    }
  });
}

function handleGetSources(req, res) {
  res.status(200).json(blogSources);
}

function handleDeleteSource(req, res, path) {
  const id = path.split('/')[3];
  blogSources = blogSources.filter(s => s.id !== id);
  res.status(200).json({ success: true });
}

function handleCheckSource(req, res, path) {
  const id = path.split('/')[3];
  const source = blogSources.find(s => s.id === id);
  if (source) {
    source.lastChecked = new Date().toISOString();
    // In production, this would fetch and parse the RSS feed
    // For demo, add a sample article
    articles.push({
      id: Date.now().toString(),
      sourceId: source.id,
      sourceName: source.name,
      title: 'Sample Article from ' + source.name,
      url: source.feedUrl,
      publishedAt: new Date().toISOString(),
      status: 'new'
    });
  }
  res.status(200).json({ success: true, articlesFound: 1 });
}

function handleCheckAllSources(req, res) {
  blogSources.forEach(source => {
    source.lastChecked = new Date().toISOString();
  });
  res.status(200).json({ success: true });
}

function handleGenerateFromUrl(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    // Parse URL-encoded form data or JSON
    let url;
    if (body.startsWith('{')) {
      url = JSON.parse(body).url;
    } else {
      url = new URLSearchParams(body).get('url');
    }

    // Create article and generate post
    const article = {
      id: Date.now().toString(),
      title: 'Article: ' + url,
      url: url,
      status: 'processed'
    };
    articles.push(article);

    // Generate sample post (in production, use OpenAI)
    const post = {
      id: Date.now().toString(),
      articleId: article.id,
      articleTitle: article.title,
      content: `🚀 Just discovered this amazing article!\n\nKey takeaways:\n• Insight 1\n• Insight 2\n• Insight 3\n\nWhat are your thoughts?\n\n🔗 ${url}\n\n#Tech #Innovation #Learning`,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    posts.push(post);

    res.writeHead(302, { Location: '/posts' });
    res.end();
  });
}

function handleGenerateFromArticle(req, res, path) {
  const articleId = path.split('/')[3];
  const article = articles.find(a => a.id === articleId);

  if (!article) {
    return res.status(404).json({ error: 'Article not found' });
  }

  const post = {
    id: Date.now().toString(),
    articleId: article.id,
    articleTitle: article.title,
    content: `🚀 Check out this article: ${article.title}\n\nKey insights from the post...\n\n🔗 ${article.url}\n\n#Tech #Innovation`,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  posts.push(post);
  article.status = 'processed';

  res.status(201).json(post);
}

function handleApprovePost(req, res, path) {
  const postId = path.split('/')[3];
  const post = posts.find(p => p.id === postId);
  if (post) post.status = 'approved';
  res.status(200).json({ success: true });
}

function handlePublishPost(req, res, path) {
  const postId = path.split('/')[3];
  const post = posts.find(p => p.id === postId);
  if (post) {
    post.status = 'published';
    post.publishedAt = new Date().toISOString();
    // In production, this would call LinkedIn API
  }
  res.status(200).json({ success: true });
}

function handleUpdatePost(req, res, path) {
  const postId = path.split('/')[3];
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const { content } = JSON.parse(body);
    const post = posts.find(p => p.id === postId);
    if (post) post.content = content;
    res.status(200).json({ success: true });
  });
}

function handleDeletePost(req, res, path) {
  const postId = path.split('/')[3];
  posts = posts.filter(p => p.id !== postId);
  res.status(200).json({ success: true });
}

// LinkedIn OAuth handlers
function handleLinkedInAuth(req, res) {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    res.status(500).json({ error: 'LinkedIn OAuth not configured' });
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

function handleLinkedInCallback(req, res, url) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.setHeader('Content-Type', 'text/html');
    res.status(400).send(getErrorHTML('OAuth Error', error));
    return;
  }

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
          res.status(400).send(getErrorHTML('Token Error', tokenResponse.error_description));
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.status(200).send(getSuccessHTML(tokenResponse));
      } catch (e) {
        res.status(500).send(getErrorHTML('Parse Error', 'Failed to parse response'));
      }
    });
  });

  tokenReq.on('error', (e) => res.status(500).send(getErrorHTML('Request Error', e.message)));
  tokenReq.write(tokenData);
  tokenReq.end();
}

function getSuccessHTML(tokenResponse) {
  return `
<!DOCTYPE html>
<html><head><title>LinkedIn Connected!</title>${getStyles()}</head>
<body style="background: linear-gradient(135deg, #28a745 0%, #20c997 100%); display: flex; align-items: center; justify-content: center; min-height: 100vh;">
  <div class="card" style="max-width: 600px; text-align: center;">
    <div style="font-size: 4rem;">✅</div>
    <h1 style="color: #28a745;">LinkedIn Connected!</h1>
    <p>Copy the token below and add it to Vercel environment variables.</p>
    <div style="background: #f8f9fa; padding: 16px; border-radius: 8px; word-break: break-all; font-family: monospace; margin: 20px 0;">
      ${tokenResponse.access_token}
    </div>
    <button class="btn btn-success" onclick="navigator.clipboard.writeText('${tokenResponse.access_token}').then(() => alert('Copied!'))">📋 Copy Token</button>
    <a href="/" class="btn btn-secondary" style="margin-left: 12px;">← Dashboard</a>
    <p style="margin-top: 20px; color: #666;">Token expires in ${Math.floor(tokenResponse.expires_in / 86400)} days</p>
  </div>
</body></html>`;
}

function getErrorHTML(title, message) {
  return `
<!DOCTYPE html>
<html><head><title>Error</title>${getStyles()}</head>
<body style="background: linear-gradient(135deg, #dc3545 0%, #c82333 100%); display: flex; align-items: center; justify-content: center; min-height: 100vh;">
  <div class="card" style="max-width: 500px; text-align: center;">
    <div style="font-size: 4rem;">❌</div>
    <h1 style="color: #dc3545;">${title}</h1>
    <p>${message}</p>
    <a href="/" class="btn btn-danger">← Back to Dashboard</a>
  </div>
</body></html>`;
}

module.exports = handleRequest;
