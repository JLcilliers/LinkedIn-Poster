# Multi-Platform Social Autoposter - Design Document

## Overview

This document describes the architecture for upgrading the LinkedIn Posting Tool into a multi-platform social autoposter supporting LinkedIn, Facebook, Instagram, and X (Twitter).

## Core Principles

1. **Supabase as Single Source of Truth** - All persistent data lives in Supabase Postgres
2. **Official APIs Only** - Use Meta Graph API, LinkedIn API, and X API for posting
3. **Canonical Post Model** - Generate platform-agnostic content first, then format per platform
4. **Browser Automation for Verification Only** - Puppeteer/Playwright for visual checks, not posting
5. **UK English, Human Tone** - All generated content sounds natural

---

## Data Model (Supabase Postgres)

### Table: `blog_sources`

Stores RSS feeds and websites to monitor for new articles.

```sql
CREATE TABLE blog_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('rss', 'sitemap', 'custom')),
  active BOOLEAN NOT NULL DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  last_seen_external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_blog_sources_active ON blog_sources(active);
```

### Table: `articles`

Discovered articles from monitored sources.

```sql
CREATE TABLE articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES blog_sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  raw_summary TEXT,
  raw_content TEXT,
  published_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN (
    'NEW',
    'REJECTED_NOT_RELEVANT',
    'READY_FOR_POST',
    'POSTED',
    'FAILED'
  )),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_id, external_id)
);

CREATE INDEX idx_articles_status ON articles(status);
CREATE INDEX idx_articles_published_at ON articles(published_at DESC);
```

### Table: `criteria_configs`

Filtering rules and audience targeting configuration.

```sql
CREATE TABLE criteria_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'default',
  include_keywords JSONB NOT NULL DEFAULT '[]',
  exclude_keywords JSONB NOT NULL DEFAULT '[]',
  target_audience_description TEXT NOT NULL DEFAULT '',
  default_hashtags JSONB NOT NULL DEFAULT '[]',
  max_posts_per_day_per_platform JSONB NOT NULL DEFAULT '{"linkedin": 3, "facebook": 3, "instagram": 3, "x": 5}',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_criteria_configs_active ON criteria_configs(active);
```

### Table: `media_assets`

Images and media stored in Supabase Storage.

```sql
CREATE TABLE media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  description TEXT,
  supabase_path TEXT NOT NULL,
  public_url TEXT NOT NULL,
  platforms_allowed JSONB NOT NULL DEFAULT '["linkedin", "facebook", "instagram", "x"]',
  file_size_bytes INTEGER,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Table: `social_posts`

Platform-specific posts linked to articles.

```sql
CREATE TABLE social_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('linkedin', 'facebook', 'instagram', 'x')),
  canonical_post_json JSONB NOT NULL,
  content_draft TEXT NOT NULL,
  content_final TEXT,
  media_asset_ids JSONB DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT',
    'APPROVED',
    'PUBLISHED',
    'FAILED',
    'SKIPPED'
  )),
  error_message TEXT,
  external_post_id TEXT,
  scheduled_for TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_social_posts_article_id ON social_posts(article_id);
CREATE INDEX idx_social_posts_platform ON social_posts(platform);
CREATE INDEX idx_social_posts_status ON social_posts(status);
CREATE INDEX idx_social_posts_published_at ON social_posts(published_at DESC);
```

### Table: `platform_credentials`

Encrypted OAuth tokens and API credentials per platform.

```sql
CREATE TABLE platform_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL UNIQUE CHECK (platform IN ('linkedin', 'facebook', 'instagram', 'x')),
  config_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Table: `activity_logs`

Audit trail for all system actions.

```sql
CREATE TABLE activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_logs_type ON activity_logs(type);
CREATE INDEX idx_activity_logs_created_at ON activity_logs(created_at DESC);
```

---

## Supabase Storage Layout

### Bucket: `social-media-assets`

```
social-media-assets/
├── articles/
│   └── {article_id}/
│       ├── og-image.jpg          # OpenGraph image from article
│       └── custom-{timestamp}.jpg # Manual uploads
├── defaults/
│   └── brand-logo.png            # Default fallback images
└── screenshots/
    └── {social_post_id}/
        └── verification-{timestamp}.png  # Visual verification screenshots
```

**Access Configuration:**
- Public read access for `articles/` and `defaults/`
- Private write access (service role key only)
- Screenshots bucket may be private

---

## Service Architecture

### Pipeline Flow

