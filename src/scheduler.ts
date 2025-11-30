import cron, { ScheduledTask } from 'node-cron';
import { config } from './config/env';
import { logger } from './utils/logger';
import { sourceWatcherService } from './services/SourceWatcherService';
import { articleFetcherService } from './services/ArticleFetcherService';
import { relevanceFilterService } from './services/RelevanceFilterService';
import { postGeneratorService } from './services/PostGeneratorService';
import { linkedInPublisherService } from './services/LinkedInPublisherService';

interface ScheduledJob {
  name: string;
  cronExpression: string;
  task: ScheduledTask;
}

class Scheduler {
  private jobs: ScheduledJob[] = [];
  private isRunning: boolean = false;

  /**
   * Start all scheduled jobs
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Scheduler already running');
      return;
    }

    logger.info('Starting scheduler');

    // Source watcher - check for new articles
    this.scheduleJob('SourceWatcher', config.watcherCron, async () => {
      logger.info('Running source watcher job');
      try {
        const results = await sourceWatcherService.checkAllSources();
        const totalNew = results.reduce((sum, r) => sum + r.articlesNew, 0);
        logger.info(`Source watcher completed: ${totalNew} new articles found`);
      } catch (error) {
        logger.error('Source watcher job failed', { error });
      }
    });

    // Article fetcher - fetch full content
    this.scheduleJob('ArticleFetcher', '*/10 * * * *', async () => {
      logger.info('Running article fetcher job');
      try {
        const results = await articleFetcherService.fetchAllPendingContent();
        logger.info(`Article fetcher completed: ${results.success}/${results.processed} succeeded`);
      } catch (error) {
        logger.error('Article fetcher job failed', { error });
      }
    });

    // Relevance filter - filter articles
    this.scheduleJob('RelevanceFilter', '*/10 * * * *', async () => {
      logger.info('Running relevance filter job');
      try {
        const results = await relevanceFilterService.filterAllPending();
        logger.info(`Relevance filter completed: ${results.relevant} relevant, ${results.rejected} rejected`);
      } catch (error) {
        logger.error('Relevance filter job failed', { error });
      }
    });

    // Post generator - generate LinkedIn posts
    this.scheduleJob('PostGenerator', '0 * * * *', async () => {
      logger.info('Running post generator job');
      try {
        const results = await postGeneratorService.generateAllPending();
        logger.info(`Post generator completed: ${results.success}/${results.processed} succeeded`);
      } catch (error) {
        logger.error('Post generator job failed', { error });
      }
    });

    // LinkedIn publisher - publish approved posts
    if (config.autoPostToLinkedIn) {
      this.scheduleJob('LinkedInPublisher', config.posterCron, async () => {
        logger.info('Running LinkedIn publisher job');
        try {
          const results = await linkedInPublisherService.publishApprovedPosts();
          const successful = results.filter(r => r.success).length;
          logger.info(`LinkedIn publisher completed: ${successful}/${results.length} published`);
        } catch (error) {
          logger.error('LinkedIn publisher job failed', { error });
        }
      });
    } else {
      logger.info('Auto-posting disabled - LinkedIn publisher job not scheduled');
    }

    this.isRunning = true;
    logger.info(`Scheduler started with ${this.jobs.length} jobs`);
  }

  /**
   * Stop all scheduled jobs
   */
  stop(): void {
    logger.info('Stopping scheduler');
    for (const job of this.jobs) {
      job.task.stop();
    }
    this.jobs = [];
    this.isRunning = false;
    logger.info('Scheduler stopped');
  }

  /**
   * Schedule a job
   */
  private scheduleJob(name: string, cronExpression: string, handler: () => Promise<void>): void {
    if (!cron.validate(cronExpression)) {
      logger.error(`Invalid cron expression for ${name}: ${cronExpression}`);
      return;
    }

    const task = cron.schedule(cronExpression, async () => {
      await handler();
    });

    this.jobs.push({ name, cronExpression, task });
    logger.info(`Scheduled job: ${name} (${cronExpression})`);
  }

  /**
   * Get job status
   */
  getStatus(): { name: string; cronExpression: string; running: boolean }[] {
    return this.jobs.map(job => ({
      name: job.name,
      cronExpression: job.cronExpression,
      running: true,
    }));
  }

  /**
   * Run a specific job immediately
   */
  async runJob(name: string): Promise<void> {
    logger.info(`Manually triggering job: ${name}`);

    switch (name.toLowerCase()) {
      case 'sourcewatcher':
        await sourceWatcherService.checkAllSources();
        break;
      case 'articlefetcher':
        await articleFetcherService.fetchAllPendingContent();
        break;
      case 'relevancefilter':
        await relevanceFilterService.filterAllPending();
        break;
      case 'postgenerator':
        await postGeneratorService.generateAllPending();
        break;
      case 'linkedinpublisher':
        await linkedInPublisherService.publishApprovedPosts();
        break;
      default:
        throw new Error(`Unknown job: ${name}`);
    }
  }

  /**
   * Run full pipeline once
   */
  async runFullPipeline(): Promise<void> {
    logger.info('Running full pipeline');

    await this.runJob('SourceWatcher');
    await this.runJob('ArticleFetcher');
    await this.runJob('RelevanceFilter');
    await this.runJob('PostGenerator');

    if (config.autoPostToLinkedIn) {
      await this.runJob('LinkedInPublisher');
    }

    logger.info('Full pipeline completed');
  }
}

export const scheduler = new Scheduler();
