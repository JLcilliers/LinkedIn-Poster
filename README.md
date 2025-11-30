# LinkedIn Blog Reposter

A service that monitors blogs for new articles, filters them based on your criteria, generates professional LinkedIn posts using AI, and publishes them via the official LinkedIn API.

## Features

- **Blog Monitoring**: Automatically checks RSS feeds and sitemaps for new content
- **Smart Filtering**: Filter articles based on include/exclude keywords
- **AI Post Generation**: Uses OpenAI to create engaging, human-sounding LinkedIn posts in UK English
- **LinkedIn Integration**: Posts via official LinkedIn API with OAuth 2.0
- **Manual Review Mode**: Optional approval workflow before posting
- **Rate Limiting**: Respects daily post limits
- **Visual Verification**: Playwright-based screenshots for verification (not for posting)
- **Comprehensive Logging**: Activity logs and health checks

## Setup

### 1. Prerequisites

- Node.js 18+
- npm or yarn

### 2. Installation

```bash
# Install dependencies
npm install

# Set up database
npx prisma migrate dev

# Generate Prisma client
npx prisma generate
```

### 3. Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required settings:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | SQLite database path (default: `file:./dev.db`) |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `LINKEDIN_CLIENT_ID` | LinkedIn app client ID |
| `LINKEDIN_CLIENT_SECRET` | LinkedIn app client secret |
| `LINKEDIN_REDIRECT_URI` | OAuth callback URL |

Optional settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_POST_TO_LINKEDIN` | `false` | Auto-publish approved posts |
| `MANUAL_REVIEW_MODE` | `true` | Require manual approval |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model to use |
| `WATCHER_CRON` | `*/30 * * * *` | Source check frequency |
| `POSTER_CRON` | `0 9,12,15 * * *` | Post publishing times |

### 4. LinkedIn App Setup

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/apps)
2. Create a new app
3. Add the OAuth 2.0 redirect URL: `http://localhost:3000/auth/linkedin/callback`
4. Request the `w_member_social` scope
5. Copy Client ID and Client Secret to `.env`

### 5. Start the Server

```bash
# Development mode (with hot reload)
npm run dev

# Production mode
npm run build && npm start
```

### 6. Authorize LinkedIn

Visit `http://localhost:3000/auth/linkedin` to connect your LinkedIn account.

## Usage

### CLI Commands

```bash
# Add a blog source
npm run cli -- sources add "TechCrunch" "https://techcrunch.com/feed/"

# List sources
npm run cli -- sources list

# Check sources for new articles
npm run cli -- sources check

# Set filtering criteria
npm run cli -- criteria set --include "AI,startup,technology" --target "tech leaders and entrepreneurs"

# Run full pipeline
npm run cli -- pipeline

# List pending posts for review
npm run cli -- posts pending

# Approve a post
npm run cli -- posts approve <post-id>

# Publish a post
npm run cli -- posts publish <post-id>

# Check LinkedIn status
npm run cli -- linkedin status
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Full health check |
| GET | `/health/config` | Configuration status |
| GET | `/admin/sources` | List blog sources |
| POST | `/admin/sources` | Add a source |
| POST | `/admin/sources/check` | Check sources now |
| GET | `/admin/articles/stats` | Article statistics |
| GET | `/admin/posts/pending` | Pending posts |
| POST | `/admin/posts/:id/approve` | Approve a post |
| POST | `/admin/posts/:id/publish` | Publish a post |
| GET | `/auth/linkedin` | Start OAuth flow |
| GET | `/auth/linkedin/test` | Test connection |

### Workflow

1. **Add Sources**: Add RSS feeds or sitemaps to monitor
2. **Set Criteria**: Define include/exclude keywords and target audience
3. **Monitor**: The scheduler checks sources every 30 minutes
4. **Review**: View generated posts at `/admin/posts/pending`
5. **Publish**: Approve posts for automatic or manual publishing

## AI Prompt Guidelines

Posts are generated to:

- Use UK English spelling and grammar
- Sound like a human professional sharing insights
- Include a strong hook in the first 2-3 lines
- Present 3-5 concrete takeaways
- Use at most 3 emojis (sparingly)
- Include relevant hashtags at the end only
- Stay within 1200-2000 characters (max 3000)

## Safety Controls

- **No credential logging**: Secrets are never logged
- **Token encryption**: Access tokens encrypted at rest
- **Rate limiting**: Respects daily post limits
- **Manual review**: Optional approval before posting
- **No browser posting**: Uses official API only

## Visual Verification

Playwright is used sparingly for:

- Taking screenshots to verify posts
- Smoke testing the LinkedIn UI
- NOT for bypassing security or posting

```bash
# Open browser for LinkedIn login
npm run cli -- visual login

# Take a screenshot
npm run cli -- visual screenshot "https://www.linkedin.com/feed/"

# Run smoke test
npm run cli -- visual smoke-test
```

## File Structure

```
src/
├── config/
│   ├── database.ts       # Prisma client
│   └── env.ts            # Environment config
├── services/
│   ├── SourceWatcherService.ts
│   ├── ArticleFetcherService.ts
│   ├── RelevanceFilterService.ts
│   ├── PostGeneratorService.ts
│   ├── LinkedInPublisherService.ts
│   └── VisualVerificationService.ts
├── routes/
│   ├── admin.ts          # Admin endpoints
│   ├── auth.ts           # OAuth endpoints
│   └── health.ts         # Health checks
├── utils/
│   ├── contentExtractor.ts
│   ├── crypto.ts
│   └── logger.ts
├── types/
│   └── index.ts
├── scheduler.ts
├── cli.ts
└── index.ts
```

## Development

```bash
# Run linting
npm run lint

# Open database studio
npm run db:studio

# Create migration
npm run db:migrate
```

## Troubleshooting

### "LinkedIn authorization failed"
- Verify Client ID and Secret in `.env`
- Check redirect URI matches LinkedIn app settings
- Ensure required scopes are approved

### "OpenAI returned empty response"
- Verify API key is valid
- Check you have available credits/quota
- Try a different model

### "No valid LinkedIn access token"
- Re-authorize at `/auth/linkedin`
- Tokens expire after 60 days

## License

ISC
