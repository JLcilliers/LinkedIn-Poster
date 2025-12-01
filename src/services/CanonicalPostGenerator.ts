import OpenAI from 'openai';
import { getSupabaseClient, Article, CanonicalPost, SocialPost, Platform, logActivity } from '../config/supabase';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { relevanceFilterService } from './RelevanceFilterService';

const BATCH_SIZE = 5;

export class CanonicalPostGenerator {
  private openai: OpenAI | null = null;

  private getOpenAIClient(): OpenAI {
    if (!this.openai) {
      if (!config.openai.apiKey) {
        throw new Error('OpenAI API key not configured');
      }
      this.openai = new OpenAI({
        apiKey: config.openai.apiKey,
      });
    }
    return this.openai;
  }

  /**
   * Generate canonical posts for all ready articles
   */
  async generateAllPending(): Promise<{ processed: number; success: number; failed: number }> {
    const supabase = getSupabaseClient();

    // Find articles ready for post generation
    const { data: articles, error } = await supabase
      .from('articles')
      .select('*')
      .eq('status', 'READY_FOR_POST')
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error || !articles) {
      logger.error('Failed to fetch articles for generation', { error });
      return { processed: 0, success: 0, failed: 0 };
    }

    logger.info(`Found ${articles.length} articles ready for canonical post generation`);

    const results = { processed: 0, success: 0, failed: 0 };

    for (const article of articles) {
      results.processed++;
      try {
        await this.generateCanonicalPost(article as Article);
        results.success++;
      } catch (error) {
        results.failed++;
        logger.error('Failed to generate canonical post', {
          articleId: article.id,
          error,
        });
      }
    }

