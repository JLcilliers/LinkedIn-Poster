import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { extractArticleContent } from '../utils/contentExtractor';
import type { Article } from '../types';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const BATCH_SIZE = 10;

export class ArticleFetcherService {
  /**
   * Fetch content for all articles that need it
   */
  async fetchAllPendingContent(): Promise<{ processed: number; success: number; failed: number }> {
    const articles = await prisma.article.findMany({
      where: {
        status: 'NEW',
        rawContent: null,
      },
      take: BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });

    logger.info(`Found ${articles.length} articles needing content fetch`);

    const results = { processed: 0, success: 0, failed: 0 };

    for (const article of articles) {
      results.processed++;
      try {
        await this.fetchArticleContent(article);
        results.success++;
      } catch (error) {
        results.failed++;
        logger.error(`Failed to fetch content for article`, {
          articleId: article.id,
          url: article.url,
          error,
        });
      }

      // Small delay between requests to be polite
      await this.delay(1000);
    }

    return results;
  }

  /**
   * Fetch content for a single article
   */
  async fetchArticleContent(article: Article): Promise<Article> {
    logger.info(`Fetching content for article: ${article.title}`, {
      articleId: article.id,
      url: article.url,
    });

    // Mark as fetching
    await prisma.article.update({
      where: { id: article.id },
      data: { status: 'FETCHING_CONTENT' },
    });

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const extracted = await extractArticleContent(article.url);

        // Update article with extracted content
        const updated = await prisma.article.update({
          where: { id: article.id },
          data: {
            title: extracted.title || article.title,
            rawContent: extracted.content,
            status: 'CONTENT_FETCHED',
          },
        });

        // Log activity
        await this.logActivity('ARTICLE_FETCHED', 'Article', article.id,
          `Content fetched: "${updated.title}" (${extracted.content.length} chars)`);

        logger.info(`Successfully fetched content for article`, {
          articleId: article.id,
          contentLength: extracted.content.length,
        });

        return updated;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
        logger.warn(`Attempt ${attempt}/${MAX_RETRIES} failed for article`, {
          articleId: article.id,
          error: lastError.message,
        });

        if (attempt < MAX_RETRIES) {
          await this.delay(RETRY_DELAY_MS * attempt);
        }
      }
    }

    // All retries failed
    const updated = await prisma.article.update({
      where: { id: article.id },
      data: {
        status: 'FAILED',
        errorMessage: `Failed to fetch content after ${MAX_RETRIES} attempts: ${lastError?.message}`,
      },
    });

    logger.error(`Failed to fetch content for article after all retries`, {
      articleId: article.id,
      url: article.url,
    });

    return updated;
  }

  /**
   * Retry failed articles
   */
  async retryFailedArticles(): Promise<number> {
    const failedArticles = await prisma.article.findMany({
      where: {
        status: 'FAILED',
        rawContent: null,
      },
      take: 5,
    });

    let retried = 0;
    for (const article of failedArticles) {
      // Reset status to NEW for retry
      await prisma.article.update({
        where: { id: article.id },
        data: {
          status: 'NEW',
          errorMessage: null,
        },
      });
      retried++;
    }

    if (retried > 0) {
      logger.info(`Reset ${retried} failed articles for retry`);
    }

    return retried;
  }

  /**
   * Get articles by status
   */
  async getArticlesByStatus(status: string, limit: number = 50): Promise<Article[]> {
    return prisma.article.findMany({
      where: { status: status as any },
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        source: true,
      },
    });
  }

  /**
   * Get article statistics
   */
  async getStats(): Promise<Record<string, number>> {
    const counts = await prisma.article.groupBy({
      by: ['status'],
      _count: true,
    });

    const stats: Record<string, number> = {};
    for (const item of counts) {
      stats[item.status] = item._count;
    }

    return stats;
  }

  /**
   * Log activity
   */
  private async logActivity(type: string, entityType: string, entityId: string, message: string): Promise<void> {
    try {
      await prisma.activityLog.create({
        data: {
          type,
          entityType,
          entityId,
          message,
        },
      });
    } catch (error) {
      logger.error('Failed to log activity', { error, type, message });
    }
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const articleFetcherService = new ArticleFetcherService();