```
┌─────────────────────┐
│  SourceWatcherService │  Monitors RSS feeds, creates articles
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ ArticleFetcherService │  Fetches full content from URLs
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ RelevanceFilterService│  Filters by keywords
└──────────┬──────────┘
           │
           ▼
┌─────────────────────────┐
│ CanonicalPostGenerator  │  Creates platform-agnostic post idea
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  PostFormattingService  │  Formats for each platform
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│    MediaService         │  Handles image uploads
└──────────┬──────────────┘
           │
           ├──────────────┬──────────────┬──────────────┐
           ▼              ▼              ▼              ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ LinkedInSvc │ │ FacebookSvc │ │ InstagramSvc│ │    XSvc     │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

### Services Overview

#### 1. SourceWatcherService
- Loads active `blog_sources` from Supabase
- Parses RSS/Atom feeds using `rss-parser`
- Creates `articles` with status `NEW`
- Deduplicates using `external_id`

#### 2. ArticleFetcherService
- Fetches full HTML content for `NEW` articles
- Extracts main content using Cheerio selectors
- Updates `raw_content` in Supabase
- Handles retries and error states

#### 3. RelevanceFilterService
- Loads active `criteria_configs`
- Applies include/exclude keyword matching
- Updates article status to `READY_FOR_POST` or `REJECTED_NOT_RELEVANT`

#### 4. CanonicalPostGenerator
- Uses OpenAI to generate platform-agnostic post structure
- Stores result in `canonical_post_json`

#### 5. PostFormattingService
- Platform-specific formatters for LinkedIn, Facebook, Instagram, X
- Respects character limits and style guidelines
- Generates `content_draft` for each platform

#### 6. MediaService
- Uploads images to Supabase Storage
- Creates `media_assets` records
- Links assets to `social_posts`

#### 7. Platform Publisher Services
Each publisher:
- Reads credentials from `platform_credentials`
- Posts to platform API
- Updates `external_post_id` and status

---

## Canonical Post Object

```typescript
interface CanonicalPost {
  articleId: string;
  mainIdea: string;
  keyInsights: string[];  // 3-7 specific insights
  targetAudience: string;
  toneGuidelines: string;
  suggestedCallToAction: string | null;
  tags: string[];         // Up to 10 topic tags
  articleUrl: string;
  articleTitle: string;
}
```

---

## Platform Formatting Rules

### LinkedIn
- **Hard limit:** 3,000 characters
- **Target:** 1,200-2,000 characters
- **Style:**
  - Short paragraphs
  - Hook in first 2 lines (shown before "see more")
  - 3 relevant, niche hashtags at end
  - Include article URL

### Facebook
- **Hard limit:** ~63,206 characters
- **Target:** 500-1,500 characters
- **Style:**
  - Conversational tone
  - Can be similar to LinkedIn
  - Hashtags optional (0-3)
  - Include article URL

### Instagram
- **Hard limit:** 2,200 characters
- **First visible:** ~125 characters before "more"
- **Style:**
  - Strong first sentence (hook)
  - More visual/emotional language
  - 5-10 hashtags at end
  - URL in bio reference only (not clickable)

### X (Twitter)
- **Hard limit:** 280 characters (standard)
- **Target:** 240-260 characters
- **Style:**
  - Single punchy insight
  - 1-2 hashtags maximum
  - URL included (counts against limit)
  - Use t.co shortener

---

## Platform Credentials Structure

### LinkedIn
```json
{
  "memberUrn": "urn:li:person:XXXXX",
  "accessToken": "encrypted_token",
  "refreshToken": "encrypted_token",
  "expiresAt": "2024-12-01T00:00:00Z",
  "scopes": ["openid", "profile", "w_member_social"]
}
```

### Facebook
```json
{
  "appId": "123456789",
  "appSecret": "encrypted_secret",
  "pageId": "987654321",
  "pageAccessToken": "encrypted_token",
  "tokenExpiresAt": "2024-12-01T00:00:00Z"
}
```

### Instagram
```json
{
  "appId": "123456789",
  "appSecret": "encrypted_secret",
  "facebookPageId": "987654321",
  "instagramAccountId": "17841400000000000",
  "accessToken": "encrypted_token",
  "tokenExpiresAt": "2024-12-01T00:00:00Z"
}
```

### X (Twitter)
```json
{
  "apiKey": "encrypted_key",
  "apiSecret": "encrypted_secret",
  "accessToken": "encrypted_token",
  "accessTokenSecret": "encrypted_secret",
  "bearerToken": "encrypted_token"
}
```

---

## Article-to-Posts Mapping

One article can generate multiple `social_posts` rows:

```
Article (id: abc-123)
├── social_posts (platform: linkedin, article_id: abc-123)
├── social_posts (platform: facebook, article_id: abc-123)
├── social_posts (platform: instagram, article_id: abc-123)
└── social_posts (platform: x, article_id: abc-123)
```

### Per-Platform Toggles

Controlled via environment or criteria config:

```typescript
// Environment
AUTO_POST_PLATFORMS=["linkedin", "facebook", "x"]
MANUAL_REVIEW_ENABLED=true

