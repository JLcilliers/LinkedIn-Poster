# LinkedIn Blog Reposter - Design Document

## Overview

A service that monitors blogs for new articles, filters them based on criteria, generates LinkedIn posts using AI, and publishes them via the official LinkedIn API.

## Architecture

```
┌─────────────────┐     ┌───────────────────┐     ┌─────────────────────┐
│  Blog Sources   │────▶│ SourceWatcher     │────▶│  Article Database   │
│  (RSS/Sitemap)  │     │ Service           │     │                     │
└─────────────────┘     └───────────────────┘     └──────────┬──────────┘
                                                             │
                        ┌───────────────────┐                │
                        │ ArticleFetcher    │◀───────────────┘
                        │ Service           │
                        └────────┬──────────┘
                                 │
                        ┌────────▼──────────┐
                        │ RelevanceFilter   │
                        │ Service           │
                        └────────┬──────────┘
                                 │
                        ┌────────▼──────────┐
                        │ PostGenerator     │
                        │ Service (AI)      │
                        └────────┬──────────┘
                                 │
                        ┌────────▼──────────┐     ┌─────────────────┐
                        │ LinkedInPublisher │────▶│  LinkedIn API   │
                        │ Service           │     │                 │
                        └───────────────────┘     └─────────────────┘
```

## Data Models

### BlogSource
Stores information about blogs/websites to monitor.
- `id`: UUID primary key
- `name`: Human-readable name
- `feedUrl`: RSS feed URL or API endpoint
- `type`: RSS | SITEMAP | CUSTOM_SCRAPER
- `active`: Whether to monitor this source
- `lastCheckedAt`: When last polled
- `lastSeenExternalId`: For deduplication
- `lastSeenPublishedAt`: For filtering old articles

### Article
Stores fetched articles and their processing status.
- `id`: UUID primary key
- `sourceId`: Foreign key to BlogSource
- `externalId`: RSS GUID or unique identifier
- `url`: Article URL
- `title`: Article title
- `rawSummary`: Short summary from feed
- `rawContent`: Full extracted article text
- `publishedAt`: Original publish date
- `status`: NEW | FETCHING_CONTENT | CONTENT_FETCHED | REJECTED_NOT_RELEVANT | READY_FOR_POST | POST_GENERATED | POSTED_TO_LINKEDIN | FAILED
- `errorMessage`: If status is FAILED

### LinkedInPost
Stores generated LinkedIn posts.
- `id`: UUID primary key
- `articleId`: Foreign key to Article
- `contentDraft`: AI-generated draft
- `contentFinal`: Final posted content
- `mode`: AUTO | MANUAL_REVIEWED
- `linkedInPostUrn`: LinkedIn's URN for the post
- `linkedInPostUrl`: URL to the post
- `status`: DRAFT | PENDING_REVIEW | APPROVED | PUBLISHING | PUBLISHED | FAILED
- `errorMessage`: If status is FAILED

### CriteriaConfig
Stores filtering criteria.
- `id`: UUID primary key
- `name`: Profile name
- `includeKeywords`: JSON array of keywords to match
- `excludeKeywords`: JSON array of keywords to exclude
- `targetAudienceDescription`: Used in AI prompt
- `defaultHashtags`: JSON array of hashtags
- `maxPostsPerDay`: Rate limit
- `active`: Whether this config is active

## Core Services

### SourceWatcherService
Polls blog sources on a schedule.
- Runs every 30 minutes (configurable)
- Fetches RSS/sitemap feeds
- Creates new Article records for new items
- Updates lastCheckedAt and lastSeenPublishedAt

### ArticleFetcherService
Extracts full article content.
- Processes articles with status NEW
- Fetches article URL
- Extracts main content using cheerio
- Updates rawContent and status

### RelevanceFilterService
Filters articles based on criteria.
- Loads active CriteriaConfig
- Checks includeKeywords (at least one must match)
- Checks excludeKeywords (none should match)
- Updates article status to READY_FOR_POST or REJECTED_NOT_RELEVANT

