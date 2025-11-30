import OpenAI from 'openai';
import { prisma } from '../config/database';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { truncateContent } from '../utils/contentExtractor';
import { relevanceFilterService } from './RelevanceFilterService';
import type { Article, GenerationResult, ParsedCriteria } from '../types';

const LINKEDIN_MAX_CHARS = 3000;
const LINKEDIN_TARGET_MIN = 1200;
const LINKEDIN_TARGET_MAX = 2000;
const BATCH_SIZE = 5;

export class PostGeneratorService {
  private openai: OpenAI | null = null;

  private getOpenAI(): OpenAI {
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
   * Generate posts for all articles ready for posting
   */
  async generateAllPending(): Promise<{ processed: number; success: number; failed: number }> {
    const articles = await prisma.article.findMany({
      where: {
        status: 'READY_FOR_POST',
        linkedInPosts: { none: {} },
      },
      include: { source: true },
      take: BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });

    logger.info(`Found ${articles.length} articles ready for post generation`);

    const results = { processed: 0, success: 0, failed: 0 };

    for (const article of articles) {
      results.processed++;
      const result = await this.generatePost(article);

      if (result.success) {
        results.success++;
      } else {
        results.failed++;
      }
    }

    return results;
  }

  /**
   * Generate a LinkedIn post for a single article
   */
  async generatePost(article: Article & { source?: { name: string } }): Promise<GenerationResult> {
    logger.info(`Generating LinkedIn post for article: ${article.title}`, {
      articleId: article.id,
    });

    const result: GenerationResult = {
      articleId: article.id,
      postId: '',
      contentLength: 0,
      success: false,
    };

    try {
      // Get criteria for prompt context
      const criteria = await relevanceFilterService.getActiveCriteria();

      // Build and send prompt
      const prompt = this.buildPrompt(article, criteria);
      const generatedContent = await this.callOpenAI(prompt);

      // Validate and clean content
      const finalContent = this.validateAndCleanContent(generatedContent);

      // Determine post mode based on config
      const mode = config.manualReviewMode ? 'MANUAL_REVIEWED' : 'AUTO';
      const status = config.manualReviewMode ? 'PENDING_REVIEW' : 'DRAFT';

      // Create LinkedIn post record
      const post = await prisma.linkedInPost.create({
        data: {
          articleId: article.id,
          contentDraft: finalContent,
          mode,
          status,
        },
      });

      // Update article status
      await prisma.article.update({
        where: { id: article.id },
        data: { status: 'POST_GENERATED' },
      });

      // Log activity
      await this.logActivity('POST_GENERATED', 'LinkedInPost', post.id,
        `Generated post for "${article.title}" (${finalContent.length} chars, ${status})`);

      result.postId = post.id;
      result.contentLength = finalContent.length;
      result.success = true;

      logger.info(`Successfully generated LinkedIn post`, {
        articleId: article.id,
        postId: post.id,
        contentLength: finalContent.length,
        status,
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Failed to generate LinkedIn post`, {
        articleId: article.id,
        error: result.error,
      });

      // Update article status to failed
      await prisma.article.update({
        where: { id: article.id },
        data: {
          status: 'FAILED',
          errorMessage: `Post generation failed: ${result.error}`,
        },
      });
    }

    return result;
  }

  /**
   * Build the AI prompt for post generation
   */
  private buildPrompt(
    article: Article & { source?: { name: string } },
    criteria: ParsedCriteria | null
  ): { system: string; user: string } {
    const targetAudience = criteria?.targetAudienceDescription || 'business professionals and industry practitioners';
    const hashtags = criteria?.defaultHashtags?.join(', ') || '';

    const system = `You are a professional content writer creating LinkedIn posts in UK English. Your posts should sound like a thoughtful human professional sharing insights, not an AI or marketing bot.

STRICT RULES:
- Write in UK English (colour not color, organisation not organization, etc.)
- Use a professional but conversational tone
- Never mention that you are summarising an article, rewriting content, or using AI
- Never mention being given a source article or any input
- Never copy sentences verbatim from the source - always rewrite
- Write as if sharing your own reflection, perspective, or experience
- No corporate jargon or buzzword soup
- No excessive enthusiasm or cheesy phrases
- Maximum 3 emojis per post, placed naturally - not on every line

FORMATTING:
- Short paragraphs (1-3 lines each)
- Clear, simple language (approximately grade 7 reading level)
- First 2-3 lines must be a strong hook that makes ${targetAudience} want to click "see more"
- Line breaks between paragraphs for readability
- At most 3 relevant, niche hashtags at the very end (or none if not appropriate)
${hashtags ? `- Consider these hashtags if relevant: ${hashtags}` : ''}

LENGTH:
- Hard limit: ${LINKEDIN_MAX_CHARS} characters
- Ideal target: ${LINKEDIN_TARGET_MIN}-${LINKEDIN_TARGET_MAX} characters
- Never exceed the hard limit

STRUCTURE:
1. Hook (2-3 compelling lines that create curiosity)
2. Brief context or personal framing
3. 3-5 concrete, specific insights or takeaways
4. Optional: A thought-provoking question to invite comments
5. Optional: 1-3 hashtags at the end only`;

    const sourceName = article.source?.name || 'a recent article';
    const articleContent = truncateContent(article.rawContent || article.rawSummary || '', 8000);

    const user = `Create a LinkedIn post based on this content. Remember to write as if sharing your own perspective, not summarising someone else's work.

CONTEXT (for your reference only - do not mention the source in your post):
- Title: ${article.title}
- Source: ${sourceName}
- URL: ${article.url}
- Target audience: ${targetAudience}

ARTICLE CONTENT:
${articleContent}

INSTRUCTIONS:
1. Extract the single most important core idea
2. Identify 3-5 concrete, specific insights that would matter to ${targetAudience}
3. Write a LinkedIn post in first person that feels like you're sharing your own reflection or experience related to this topic
4. Start with a hook that will make someone stop scrolling
5. End with either a question to spark discussion or a strong closing thought
6. Add relevant hashtags only if they add value

Write the post now:`;

    return { system, user };
  }

  /**
   * Call OpenAI API to generate content
   */
  private async callOpenAI(prompt: { system: string; user: string }): Promise<string> {
    const openai = this.getOpenAI();

    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      temperature: 0.7,
      max_tokens: 1500,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI returned empty response');
    }

    return content;
  }

  /**
   * Validate and clean generated content
   */
  private validateAndCleanContent(content: string): string {
    // Trim whitespace
    let cleaned = content.trim();

    // Remove any "Here's a LinkedIn post:" type prefixes
    const prefixPatterns = [
      /^(Here's|Here is|Here are).*?:\s*/i,
      /^LinkedIn Post:?\s*/i,
      /^Post:?\s*/i,
    ];

    for (const pattern of prefixPatterns) {
      cleaned = cleaned.replace(pattern, '');
    }

    // Ensure hashtags are at the end
    cleaned = this.moveHashtagsToEnd(cleaned);

    // Check character limit
    if (cleaned.length > LINKEDIN_MAX_CHARS) {
      logger.warn(`Generated content exceeds limit (${cleaned.length} chars), truncating`);
      cleaned = this.truncateToLimit(cleaned);
    }

    return cleaned;
  }

  /**
   * Move hashtags to the end of the post
   */
  private moveHashtagsToEnd(content: string): string {
    const hashtagPattern = /#[a-zA-Z0-9_]+/g;
    const hashtags: string[] = [];

    // Find all hashtags
    let match;
    while ((match = hashtagPattern.exec(content)) !== null) {
      hashtags.push(match[0]);
    }

    if (hashtags.length === 0) {
      return content;
    }

    // Check if hashtags are already at the end
    const lastParagraph = content.split('\n').pop() || '';
    const hashtagsInLast = (lastParagraph.match(hashtagPattern) || []).length;

    if (hashtagsInLast === hashtags.length) {
      // Already at end, limit to 3
      const uniqueHashtags = [...new Set(hashtags)].slice(0, 3);
      return content.replace(/\n?#[a-zA-Z0-9_]+\s*/g, '').trim() +
        '\n\n' + uniqueHashtags.join(' ');
    }

    // Remove hashtags from content and add at end
    const contentWithoutHashtags = content.replace(/#[a-zA-Z0-9_]+\s*/g, '').trim();
    const uniqueHashtags = [...new Set(hashtags)].slice(0, 3);

    return contentWithoutHashtags + '\n\n' + uniqueHashtags.join(' ');
  }

  /**
   * Truncate content to fit within LinkedIn limit
   */
  private truncateToLimit(content: string): string {
    if (content.length <= LINKEDIN_MAX_CHARS) {
      return content;
    }

    // Try to find a good breaking point
    const target = LINKEDIN_MAX_CHARS - 50; // Leave room for "..."
    let truncated = content.substring(0, target);

    // Find last paragraph break
    const lastNewline = truncated.lastIndexOf('\n\n');
    if (lastNewline > target * 0.7) {
      truncated = truncated.substring(0, lastNewline);
    } else {
      // Find last sentence
      const lastPeriod = truncated.lastIndexOf('.');
      if (lastPeriod > target * 0.7) {
        truncated = truncated.substring(0, lastPeriod + 1);
      }
    }

    return truncated.trim() + '\n\n...';
  }

  /**
   * Regenerate a post with optional modifications
   */
  async regeneratePost(postId: string, instructions?: string): Promise<GenerationResult> {
    const post = await prisma.linkedInPost.findUnique({
      where: { id: postId },
      include: {
        article: {
          include: { source: true },
        },
      },
    });

    if (!post) {
      throw new Error('Post not found');
    }

    // Delete existing post
    await prisma.linkedInPost.delete({
      where: { id: postId },
    });

    // Reset article status
    await prisma.article.update({
      where: { id: post.articleId },
      data: { status: 'READY_FOR_POST' },
    });

    // Generate new post
    return this.generatePost(post.article as Article & { source: { name: string } });
  }

  /**
   * Get pending posts for review
   */
  async getPendingPosts(): Promise<any[]> {
    return prisma.linkedInPost.findMany({
      where: { status: 'PENDING_REVIEW' },
      include: {
        article: {
          include: { source: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get post by ID
   */
  async getPost(postId: string): Promise<any> {
    return prisma.linkedInPost.findUnique({
      where: { id: postId },
      include: {
        article: {
          include: { source: true },
        },
      },
    });
  }

  /**
   * Update post content
   */
  async updatePostContent(postId: string, content: string): Promise<any> {
    const cleaned = this.validateAndCleanContent(content);

    return prisma.linkedInPost.update({
      where: { id: postId },
      data: {
        contentDraft: cleaned,
        updatedAt: new Date(),
      },
    });
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

export const postGeneratorService = new PostGeneratorService();