// Or per-source in blog_sources
enabled_platforms: ["linkedin", "x"]  // Optional future field
```

---

## Image Handling

### Automatic Image Extraction
1. Parse article HTML for OpenGraph image: `<meta property="og:image">`
2. Fall back to first `<img>` in main content
3. Download and upload to Supabase Storage
4. Create `media_assets` record
5. Link to all `social_posts` for that article

### Manual Image Assignment
1. Upload via admin API or CLI
2. Optionally specify `platforms_allowed`
3. Link to specific `social_posts`

### Platform Image Requirements
| Platform | Min Size | Max Size | Aspect Ratio | Format |
|----------|----------|----------|--------------|--------|
| LinkedIn | 552x276 | 7680x4320 | 1.91:1 preferred | JPG, PNG |
| Facebook | 600x315 | varies | 1.91:1 for links | JPG, PNG |
| Instagram | 1080x1080 | 1080x1350 | 1:1 or 4:5 | JPG, PNG |
| X | 600x335 | 4096x4096 | 16:9 preferred | JPG, PNG, GIF |

---

## Scheduler and Rate Limiting

### Job Schedule
| Job | Cron | Purpose |
|-----|------|---------|
| Source Watcher | `*/30 * * * *` | Check RSS feeds |
| Article Fetcher | `*/10 * * * *` | Fetch content |
| Relevance Filter | `*/10 * * * *` | Filter articles |
| Post Generator | `0 * * * *` | Generate canonical posts |
| Platform Publisher | `0 9,12,15 * * *` | Publish to platforms |

### Rate Limits
Read from `criteria_configs.max_posts_per_day_per_platform`:

```json
{
  "linkedin": 3,
  "facebook": 5,
  "instagram": 3,
  "x": 10
}
```

Scheduler checks 24-hour rolling window before publishing.

---

## Visual Verification (Playwright)

After publishing, optionally:
1. Open platform profile/page
2. Locate the new post
3. Take screenshot
4. Store in Supabase Storage: `screenshots/{post_id}/verification-{timestamp}.png`
5. Log verification result

**Not used for:** Posting, authentication, bypassing rate limits

---

## Environment Variables

```bash
# Supabase
SUPABASE_URL="https://xxxxx.supabase.co"
SUPABASE_ANON_KEY="eyJ..."
SUPABASE_SERVICE_ROLE_KEY="eyJ..."

# OpenAI
OPENAI_API_KEY="sk-..."
OPENAI_MODEL="gpt-4o"

# Server
PORT=3000
NODE_ENV="production"

# Features
AUTO_POST_PLATFORMS='["linkedin","facebook","x"]'
MANUAL_REVIEW_ENABLED=true

