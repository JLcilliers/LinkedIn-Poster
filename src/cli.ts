#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { connectDatabase, disconnectDatabase, prisma } from './config/database';
import { sourceWatcherService } from './services/SourceWatcherService';
import { articleFetcherService } from './services/ArticleFetcherService';
import { relevanceFilterService } from './services/RelevanceFilterService';
import { postGeneratorService } from './services/PostGeneratorService';
import { linkedInPublisherService } from './services/LinkedInPublisherService';
import { visualVerificationService } from './services/VisualVerificationService';
import { scheduler } from './scheduler';

const program = new Command();

program
  .name('linkedin-reposter')
  .description('LinkedIn Blog Reposter CLI')
  .version('1.0.0');

// ===== SOURCES =====

const sourcesCmd = program.command('sources').description('Manage blog sources');

sourcesCmd
  .command('list')
  .description('List all blog sources')
  .option('-a, --active', 'Only show active sources')
  .action(async (options) => {
    await connectDatabase();
    const sources = await sourceWatcherService.listSources(options.active);
    console.table(sources.map(s => ({
      id: s.id.substring(0, 8),
      name: s.name,
      type: s.type,
      active: s.active,
      lastChecked: s.lastCheckedAt?.toISOString() || 'Never',
    })));
    await disconnectDatabase();
  });

sourcesCmd
  .command('add <name> <url>')
  .description('Add a new blog source')
  .option('-t, --type <type>', 'Source type (RSS, SITEMAP)', 'RSS')
  .action(async (name, url, options) => {
    await connectDatabase();
    const source = await sourceWatcherService.addSource(name, url, options.type);
    console.log(`Added source: ${source.name} (${source.id})`);
    await disconnectDatabase();
  });

sourcesCmd
  .command('check')
  .description('Check all sources for new articles')
  .action(async () => {
    await connectDatabase();
    console.log('Checking sources...');
    const results = await sourceWatcherService.checkAllSources();
    const totalNew = results.reduce((sum, r) => sum + r.articlesNew, 0);
    console.log(`Found ${totalNew} new articles`);
    await disconnectDatabase();
  });

sourcesCmd
  .command('remove <id>')
  .description('Remove a blog source')
  .action(async (id) => {
    await connectDatabase();
    await sourceWatcherService.deleteSource(id);
    console.log('Source removed');
    await disconnectDatabase();
  });

// ===== ARTICLES =====

const articlesCmd = program.command('articles').description('Manage articles');

articlesCmd
  .command('stats')
  .description('Show article statistics')
  .action(async () => {
    await connectDatabase();
    const stats = await articleFetcherService.getStats();
    console.table(stats);
    await disconnectDatabase();
  });

articlesCmd
  .command('list')
  .description('List articles by status')
  .option('-s, --status <status>', 'Filter by status', 'NEW')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    await connectDatabase();
    const articles = await articleFetcherService.getArticlesByStatus(
      options.status,
      parseInt(options.limit)
    );
    console.table(articles.map(a => ({
      id: a.id.substring(0, 8),
      title: a.title.substring(0, 50),
      status: a.status,
      date: a.publishedAt?.toLocaleDateString() || 'Unknown',
    })));
    await disconnectDatabase();
  });

articlesCmd
  .command('fetch')
  .description('Fetch content for pending articles')
  .action(async () => {
    await connectDatabase();
    console.log('Fetching article content...');
    const results = await articleFetcherService.fetchAllPendingContent();
    console.log(`Processed: ${results.processed}, Success: ${results.success}, Failed: ${results.failed}`);
    await disconnectDatabase();
  });

articlesCmd
  .command('filter')
  .description('Filter articles for relevance')
  .action(async () => {
    await connectDatabase();
    console.log('Filtering articles...');
    const results = await relevanceFilterService.filterAllPending();
    console.log(`Processed: ${results.processed}, Relevant: ${results.relevant}, Rejected: ${results.rejected}`);
    await disconnectDatabase();
  });

