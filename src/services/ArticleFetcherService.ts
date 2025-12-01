import { getSupabaseClient, Article, ArticleStatus, logActivity } from '../config/supabase';
import { logger } from '../utils/logger';
import { extractArticleContent } from '../utils/contentExtractor';
import { getMediaService } from './MediaService';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const BATCH_SIZE = 10;

export class ArticleFetcherService {
  /**
   * Fetch content for all articles that need it
   */
  async fetchAllPendingContent(): Promise<{ processed: number; success: number; failed: number }> {
    const supabase = getSupabaseClient();

    const { data: articles, error } = await supabase
      .from('articles')
      .select('*')
      .eq('status', 'NEW')
      .is('raw_content', null)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error || !articles) {
      logger.error('Failed to fetch pending articles', { error });
      return { processed: 0, success: 0, failed: 0 };
    }

    logger.info(`Found ${articles.length} articles needing content fetch`);

    const results = { processed: 0, success: 0, failed: 0 };

    for (const article of articles) {
      results.processed++;
      try {
        await this.fetchArticleContent(article as Article);
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
  async fetchArticleContent(article: Article): Promise<Article | null> {
    const supabase = getSupabaseClient();

    logger.info(`Fetching content for article: ${article.title}`, {
      articleId: article.id,
      url: article.url,
    });

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const extracted = await extractArticleContent(article.url);

        // Update article with extracted content
        const { data: updated, error: updateError } = await supabase
          .from('articles')
          .update({
            title: extracted.title || article.title,
            raw_content: extracted.content,
            status: 'NEW' as ArticleStatus, // Keep as NEW until filtered
          })
          .eq('id', article.id)
          .select()
          .single();

        if (updateError || !updated) {
          throw new Error(`Failed to update article: ${updateError?.message}`);
        }

        // Try to extract and upload article image
        try {
          const mediaService = getMediaService();
          const html = extracted.rawHtml || '';
          if (html) {
            await mediaService.extractAndUploadArticleImage(article.id, html, article.url);
          }
        } catch (imageError) {
          logger.warn('Failed to extract article image', { articleId: article.id, error: imageError });
        }

        // Log activity
        await logActivity(
          'ARTICLE_FETCHED',
          `Content fetched: "${updated.title}" (${extracted.content.length} chars)`,
          'Article',
          article.id
        );

        logger.info(`Successfully fetched content for article`, {
          articleId: article.id,
          contentLength: extracted.content.length,
        });

        return updated as Article;
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
    const { data: updated } = await supabase
      .from('articles')
      .update({
        status: 'FAILED' as ArticleStatus,
        error_message: `Failed to fetch content after ${MAX_RETRIES} attempts: ${lastError?.message}`,
      })
      .eq('id', article.id)
      .select()
      .single();

    logger.error(`Failed to fetch content for article after all retries`, {
      articleId: article.id,
      url: article.url,
    });

    return updated as Article | null;
  }

  /**
   * Retry failed articles
   */
  async retryFailedArticles(): Promise<number> {
    const supabase = getSupabaseClient();

    const { data: failedArticles } = await supabase
      .from('articles')
      .select('*')
      .eq('status', 'FAILED')
      .is('raw_content', null)
      .limit(5);

    if (!failedArticles || failedArticles.length === 0) {
      return 0;
    }

    let retried = 0;
    for (const article of failedArticles) {
      // Reset status to NEW for retry
      const { error } = await supabase
        .from('articles')
        .update({
          status: 'NEW' as ArticleStatus,
          error_message: null,
        })
        .eq('id', article.id);

      if (!error) {
        retried++;
      }
    }

    if (retried > 0) {
      logger.info(`Reset ${retried} failed articles for retry`);
    }

    return retried;
  }

  /**
   * Get articles by status
   */
  async getArticlesByStatus(status: ArticleStatus, limit: number = 50): Promise<Article[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('articles')
      .select('*, blog_sources(*)')
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) {
      logger.error('Failed to get articles by status', { error, status });
      return [];
    }

    return data as Article[];
  }

  /**
   * Get a single article by ID
   */
  async getArticle(articleId: string): Promise<Article | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('articles')
      .select('*, blog_sources(*)')
      .eq('id', articleId)
      .single();

    if (error || !data) {
      return null;
    }

    return data as Article;
  }

  /**
   * Get article statistics
   */
  async getStats(): Promise<Record<string, number>> {
    const supabase = getSupabaseClient();

    // Get counts for each status
    const statuses: ArticleStatus[] = ['NEW', 'REJECTED_NOT_RELEVANT', 'READY_FOR_POST', 'POSTED', 'FAILED'];
    const stats: Record<string, number> = {};

    for (const status of statuses) {
      const { count, error } = await supabase
        .from('articles')
        .select('*', { count: 'exact', head: true })
        .eq('status', status);

      stats[status] = error ? 0 : (count || 0);
    }

    return stats;
  }

  /**
   * Update article status
   */
  async updateArticleStatus(
    articleId: string,
    status: ArticleStatus,
    errorMessage?: string
  ): Promise<Article | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('articles')
      .update({
        status,
        error_message: errorMessage || null,
      })
      .eq('id', articleId)
      .select()
      .single();

    if (error || !data) {
      logger.error('Failed to update article status', { error, articleId, status });
      return null;
    }

    return data as Article;
  }

  /**
   * List recent articles
   */
  async listRecentArticles(limit: number = 20): Promise<Article[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('articles')
      .select('*, blog_sources(name)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) {
      logger.error('Failed to list recent articles', { error });
      return [];
    }

    return data as Article[];
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const articleFetcherService = new ArticleFetcherService();