    return results;
  }

  /**
   * Generate canonical post for a single article
   */
  async generateCanonicalPost(article: Article): Promise<CanonicalPost> {
    logger.info(`Generating canonical post for article: ${article.title}`, {
      articleId: article.id,
    });

    // Get criteria config for target audience
    const criteria = await relevanceFilterService.getActiveCriteria();
    const targetAudience = criteria?.targetAudienceDescription ||
      'Professionals interested in technology and business';

    // Build the AI prompt
    const systemPrompt = `You are an expert social media content strategist. Your task is to analyse an article and extract the key insights that would be valuable to share on social media platforms.

Work in UK English throughout.

Your analysis should be:
- Clear and specific (avoid vague generalisations)
- Practical and actionable where possible
- Written in a natural, human tone
- Focused on what genuinely matters to the target audience
- Free from buzzwords, jargon, and hyperbole

Output your analysis as a JSON object with the following structure:
{
  "mainIdea": "The single most important takeaway from the article (1-2 sentences)",
  "keyInsights": ["Array of 3-7 specific, valuable insights from the article"],
  "toneGuidelines": "Brief description of the appropriate tone for posts about this content",
  "suggestedCallToAction": "A question or call to action that would engage the audience (or null if not appropriate)",
  "tags": ["Up to 10 relevant topic tags without # symbols"]
}`;

    const userPrompt = `Target audience: ${targetAudience}

Article title: ${article.title}
Article URL: ${article.url}

Article content:
${this.truncateContent(article.raw_content || '', 8000)}

Please analyse this article and provide the canonical post structure.`;

    try {
      const openai = this.getOpenAIClient();

      const response = await openai.chat.completions.create({
        model: config.openai.model || 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 1500,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      const parsed = JSON.parse(content);

      const canonicalPost: CanonicalPost = {
        articleId: article.id,
        mainIdea: parsed.mainIdea || '',
        keyInsights: Array.isArray(parsed.keyInsights) ? parsed.keyInsights : [],
        targetAudience,
        toneGuidelines: parsed.toneGuidelines || '',
        suggestedCallToAction: parsed.suggestedCallToAction || null,
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        articleUrl: article.url,
        articleTitle: article.title,
      };

      logger.info('Generated canonical post', {
        articleId: article.id,
        insightCount: canonicalPost.keyInsights.length,
        tagCount: canonicalPost.tags.length,
      });

      // Create social_posts entries for enabled platforms
      await this.createPlatformPosts(article.id, canonicalPost);

      return canonicalPost;
    } catch (error) {
      logger.error('Failed to generate canonical post', { articleId: article.id, error });

      // Update article with error
      const supabase = getSupabaseClient();
      await supabase
        .from('articles')
        .update({
          status: 'FAILED',
          error_message: `Failed to generate canonical post: ${error instanceof Error ? error.message : 'Unknown error'}`,
        })
        .eq('id', article.id);

      throw error;
    }
  }

  /**
   * Create social_posts entries for each platform
   */
  private async createPlatformPosts(articleId: string, canonicalPost: CanonicalPost): Promise<void> {
    const supabase = getSupabaseClient();
    const platforms: Platform[] = config.autoPostPlatforms as Platform[];

    for (const platform of platforms) {
      // Check if post already exists for this article + platform
      const { data: existing } = await supabase
        .from('social_posts')
        .select('id')
        .eq('article_id', articleId)
        .eq('platform', platform)
        .single();

      if (existing) {
        logger.debug(`Social post already exists for ${platform}`, { articleId });
        continue;
      }

      // Create the social post record (content_draft will be filled by PostFormattingService)
      const { error: insertError } = await supabase
        .from('social_posts')
        .insert({
          article_id: articleId,
          platform,
          canonical_post_json: canonicalPost,
          content_draft: '', // Will be populated by PostFormattingService
          status: 'DRAFT',
          media_asset_ids: [],
        });

      if (insertError) {
        logger.error('Failed to create social post', { articleId, platform, error: insertError });
      } else {
        logger.debug(`Created social post for ${platform}`, { articleId });
      }
    }

    // Update article status
    await supabase
      .from('articles')
      .update({ status: 'POSTED' })
      .eq('id', articleId);

    await logActivity(
      'CANONICAL_POST_GENERATED',
      `Generated canonical post for: "${canonicalPost.articleTitle}"`,
      'Article',
      articleId,
      { platforms, insightCount: canonicalPost.keyInsights.length }
    );
  }

  /**
   * Regenerate canonical post for an article
   */
  async regenerateCanonicalPost(articleId: string): Promise<CanonicalPost | null> {
    const supabase = getSupabaseClient();

    // Get the article
    const { data: article, error } = await supabase
      .from('articles')
      .select('*')
      .eq('id', articleId)
      .single();

    if (error || !article) {
      logger.error('Article not found for regeneration', { articleId });
      return null;
    }

    // Delete existing social posts for this article
    await supabase
      .from('social_posts')
      .delete()
      .eq('article_id', articleId);

    // Regenerate
    return this.generateCanonicalPost(article as Article);
  }

  /**
   * Get canonical post for an article
   */
  async getCanonicalPost(articleId: string): Promise<CanonicalPost | null> {
    const supabase = getSupabaseClient();

    // Get any social post for this article to retrieve the canonical post
    const { data: socialPost } = await supabase
      .from('social_posts')
      .select('canonical_post_json')
      .eq('article_id', articleId)
      .limit(1)
      .single();

    if (!socialPost) {
      return null;
    }

    return socialPost.canonical_post_json as CanonicalPost;
  }

  /**
   * Truncate content for the AI prompt
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }

    // Find a good breaking point
    const truncated = content.substring(0, maxLength);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastParagraph = truncated.lastIndexOf('\n\n');

    const breakPoint = Math.max(lastPeriod, lastParagraph);
    if (breakPoint > maxLength * 0.7) {
      return truncated.substring(0, breakPoint + 1) + '\n[Content truncated...]';
    }

    return truncated + '...\n[Content truncated...]';
  }
}

export const canonicalPostGenerator = new CanonicalPostGenerator();
