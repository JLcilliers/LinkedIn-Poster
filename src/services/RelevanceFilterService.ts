import { getSupabaseClient, Article, CriteriaConfig, ArticleStatus, Platform, logActivity } from '../config/supabase';
import { logger } from '../utils/logger';

const BATCH_SIZE = 20;

export interface FilterResult {
  articleId: string;
  isRelevant: boolean;
  matchedKeywords: string[];
  excludedKeywords: string[];
}

export interface ParsedCriteria {
  includeKeywords: string[];
  excludeKeywords: string[];
  targetAudienceDescription: string;
  defaultHashtags: string[];
  maxPostsPerDayPerPlatform: Record<Platform, number>;
}

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

    const supabase = getSupabaseClient();

    // Find articles with content that need filtering
    const { data: articles, error } = await supabase
      .from('articles')
      .select('*')
      .eq('status', 'NEW')
      .not('raw_content', 'is', null)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error || !articles) {
      logger.error('Failed to fetch pending articles for filtering', { error });
      return { processed: 0, relevant: 0, rejected: 0 };
    }

    logger.info(`Found ${articles.length} articles to filter`);

    const results = { processed: 0, relevant: 0, rejected: 0 };

    for (const article of articles) {
      results.processed++;
      const filterResult = await this.filterArticle(article as Article, criteria);

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

    const supabase = getSupabaseClient();

    const result: FilterResult = {
      articleId: article.id,
      isRelevant: false,
      matchedKeywords: [],
      excludedKeywords: [],
    };

    // Combine title and content for searching
    const searchText = `${article.title} ${article.raw_content || ''}`.toLowerCase();

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
      await supabase
        .from('articles')
        .update({ status: 'READY_FOR_POST' as ArticleStatus })
        .eq('id', article.id);

      await logActivity(
        'ARTICLE_FILTERED',
        `Article marked as relevant: "${article.title}" (matched: ${result.matchedKeywords.join(', ')})`,
        'Article',
        article.id,
        { matchedKeywords: result.matchedKeywords }
      );

      logger.info(`Article marked as relevant: ${article.title}`, {
        articleId: article.id,
        matchedKeywords: result.matchedKeywords,
      });
    } else {
      const reason = hasExcludeMatch
        ? `Excluded keywords found: ${result.excludedKeywords.join(', ')}`
        : 'No matching include keywords';

      await supabase
        .from('articles')
        .update({ status: 'REJECTED_NOT_RELEVANT' as ArticleStatus })
        .eq('id', article.id);

      await logActivity(
        'ARTICLE_REJECTED',
        `Article rejected: "${article.title}" - ${reason}`,
        'Article',
        article.id,
        { reason, excludedKeywords: result.excludedKeywords }
      );

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
    const supabase = getSupabaseClient();

    const { data: config, error } = await supabase
      .from('criteria_configs')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !config) {
      return null;
    }

    return this.parseCriteriaConfig(config as CriteriaConfig);
  }

  /**
   * Parse criteria config from database format
   */
  parseCriteriaConfig(config: CriteriaConfig): ParsedCriteria {
    return {
      includeKeywords: config.include_keywords || [],
      excludeKeywords: config.exclude_keywords || [],
      targetAudienceDescription: config.target_audience_description || '',
      defaultHashtags: config.default_hashtags || [],
      maxPostsPerDayPerPlatform: config.max_posts_per_day_per_platform || {
        linkedin: 3,
        facebook: 3,
        instagram: 3,
        x: 5,
      },
    };
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
    maxPostsPerDayPerPlatform: Record<Platform, number>;
  }>): Promise<CriteriaConfig | null> {
    const supabase = getSupabaseClient();

    // Deactivate existing configs
    await supabase
      .from('criteria_configs')
      .update({ active: false })
      .eq('active', true);

    // Create new config
    const { data: config, error } = await supabase
      .from('criteria_configs')
      .insert({
        name: criteria.name || 'default',
        include_keywords: criteria.includeKeywords || [],
        exclude_keywords: criteria.excludeKeywords || [],
        target_audience_description: criteria.targetAudienceDescription || '',
        default_hashtags: criteria.defaultHashtags || [],
        max_posts_per_day_per_platform: criteria.maxPostsPerDayPerPlatform || {
          linkedin: 3,
          facebook: 3,
          instagram: 3,
          x: 5,
        },
        active: true,
      })
      .select()
      .single();

    if (error || !config) {
      logger.error('Failed to create criteria config', { error });
      return null;
    }

    logger.info('Updated criteria config', {
      configId: config.id,
      includeKeywords: criteria.includeKeywords,
      excludeKeywords: criteria.excludeKeywords,
    });

    return config as CriteriaConfig;
  }

  /**
   * Get current criteria config
   */
  async getCurrentCriteria(): Promise<CriteriaConfig | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('criteria_configs')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return null;
    }

    return data as CriteriaConfig;
  }

  /**
   * Re-filter articles that were previously rejected
   */
  async refilterRejected(): Promise<number> {
    const supabase = getSupabaseClient();

    // Get rejected articles
    const { data: rejected } = await supabase
      .from('articles')
      .select('id')
      .eq('status', 'REJECTED_NOT_RELEVANT');

    if (!rejected || rejected.length === 0) {
      return 0;
    }

    // Update their status back to NEW
    const { error } = await supabase
      .from('articles')
      .update({ status: 'NEW' as ArticleStatus })
      .eq('status', 'REJECTED_NOT_RELEVANT');

    if (error) {
      logger.error('Failed to reset rejected articles', { error });
      return 0;
    }

    logger.info(`Reset ${rejected.length} rejected articles for re-filtering`);
    return rejected.length;
  }

  /**
   * Update existing criteria config
   */
  async updateCriteria(
    configId: string,
    updates: Partial<{
      name: string;
      includeKeywords: string[];
      excludeKeywords: string[];
      targetAudienceDescription: string;
      defaultHashtags: string[];
      maxPostsPerDayPerPlatform: Record<Platform, number>;
      active: boolean;
    }>
  ): Promise<CriteriaConfig | null> {
    const supabase = getSupabaseClient();

    const updateData: Record<string, unknown> = {};
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.includeKeywords !== undefined) updateData.include_keywords = updates.includeKeywords;
    if (updates.excludeKeywords !== undefined) updateData.exclude_keywords = updates.excludeKeywords;
    if (updates.targetAudienceDescription !== undefined) updateData.target_audience_description = updates.targetAudienceDescription;
    if (updates.defaultHashtags !== undefined) updateData.default_hashtags = updates.defaultHashtags;
    if (updates.maxPostsPerDayPerPlatform !== undefined) updateData.max_posts_per_day_per_platform = updates.maxPostsPerDayPerPlatform;
    if (updates.active !== undefined) updateData.active = updates.active;

    const { data, error } = await supabase
      .from('criteria_configs')
      .update(updateData)
      .eq('id', configId)
      .select()
      .single();

    if (error || !data) {
      logger.error('Failed to update criteria config', { error, configId });
      return null;
    }

    return data as CriteriaConfig;
  }

  /**
   * List all criteria configs
   */
  async listCriteriaConfigs(): Promise<CriteriaConfig[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('criteria_configs')
      .select('*')
      .order('created_at', { ascending: false });

    if (error || !data) {
      logger.error('Failed to list criteria configs', { error });
      return [];
    }

    return data as CriteriaConfig[];
  }
}

export const relevanceFilterService = new RelevanceFilterService();
