import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import type { Article, CriteriaConfig, FilterResult, ParsedCriteria } from '../types';

const BATCH_SIZE = 20;

export class RelevanceFilterService {
  /**
   * Filter all articles that have content but haven't been filtered yet
   */
  async filterAllPending(): Promise<{ processed: number; relevant: number; rejected: number }> {
    const criteria = await this.getActiveCriteria();
    if (!criteria) {
      logger.warn('No active criteria config found - skipping filtering');
      return { processed: 0, relevant: 0, rejected: 0 };
    }

    const articles = await prisma.article.findMany({
      where: {
        status: 'CONTENT_FETCHED',
        rawContent: { not: null },
      },
      take: BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });

    logger.info(`Found ${articles.length} articles to filter`);

    const results = { processed: 0, relevant: 0, rejected: 0 };

    for (const article of articles) {
      results.processed++;
      const filterResult = await this.filterArticle(article, criteria);

      if (filterResult.isRelevant) {
        results.relevant++;
      } else {
        results.rejected++;
      }
    }

    return results;
  }

  /**
   * Filter a single article against criteria
   */
  async filterArticle(article: Article, criteria?: ParsedCriteria): Promise<FilterResult> {
    if (!criteria) {
      const criteriaConfig = await this.getActiveCriteria();
      if (!criteriaConfig) {
        throw new Error('No active criteria config found');
      }
      criteria = criteriaConfig;
    }

    const result: FilterResult = {
      articleId: article.id,
      isRelevant: false,
      matchedKeywords: [],
      excludedKeywords: [],
    };

    // Combine title and content for searching
    const searchText = `${article.title} ${article.rawContent || ''}`.toLowerCase();

    // Check include keywords (at least one must match)
    for (const keyword of criteria.includeKeywords) {
      if (searchText.includes(keyword.toLowerCase())) {
        result.matchedKeywords.push(keyword);
      }
    }

    // If no include keywords specified, consider all articles relevant by default
    const hasIncludeMatch = criteria.includeKeywords.length === 0 || result.matchedKeywords.length > 0;

    // Check exclude keywords (none should match)
    for (const keyword of criteria.excludeKeywords) {
      if (searchText.includes(keyword.toLowerCase())) {
        result.excludedKeywords.push(keyword);
      }
    }

    const hasExcludeMatch = result.excludedKeywords.length > 0;

    // Determine relevance
    result.isRelevant = hasIncludeMatch && !hasExcludeMatch;

    // Update article status
    if (result.isRelevant) {
      await prisma.article.update({
        where: { id: article.id },
        data: { status: 'READY_FOR_POST' },
      });

      await this.logActivity('ARTICLE_FILTERED', 'Article', article.id,
        `Article marked as relevant: "${article.title}" (matched: ${result.matchedKeywords.join(', ')})`);

      logger.info(`Article marked as relevant: ${article.title}`, {
        articleId: article.id,
        matchedKeywords: result.matchedKeywords,
      });
    } else {
      const reason = hasExcludeMatch
        ? `Excluded keywords found: ${result.excludedKeywords.join(', ')}`
        : 'No matching include keywords';

      await prisma.article.update({
        where: { id: article.id },
        data: { status: 'REJECTED_NOT_RELEVANT' },
      });

      await this.logActivity('ARTICLE_REJECTED', 'Article', article.id,
        `Article rejected: "${article.title}" - ${reason}`);

      logger.info(`Article rejected as not relevant: ${article.title}`, {
        articleId: article.id,
        reason,
      });
    }

    return result;
  }

  /**
   * Get the active criteria configuration
   */
  async getActiveCriteria(): Promise<ParsedCriteria | null> {
    const config = await prisma.criteriaConfig.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!config) {
      return null;
    }

    return this.parseCriteriaConfig(config);
  }

  /**
   * Parse criteria config from database format
   */
  parseCriteriaConfig(config: CriteriaConfig): ParsedCriteria {
    return {
      includeKeywords: this.parseJsonArray(config.includeKeywords),
      excludeKeywords: this.parseJsonArray(config.excludeKeywords),
      targetAudienceDescription: config.targetAudienceDescription,
      defaultHashtags: this.parseJsonArray(config.defaultHashtags),
      maxPostsPerDay: config.maxPostsPerDay,
    };
  }

  /**
   * Parse JSON array string to array
   */
  private parseJsonArray(value: string): string[] {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // If not valid JSON, try comma-separated
      return value.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  /**
   * Create or update criteria config
   */
  async setCriteria(criteria: Partial<{
    name: string;
    includeKeywords: string[];
    excludeKeywords: string[];
    targetAudienceDescription: string;
    defaultHashtags: string[];
    maxPostsPerDay: number;
  }>): Promise<CriteriaConfig> {
    // Deactivate existing configs
    await prisma.criteriaConfig.updateMany({
      where: { active: true },
      data: { active: false },
    });

    // Create new config
    const config = await prisma.criteriaConfig.create({
      data: {
        name: criteria.name || 'default',
        includeKeywords: JSON.stringify(criteria.includeKeywords || []),
        excludeKeywords: JSON.stringify(criteria.excludeKeywords || []),
        targetAudienceDescription: criteria.targetAudienceDescription || '',
        defaultHashtags: JSON.stringify(criteria.defaultHashtags || []),
        maxPostsPerDay: criteria.maxPostsPerDay || 3,
        active: true,
      },
    });

    logger.info('Updated criteria config', {
      configId: config.id,
      includeKeywords: criteria.includeKeywords,
      excludeKeywords: criteria.excludeKeywords,
    });

    return config;
  }

  /**
   * Get current criteria config
   */
  async getCurrentCriteria(): Promise<CriteriaConfig | null> {
    return prisma.criteriaConfig.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Re-filter articles that were previously rejected
   */
  async refilterRejected(): Promise<number> {
    const rejected = await prisma.article.updateMany({
      where: { status: 'REJECTED_NOT_RELEVANT' },
      data: { status: 'CONTENT_FETCHED' },
    });

    if (rejected.count > 0) {
      logger.info(`Reset ${rejected.count} rejected articles for re-filtering`);
    }

    return rejected.count;
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
}

export const relevanceFilterService = new RelevanceFilterService();
