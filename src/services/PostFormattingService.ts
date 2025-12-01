import OpenAI from 'openai';
import { getSupabaseClient, CanonicalPost, SocialPost, Platform, logActivity } from '../config/supabase';
import { config } from '../config/env';
import { logger } from '../utils/logger';

// Platform-specific configuration
export const PLATFORM_CONFIG: Record<Platform, {
  hardLimit: number;
  targetMin: number;
  targetMax: number;
  hashtagCount: number;
  includeUrl: boolean;
  name: string;
}> = {
  linkedin: {
    hardLimit: 3000,
    targetMin: 1200,
    targetMax: 2000,
    hashtagCount: 3,
    includeUrl: true,
    name: 'LinkedIn',
  },
  facebook: {
    hardLimit: 63206,
    targetMin: 500,
    targetMax: 1500,
    hashtagCount: 3,
    includeUrl: true,
    name: 'Facebook',
  },
  instagram: {
    hardLimit: 2200,
    targetMin: 300,
    targetMax: 1500,
    hashtagCount: 8,
    includeUrl: false, // URL in bio reference only
    name: 'Instagram',
  },
  x: {
    hardLimit: 280,
    targetMin: 200,
    targetMax: 260,
    hashtagCount: 2,
    includeUrl: true,
    name: 'X (Twitter)',
  },
};

export interface FormattingOptions {
  includeUrl?: boolean;
  includeHashtags?: boolean;
  includeImage?: boolean;
  customHashtags?: string[];
}

export interface FormattedPost {
  content: string;
  hashtags: string[];
  characterCount: number;
  withinLimit: boolean;
}

export class PostFormattingService {
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
   * Format all pending social posts that have canonical content but no draft
   */
  async formatAllPending(): Promise<{ processed: number; success: number; failed: number }> {
    const supabase = getSupabaseClient();

    // Find social posts with empty content_draft
    const { data: posts, error } = await supabase
      .from('social_posts')
      .select('*')
      .eq('status', 'DRAFT')
      .or('content_draft.is.null,content_draft.eq.')
      .limit(20);

    if (error || !posts) {
      logger.error('Failed to fetch pending social posts', { error });
      return { processed: 0, success: 0, failed: 0 };
    }

    logger.info(`Found ${posts.length} social posts needing formatting`);

    const results = { processed: 0, success: 0, failed: 0 };

    for (const post of posts) {
      results.processed++;
      try {
        await this.formatPost(post as SocialPost);
        results.success++;
      } catch (error) {
        results.failed++;
        logger.error('Failed to format social post', {
          postId: post.id,
          platform: post.platform,
          error,
        });
      }
    }

    return results;
  }

  /**
   * Format a single social post
   */
  async formatPost(post: SocialPost, options?: FormattingOptions): Promise<FormattedPost> {
    const canonical = post.canonical_post_json;
    const platform = post.platform;
    const platformConfig = PLATFORM_CONFIG[platform];

    logger.info(`Formatting post for ${platform}`, { postId: post.id });

    let formatted: FormattedPost;

    // Use AI-based formatting for longer platforms, simple formatting for X
    if (platform === 'x') {
      formatted = await this.formatForX(canonical, options);
    } else {
      formatted = await this.formatWithAI(canonical, platform, options);
    }

    // Update the social post with the formatted content
    const supabase = getSupabaseClient();
    await supabase
      .from('social_posts')
      .update({
        content_draft: formatted.content,
      })
      .eq('id', post.id);

    logger.info(`Formatted post for ${platform}`, {
      postId: post.id,
      characterCount: formatted.characterCount,
      withinLimit: formatted.withinLimit,
    });

    return formatted;
  }