### PostGeneratorService
Generates LinkedIn posts using AI.
- Uses OpenAI GPT-4o (configurable)
- Applies UK English, professional tone
- Creates engaging hook in first 2-3 lines
- Respects 3000 character limit (target 1200-2000)
- Stores draft in LinkedInPost table

### LinkedInPublisherService
Publishes to LinkedIn via official API.
- OAuth 2.0 authentication
- Creates text posts using ugcPosts API
- Respects daily post limits
- Handles errors gracefully

## Scheduling

| Job | Cron Expression | Description |
|-----|-----------------|-------------|
| Source Watcher | `*/30 * * * *` | Every 30 minutes |
| Content Fetcher | `*/10 * * * *` | Every 10 minutes |
| Relevance Filter | `*/10 * * * *` | Every 10 minutes |
| Post Generator | `0 * * * *` | Every hour |
| LinkedIn Poster | `0 9,12,15 * * *` | 9am, 12pm, 3pm |

## Configuration

### Environment Variables
See `.env.example` for all required variables:
- `DATABASE_URL`: SQLite/PostgreSQL connection
- `LINKEDIN_CLIENT_ID`: LinkedIn app client ID
- `LINKEDIN_CLIENT_SECRET`: LinkedIn app client secret
- `LINKEDIN_ACCESS_TOKEN`: OAuth access token
- `LINKEDIN_MEMBER_URN`: Your LinkedIn member URN
- `OPENAI_API_KEY`: OpenAI API key
- `AUTO_POST_TO_LINKEDIN`: Enable/disable auto-posting
- `MANUAL_REVIEW_MODE`: Require manual approval

### Adding Blog Sources
Use the admin CLI or API:
```bash
npm run cli -- sources add --name "TechCrunch" --url "https://techcrunch.com/feed/"
```

### Updating Criteria
Use the admin CLI or API:
```bash
npm run cli -- criteria update --include "AI,machine learning,startup"
```

## Manual Review Mode

When `MANUAL_REVIEW_MODE=true`:
1. Generated posts are set to `PENDING_REVIEW`
2. Admin reviews at `GET /admin/posts/pending`
3. Approve with `POST /admin/posts/:id/approve`
4. Reject with `POST /admin/posts/:id/reject`

## Safety Controls

1. **Daily post limit**: Respects `maxPostsPerDay` from CriteriaConfig
2. **Duplicate prevention**: Unique constraint on (sourceId, externalId)
3. **Rate limiting**: Exponential backoff on LinkedIn API errors
4. **Token security**: Access tokens encrypted at rest
5. **No credential logging**: Secrets never appear in logs

## Visual Verification (Playwright)

Used sparingly for:
- Smoke testing that posts appear correctly
- Capturing screenshots for review
- NOT for bypassing LinkedIn security

## Health Checks

`GET /health` returns:
- Database connectivity
- Active blog sources count
- LinkedIn API status
- OpenAI API status
- Last successful post time

## File Structure

```
src/
├── config/
│   ├── env.ts           # Environment variable validation
│   └── database.ts      # Prisma client singleton
├── services/
│   ├── SourceWatcherService.ts
│   ├── ArticleFetcherService.ts
│   ├── RelevanceFilterService.ts
│   ├── PostGeneratorService.ts
│   └── LinkedInPublisherService.ts
├── routes/
│   ├── admin.ts         # Admin endpoints
│   ├── auth.ts          # LinkedIn OAuth endpoints
│   └── health.ts        # Health check endpoints
├── utils/
│   ├── logger.ts        # Winston logger
│   ├── crypto.ts        # Token encryption
│   └── contentExtractor.ts
├── types/
│   └── index.ts         # TypeScript types
├── scheduler.ts         # Cron job setup
└── index.ts             # Express app entry point
```