// ===== CRITERIA =====

const criteriaCmd = program.command('criteria').description('Manage filtering criteria');

criteriaCmd
  .command('show')
  .description('Show current criteria')
  .action(async () => {
    await connectDatabase();
    const criteria = await relevanceFilterService.getCurrentCriteria();
    if (criteria) {
      console.log('\nCurrent Criteria:');
      console.log(`  Name: ${criteria.name}`);
      console.log(`  Include Keywords: ${criteria.includeKeywords}`);
      console.log(`  Exclude Keywords: ${criteria.excludeKeywords}`);
      console.log(`  Target Audience: ${criteria.targetAudienceDescription}`);
      console.log(`  Hashtags: ${criteria.defaultHashtags}`);
      console.log(`  Max Posts/Day: ${criteria.maxPostsPerDay}`);
    } else {
      console.log('No criteria configured');
    }
    await disconnectDatabase();
  });

criteriaCmd
  .command('set')
  .description('Set filtering criteria')
  .option('-i, --include <keywords>', 'Comma-separated include keywords')
  .option('-e, --exclude <keywords>', 'Comma-separated exclude keywords')
  .option('-t, --target <description>', 'Target audience description')
  .option('-h, --hashtags <hashtags>', 'Comma-separated default hashtags')
  .option('-m, --max <number>', 'Max posts per day')
  .action(async (options) => {
    await connectDatabase();
    const criteria = await relevanceFilterService.setCriteria({
      includeKeywords: options.include?.split(',').map((s: string) => s.trim()),
      excludeKeywords: options.exclude?.split(',').map((s: string) => s.trim()),
      targetAudienceDescription: options.target,
      defaultHashtags: options.hashtags?.split(',').map((s: string) => s.trim()),
      maxPostsPerDay: options.max ? parseInt(options.max) : undefined,
    });
    console.log('Criteria updated:', criteria.id);
    await disconnectDatabase();
  });

// ===== POSTS =====

const postsCmd = program.command('posts').description('Manage LinkedIn posts');

postsCmd
  .command('pending')
  .description('List pending posts for review')
  .action(async () => {
    await connectDatabase();
    const posts = await postGeneratorService.getPendingPosts();
    if (posts.length === 0) {
      console.log('No pending posts');
    } else {
      for (const post of posts) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`ID: ${post.id}`);
        console.log(`Article: ${post.article.title}`);
        console.log(`Status: ${post.status}`);
        console.log(`Created: ${post.createdAt.toISOString()}`);
        console.log(`\n${post.contentDraft}`);
      }
    }
    await disconnectDatabase();
  });

postsCmd
  .command('generate')
  .description('Generate posts for ready articles')
  .action(async () => {
    await connectDatabase();
    console.log('Generating posts...');
    const results = await postGeneratorService.generateAllPending();
    console.log(`Processed: ${results.processed}, Success: ${results.success}, Failed: ${results.failed}`);
    await disconnectDatabase();
  });

postsCmd
  .command('approve <id>')
  .description('Approve a post for publishing')
  .action(async (id) => {
    await connectDatabase();
    await linkedInPublisherService.approvePost(id);
    console.log('Post approved');
    await disconnectDatabase();
  });

postsCmd
  .command('reject <id>')
  .description('Reject a post')
  .option('-r, --reason <reason>', 'Rejection reason')
  .action(async (id, options) => {
    await connectDatabase();
    await linkedInPublisherService.rejectPost(id, options.reason);
    console.log('Post rejected');
    await disconnectDatabase();
  });