  /**
   * Format using AI for longer-form platforms (LinkedIn, Facebook, Instagram)
   */
  private async formatWithAI(
    canonical: CanonicalPost,
    platform: Platform,
    options?: FormattingOptions
  ): Promise<FormattedPost> {
    const platformConfig = PLATFORM_CONFIG[platform];
    const openai = this.getOpenAIClient();

    const systemPrompt = `You are a social media copywriter creating content for ${platformConfig.name}. Write in UK English with a natural, human tone.

Character limits:
- Target: ${platformConfig.targetMin}-${platformConfig.targetMax} characters
- Hard limit: ${platformConfig.hardLimit} characters

Style guidelines for ${platformConfig.name}:
${this.getPlatformStyleGuidelines(platform)}

You must output a JSON object with:
{
  "content": "The formatted post content",
  "hashtags": ["array", "of", "hashtags", "without", "hash", "symbols"]
}`;

    const userPrompt = `Create a ${platformConfig.name} post based on this article analysis:

Article title: ${canonical.articleTitle}
${platformConfig.includeUrl ? `Article URL: ${canonical.articleUrl}` : '(Do not include a URL - Instagram captions do not support clickable links)'}

Main idea: ${canonical.mainIdea}

Key insights:
${canonical.keyInsights.map((insight, i) => `${i + 1}. ${insight}`).join('\n')}

Suggested call to action: ${canonical.suggestedCallToAction || 'None provided'}

Tone guidelines: ${canonical.toneGuidelines}

Available tags: ${canonical.tags.join(', ')}

Requirements:
- Write the main content first, then add ${platformConfig.hashtagCount} hashtags at the very end
- The first 1-2 lines should hook the reader (they appear before "see more")
- Use short paragraphs with line breaks for readability
- Sound like a real person, not a marketing robot
- Include the article URL ${platformConfig.includeUrl ? 'naturally in the content' : '(mention "link in bio" if relevant)'}`;

    try {
      const response = await openai.chat.completions.create({
        model: config.openai.model || 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.8,
        max_tokens: 2000,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      const parsed = JSON.parse(content);
      let formattedContent = parsed.content || '';
      const hashtags = (parsed.hashtags || []).slice(0, platformConfig.hashtagCount);

      // Add hashtags if not already in content
      if (hashtags.length > 0 && !formattedContent.includes('#')) {
        const hashtagStr = hashtags.map((h: string) => `#${h.replace(/^#/, '')}`).join(' ');
        formattedContent = `${formattedContent}\n\n${hashtagStr}`;
      }

      // Ensure within limit
      if (formattedContent.length > platformConfig.hardLimit) {
        formattedContent = this.truncateToLimit(formattedContent, platformConfig.hardLimit);
      }

      return {
        content: formattedContent,
        hashtags,
        characterCount: formattedContent.length,
        withinLimit: formattedContent.length <= platformConfig.hardLimit,
      };
    } catch (error) {
      logger.error('AI formatting failed, using fallback', { platform, error });
      return this.fallbackFormat(canonical, platform, options);
    }
  }

  /**
   * Format for X (Twitter) - needs to be very concise
   */
  private async formatForX(
    canonical: CanonicalPost,
    options?: FormattingOptions
  ): Promise<FormattedPost> {
    const platformConfig = PLATFORM_CONFIG.x;
    const openai = this.getOpenAIClient();

    const systemPrompt = `You are a social media expert crafting a tweet. Write in UK English.

Hard limit: 280 characters total (including URL and hashtags)
Target: 240-260 characters to leave room for potential edits

Output JSON:
{
  "content": "The tweet text including URL and hashtags - must be under 280 chars",
  "hashtags": ["max", "two"]
}`;

    const userPrompt = `Create a compelling tweet about this article:

Title: ${canonical.articleTitle}
Main idea: ${canonical.mainIdea}
URL: ${canonical.articleUrl}

Pick ONE key insight to highlight. The URL will be shortened to ~23 chars by X.
Add 1-2 relevant hashtags at the end.`;

    try {
      const response = await openai.chat.completions.create({
        model: config.openai.model || 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.8,
        max_tokens: 200,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      const parsed = JSON.parse(content);
      let tweetContent = parsed.content || '';
      const hashtags = (parsed.hashtags || []).slice(0, 2);

      // Ensure within 280 chars
      if (tweetContent.length > 280) {
        tweetContent = this.truncateToLimit(tweetContent, 280);
      }

      return {
        content: tweetContent,
        hashtags,
        characterCount: tweetContent.length,
        withinLimit: tweetContent.length <= 280,
      };
    } catch (error) {
      logger.error('AI formatting for X failed, using fallback', { error });
      return this.fallbackFormatX(canonical);
    }
  }

  /**
   * Fallback formatting without AI
   */
  private fallbackFormat(
    canonical: CanonicalPost,
    platform: Platform,
    options?: FormattingOptions
  ): FormattedPost {
    const platformConfig = PLATFORM_CONFIG[platform];

    // Build a simple post from the canonical data
    let content = `${canonical.mainIdea}\n\n`;

    // Add key insights (limit based on platform)
    const insightLimit = platform === 'instagram' ? 3 : 5;
    const insights = canonical.keyInsights.slice(0, insightLimit);
    insights.forEach((insight, i) => {
      content += `${i + 1}. ${insight}\n`;
    });

    // Add call to action
    if (canonical.suggestedCallToAction) {
      content += `\n${canonical.suggestedCallToAction}`;
    }

    // Add URL
    if (platformConfig.includeUrl) {
      content += `\n\n${canonical.articleUrl}`;
    } else if (platform === 'instagram') {
      content += '\n\nLink in bio.';
    }

    // Add hashtags
    const hashtags = canonical.tags.slice(0, platformConfig.hashtagCount);
    const hashtagStr = hashtags.map(h => `#${h.replace(/\s+/g, '')}`).join(' ');
    content += `\n\n${hashtagStr}`;

    // Truncate if needed
    if (content.length > platformConfig.hardLimit) {
      content = this.truncateToLimit(content, platformConfig.hardLimit);
    }

    return {
      content,
      hashtags,
      characterCount: content.length,
      withinLimit: content.length <= platformConfig.hardLimit,
    };
  }

  /**
   * Fallback formatting for X
   */
  private fallbackFormatX(canonical: CanonicalPost): FormattedPost {
    // Take first insight and URL
    const insight = canonical.keyInsights[0] || canonical.mainIdea;
    const hashtag = canonical.tags[0] ? `#${canonical.tags[0].replace(/\s+/g, '')}` : '';

    // Build tweet within 280 chars
    const url = canonical.articleUrl;
    const maxInsightLength = 280 - url.length - hashtag.length - 4; // Space and newlines

    let insightTruncated = insight;
    if (insight.length > maxInsightLength) {
      insightTruncated = insight.substring(0, maxInsightLength - 3) + '...';
    }

    const content = `${insightTruncated}\n\n${url}${hashtag ? ` ${hashtag}` : ''}`;

    return {
      content,
      hashtags: hashtag ? [hashtag.replace('#', '')] : [],
      characterCount: content.length,
      withinLimit: content.length <= 280,
    };
  }

  /**
   * Get platform-specific style guidelines
   */
  private getPlatformStyleGuidelines(platform: Platform): string {
    switch (platform) {
      case 'linkedin':
        return `- Professional but personable tone
- Short paragraphs (2-3 sentences max)
- Hook readers in the first line (visible before "see more")
- Use bullet points or numbered lists for insights
- 3 niche, professional hashtags at the very end
- Include the article URL naturally`;

      case 'facebook':
        return `- Conversational and engaging tone
- Can be similar length to LinkedIn
- Encourage comments and shares
- Hashtags are optional (0-3 max)
- Include the article URL`;

      case 'instagram':
        return `- More visual and emotional language
- Strong hook in the first sentence (only ~125 chars visible initially)
- Can use emojis sparingly if appropriate
- 5-10 relevant hashtags at the end
- Mention "link in bio" instead of including URL`;

      default:
        return '';
    }
  }

  /**
   * Truncate content to fit within limit
   */
  private truncateToLimit(content: string, limit: number): string {
    if (content.length <= limit) {
      return content;
    }

    // Try to break at sentence end
    const truncated = content.substring(0, limit - 3);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');

    const breakPoint = Math.max(lastPeriod, lastNewline);
    if (breakPoint > limit * 0.7) {
      return content.substring(0, breakPoint + 1);
    }

    // Break at word boundary
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 0) {
      return content.substring(0, lastSpace) + '...';
    }

    return truncated + '...';
  }

  /**
   * Reformat a specific post
   */
  async reformatPost(postId: string, options?: FormattingOptions): Promise<FormattedPost | null> {
    const supabase = getSupabaseClient();

    const { data: post, error } = await supabase
      .from('social_posts')
      .select('*')
      .eq('id', postId)
      .single();

    if (error || !post) {
      logger.error('Post not found for reformatting', { postId });
      return null;
    }

    return this.formatPost(post as SocialPost, options);
  }

  /**
   * Preview formatting without saving
   */
  async previewFormat(
    canonical: CanonicalPost,
    platform: Platform,
    options?: FormattingOptions
  ): Promise<FormattedPost> {
    if (platform === 'x') {
      return this.formatForX(canonical, options);
    }
    return this.formatWithAI(canonical, platform, options);
  }
}

export const postFormattingService = new PostFormattingService();