# Encryption (for tokens in config_json)
ENCRYPTION_KEY="32_byte_hex_key"
```

---

## Health Check Endpoint

`GET /health/social_autoposter`

Checks:
- [ ] Supabase connectivity
- [ ] At least one active `blog_sources`
- [ ] `platform_credentials` exist for enabled platforms
- [ ] OpenAI API key valid
- [ ] Optional: dry-run formatting test

Response:
```json
{
  "status": "healthy",
  "checks": {
    "supabase": { "ok": true },
    "sources": { "ok": true, "count": 5 },
    "platforms": {
      "linkedin": { "ok": true, "credentialsPresent": true },
      "facebook": { "ok": true, "credentialsPresent": true },
      "instagram": { "ok": false, "error": "Missing credentials" },
      "x": { "ok": true, "credentialsPresent": true }
    },
    "openai": { "ok": true }
  }
}
```

---

## Files to Create/Modify

### New Files
- `src/config/supabase.ts` - Supabase client
- `src/services/CanonicalPostGenerator.ts`
- `src/services/PostFormattingService.ts`
- `src/services/MediaService.ts`
- `src/services/FacebookPublisherService.ts`
- `src/services/InstagramPublisherService.ts`
- `src/services/XPublisherService.ts`
- `src/routes/media.ts` - Media upload endpoints
- `supabase/migrations/*.sql` - Database migrations

### Modified Files
- `src/services/SourceWatcherService.ts` - Use Supabase
- `src/services/ArticleFetcherService.ts` - Use Supabase
- `src/services/RelevanceFilterService.ts` - Use Supabase
- `src/services/LinkedInPublisherService.ts` - Use Supabase
- `src/scheduler.ts` - Multi-platform scheduling
- `src/routes/admin.ts` - Multi-platform endpoints
- `src/routes/health.ts` - Enhanced health checks
- `.env.example` - New environment variables

### Remove/Deprecate
- `prisma/schema.prisma` - Replace with Supabase
- SQLite database file

---

## Migration Strategy

1. **Create Supabase schema** via migrations
2. **Implement Supabase client** and helpers
3. **Migrate services one by one**, keeping existing functionality
4. **Add new platform services** incrementally
5. **Test with manual review mode** before enabling auto-post
6. **Run visual verification** after each platform integration

---

## Implementation Status

All core services have been implemented:

| Service | Status | File |
|---------|--------|------|
| Supabase Config | ✅ Complete | `src/config/supabase.ts` |
| Environment Config | ✅ Complete | `src/config/env.ts` |
| Encryption Utils | ✅ Complete | `src/utils/crypto.ts` |
| Source Watcher | ✅ Complete | `src/services/SourceWatcherService.ts` |
| Article Fetcher | ✅ Complete | `src/services/ArticleFetcherService.ts` |
| Relevance Filter | ✅ Complete | `src/services/RelevanceFilterService.ts` |
| Canonical Post Generator | ✅ Complete | `src/services/CanonicalPostGenerator.ts` |
| Post Formatting | ✅ Complete | `src/services/PostFormattingService.ts` |
| Media Service | ✅ Complete | `src/services/MediaService.ts` |
| Base Publisher | ✅ Complete | `src/services/BasePublisherService.ts` |
| LinkedIn Publisher | ✅ Complete | `src/services/LinkedInPublisherService.ts` |
| Facebook Publisher | ✅ Complete | `src/services/FacebookPublisherService.ts` |
| Instagram Publisher | ✅ Complete | `src/services/InstagramPublisherService.ts` |
| X Publisher | ✅ Complete | `src/services/XPublisherService.ts` |
| Scheduler | ✅ Complete | `src/services/SchedulerService.ts` |
| Visual Verification | ✅ Complete | `src/services/VisualVerificationService.ts` |
| Health Check | ✅ Complete | `src/services/HealthCheckService.ts` |

---

## Setup Guide

### 1. Prerequisites

- Node.js 18+ installed
- Supabase account and project created
- OpenAI API key
- Platform API credentials (see below)

### 2. Install Dependencies

```bash
npm install
```

New dependencies added:
- `@supabase/supabase-js` - Supabase client
- `oauth-1.0a` - OAuth 1.0a for X/Twitter API

### 3. Set Up Supabase

1. Create a new Supabase project at https://supabase.com
2. Go to SQL Editor and run the migration script:

```bash
# Copy contents of supabase/migrations/001_initial_schema.sql
```

3. Create a Storage bucket named `media-assets`:
   - Go to Storage in Supabase dashboard
   - Create bucket with public access for reading

4. Get your credentials from Project Settings > API:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`

### 4. Configure Environment Variables

Create a `.env` file:

```bash
# Supabase
SUPABASE_URL="https://xxxxx.supabase.co"
SUPABASE_ANON_KEY="eyJ..."
SUPABASE_SERVICE_ROLE_KEY="eyJ..."

# OpenAI
OPENAI_API_KEY="sk-..."
OPENAI_MODEL="gpt-4o"

# Encryption (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
ENCRYPTION_KEY="your_32_byte_hex_key_here"

# Platforms to auto-post to
AUTO_POST_PLATFORMS='["linkedin"]'

# LinkedIn (required if enabled)
LINKEDIN_CLIENT_ID="your_client_id"
LINKEDIN_CLIENT_SECRET="your_client_secret"
LINKEDIN_ACCESS_TOKEN="your_access_token"
LINKEDIN_MEMBER_URN="urn:li:person:xxxxx"
LINKEDIN_REDIRECT_URI="http://localhost:3000/auth/linkedin/callback"

# Facebook (optional)
FACEBOOK_APP_ID="your_app_id"
FACEBOOK_APP_SECRET="your_app_secret"
FACEBOOK_PAGE_ID="your_page_id"
FACEBOOK_PAGE_ACCESS_TOKEN="your_page_access_token"

# Instagram (optional)
INSTAGRAM_ACCOUNT_ID="your_instagram_business_account_id"
INSTAGRAM_ACCESS_TOKEN="your_access_token"
INSTAGRAM_FACEBOOK_PAGE_ID="linked_facebook_page_id"

# X/Twitter (optional)
X_API_KEY="your_api_key"
X_API_SECRET="your_api_secret"
X_ACCESS_TOKEN="your_access_token"
X_ACCESS_TOKEN_SECRET="your_access_token_secret"
X_USER_ID="your_user_id"
```

### 5. Platform Setup

#### LinkedIn
1. Create app at https://www.linkedin.com/developers/
2. Request `openid`, `profile`, `email`, `w_member_social` permissions
3. Set up OAuth redirect URI
4. Complete OAuth flow to get access token

#### Facebook
1. Create app at https://developers.facebook.com/
2. Add Facebook Login product
3. Get Page Access Token with `pages_manage_posts` permission
4. For long-lived tokens, use the token exchange endpoint

#### Instagram
1. Instagram Business account must be linked to a Facebook Page
2. Use Meta Graph API with the Facebook Page's access token
3. Get Instagram Business Account ID via `/me/accounts?fields=instagram_business_account`

#### X (Twitter)
1. Apply for developer account at https://developer.twitter.com/
2. Create project and app with OAuth 1.0a User Context
3. Generate access tokens with `tweet.read`, `tweet.write` scopes

### 6. Run the Application

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

### 7. Verify Setup

Use the health check service:

```typescript
import { healthCheckService } from './src/services/HealthCheckService';

const status = await healthCheckService.runHealthCheck();
console.log(JSON.stringify(status, null, 2));
```

---

## API Usage Examples

### Start the Scheduler

```typescript
import { schedulerService } from './src/services/SchedulerService';

// Start automatic processing
schedulerService.start();

// Run pipeline manually
const results = await schedulerService.runPipeline();

// Check rate limits
const limits = await schedulerService.getRateLimitStatus();

// Stop scheduler
schedulerService.stop();
```

### Publish a Single Post

```typescript
import { linkedInPublisherService } from './src/services/LinkedInPublisherService';

const result = await linkedInPublisherService.publishPost('post-uuid');
console.log(result); // { success: true, externalPostId: '...', externalPostUrl: '...' }
```

### Test Platform Connections

```typescript
import { schedulerService } from './src/services/SchedulerService';

const connections = await schedulerService.testAllConnections();
// Returns status for each platform
```

### Visual Verification

```typescript
import { visualVerificationService } from './src/services/VisualVerificationService';

// Verify a specific post
const result = await visualVerificationService.verifyPost('post-uuid');

// Verify all recent posts
const results = await visualVerificationService.verifyRecentPosts(24); // Last 24 hours

// Run smoke test
const smokeTest = await visualVerificationService.runSmokeTest();
```

### Health Check

```typescript
import { healthCheckService } from './src/services/HealthCheckService';

// Full health check
const health = await healthCheckService.runHealthCheck();

// Quick liveness check
const isAlive = await healthCheckService.isAlive();

// Pipeline status
const pipeline = await healthCheckService.getPipelineStatus();

// Recent activity
const activity = await healthCheckService.getRecentActivity(10);
```

---

## Troubleshooting

### Common Issues

1. **"Instagram requires an image for posts"**
   - Instagram API only supports photo/video posts
   - Ensure articles have OpenGraph images or upload manual images

2. **"LinkedIn access token expired"**
   - LinkedIn tokens expire after 60 days
   - Re-authenticate using OAuth flow

3. **"Facebook API error: Invalid token"**
   - Page access tokens expire unless you use long-lived tokens
   - Exchange short-lived token for long-lived using `exchangeForLongLivedToken()`

4. **Rate limit reached**
   - Check `criteria_configs.max_posts_per_day_per_platform`
   - View rate limit status via `schedulerService.getRateLimitStatus()`

5. **Visual verification showing login page**
   - Platform requires authentication
   - Use `visualVerificationService.openForLogin(platform)` to log in manually

### Debugging

Enable verbose logging:

```bash
LOG_LEVEL=debug npm start
```

Check activity logs in Supabase:

```sql
SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 50;
```