postsCmd
  .command('publish [id]')
  .description('Publish a post or all approved posts')
  .action(async (id) => {
    await connectDatabase();
    if (id) {
      const result = await linkedInPublisherService.publishPost(id);
      console.log(result.success ? `Published: ${result.linkedInUrl}` : `Failed: ${result.error}`);
    } else {
      const results = await linkedInPublisherService.publishApprovedPosts();
      const successful = results.filter(r => r.success).length;
      console.log(`Published ${successful}/${results.length} posts`);
    }
    await disconnectDatabase();
  });

// ===== PIPELINE =====

program
  .command('pipeline')
  .description('Run the full pipeline (check -> fetch -> filter -> generate)')
  .option('-p, --publish', 'Also publish approved posts')
  .action(async (options) => {
    await connectDatabase();

    console.log('Step 1: Checking sources...');
    const sourceResults = await sourceWatcherService.checkAllSources();
    const newArticles = sourceResults.reduce((sum, r) => sum + r.articlesNew, 0);
    console.log(`  Found ${newArticles} new articles`);

    console.log('\nStep 2: Fetching content...');
    const fetchResults = await articleFetcherService.fetchAllPendingContent();
    console.log(`  Fetched ${fetchResults.success} articles`);

    console.log('\nStep 3: Filtering for relevance...');
    const filterResults = await relevanceFilterService.filterAllPending();
    console.log(`  Relevant: ${filterResults.relevant}, Rejected: ${filterResults.rejected}`);

    console.log('\nStep 4: Generating posts...');
    const genResults = await postGeneratorService.generateAllPending();
    console.log(`  Generated ${genResults.success} posts`);

    if (options.publish) {
      console.log('\nStep 5: Publishing...');
      const pubResults = await linkedInPublisherService.publishApprovedPosts();
      const successful = pubResults.filter(r => r.success).length;
      console.log(`  Published ${successful} posts`);
    }

    console.log('\nPipeline complete!');
    await disconnectDatabase();
  });

// ===== LINKEDIN =====

const linkedinCmd = program.command('linkedin').description('LinkedIn integration');

linkedinCmd
  .command('status')
  .description('Check LinkedIn connection status')
  .action(async () => {
    await connectDatabase();
    const result = await linkedInPublisherService.testConnection();
    if (result.success) {
      console.log(`Connected as: ${result.memberUrn}`);
    } else {
      console.log(`Not connected: ${result.error}`);
    }

    const rateLimit = await linkedInPublisherService.canPostToday();
    console.log(`Posts today: ${rateLimit.limit - rateLimit.remaining}/${rateLimit.limit}`);
    console.log(`Can post: ${rateLimit.canPost}`);

    await disconnectDatabase();
  });

linkedinCmd
  .command('auth-url')
  .description('Get LinkedIn authorization URL')
  .action(() => {
    const url = linkedInPublisherService.getAuthorizationUrl();
    console.log('\nOpen this URL in your browser to authorize:');
    console.log(url);
  });

// ===== VISUAL =====

const visualCmd = program.command('visual').description('Visual verification (Playwright)');

visualCmd
  .command('login')
  .description('Open browser for LinkedIn login')
  .action(async () => {
    console.log('Opening browser for LinkedIn login...');
    console.log('Please log in manually. The session will be saved.');
    await visualVerificationService.openForLogin();
    await visualVerificationService.close();
  });

visualCmd
  .command('screenshot <url>')
  .description('Take a screenshot of a URL')
  .action(async (url) => {
    const path = await visualVerificationService.captureUrl(url);
    console.log(`Screenshot saved: ${path}`);
    await visualVerificationService.close();
  });

visualCmd
  .command('smoke-test')
  .description('Run visual smoke test')
  .action(async () => {
    console.log('Running smoke test...');
    const result = await visualVerificationService.runSmokeTest();
    console.log(`Success: ${result.success}`);
    console.log(`Screenshots: ${result.screenshots.join(', ')}`);
    if (result.errors.length > 0) {
      console.log(`Errors: ${result.errors.join(', ')}`);
    }
    await visualVerificationService.close();
  });

// Parse and execute
program.parse();
