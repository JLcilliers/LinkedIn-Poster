import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';

interface ArticleDetectionResult {
  isArticle: boolean;
  confidence: number; // 0-1
  title?: string;
  content?: string;
  publishedAt?: Date;
  author?: string;
  summary?: string;
  wordCount: number;
  reasons: string[];
}

interface ArticlePatterns {
  urlPatterns: RegExp[];
  datePatterns: RegExp[];
  contentSelectors: string[];
  excludeSelectors: string[];
}

const DEFAULT_PATTERNS: ArticlePatterns = {
  urlPatterns: [
    /\/blog\//i,
    /\/posts?\//i,
    /\/news\//i,
    /\/articles?\//i,
    /\/insights?\//i,
    /\/stories?\//i,
    /\/updates?\//i,
    /\/announcements?\//i,
    /\/press-releases?\//i,
    /\/\d{4}\/\d{2}\//, // Date pattern like /2025/01/
    /\/\d{4}\/\d{2}\/\d{2}\//, // Date pattern like /2025/01/15/
    /\/\d{4}-\d{2}-\d{2}/, // Date pattern like /2025-01-15
  ],
  datePatterns: [
    /\b\d{4}[-\/]\d{2}[-\/]\d{2}\b/, // 2025-01-15 or 2025/01/15
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}\b/i, // Jan 15, 2025
    /\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}\b/i, // 15 Jan 2025
  ],
  contentSelectors: [
    'article',
    '[role="article"]',
    '.post-content',
    '.article-content',
    '.entry-content',
    '.blog-content',
    '.content-body',
    '.post-body',
    'main .content',
    '#content article',
    '.single-post',
  ],
  excludeSelectors: [
    'nav',
    'header',
    'footer',
    'aside',
    '.sidebar',
    '.comments',
    '.related-posts',
    '.social-share',
    '.author-bio',
    '.advertisement',
    '.ad',
    'script',
    'style',
    'noscript',
  ],
};

export class ArticleDetectionService {
  private patterns: ArticlePatterns;
  private minWordCount: number = 200;
  private minConfidence: number = 0.4;

  constructor(customPatterns?: Partial<ArticlePatterns>) {
    this.patterns = {
      ...DEFAULT_PATTERNS,
      ...customPatterns,
    };
  }

  /**
   * Analyze a page and determine if it's an article
   */
  analyzePageContent(url: string, html: string): ArticleDetectionResult {
    const $ = cheerio.load(html);
    const reasons: string[] = [];
    let confidenceScore = 0;

    // 1. Check URL patterns
    const urlScore = this.analyzeUrl(url);
    confidenceScore += urlScore.score;
    reasons.push(...urlScore.reasons);

    // 2. Check for article HTML element
    const hasArticleElement = $('article').length > 0 || $('[role="article"]').length > 0;
    if (hasArticleElement) {
      confidenceScore += 0.2;
      reasons.push('Has <article> element');
    }

    // 3. Extract main content
    const contentResult = this.extractMainContent($);
    const wordCount = contentResult.wordCount;

    if (wordCount >= this.minWordCount) {
      confidenceScore += 0.2;
      reasons.push(`Sufficient word count (${wordCount} words)`);
    } else if (wordCount >= 100) {
      confidenceScore += 0.1;
      reasons.push(`Moderate word count (${wordCount} words)`);
    }

    // 4. Check for title patterns
    const titleResult = this.extractTitle($);
    if (titleResult.title && titleResult.title.length > 10) {
      confidenceScore += 0.1;
      reasons.push('Has meaningful title');
    }

    // 5. Check for publish date
    const dateResult = this.extractPublishDate($);
    if (dateResult.date) {
      confidenceScore += 0.15;
      reasons.push('Has publish date');
    }

    // 6. Check for author info
    const author = this.extractAuthor($);
    if (author) {
      confidenceScore += 0.1;
      reasons.push('Has author attribution');
    }

    // 7. Check for typical article metadata
    if ($('meta[property="article:published_time"]').length > 0) {
      confidenceScore += 0.1;
      reasons.push('Has Open Graph article metadata');
    }

    if ($('meta[name="author"]').length > 0) {
      confidenceScore += 0.05;
      reasons.push('Has author meta tag');
    }

    // 8. Check for schema.org Article markup
    const hasArticleSchema = html.includes('"@type":"Article"') ||
      html.includes('"@type":"BlogPosting"') ||
      html.includes('"@type":"NewsArticle"');
    if (hasArticleSchema) {
      confidenceScore += 0.15;
      reasons.push('Has Article schema markup');
    }

    // Cap confidence at 1.0
    confidenceScore = Math.min(confidenceScore, 1.0);

    const isArticle = confidenceScore >= this.minConfidence && wordCount >= 100;

    logger.debug('Article detection result', {
      url,
      isArticle,
      confidence: confidenceScore,
      wordCount,
      reasonCount: reasons.length,
    });

    return {
      isArticle,
      confidence: confidenceScore,
      title: titleResult.title,
      content: contentResult.content,
      publishedAt: dateResult.date,
      author,
      summary: this.extractSummary($),
      wordCount,
      reasons,
    };
  }

  /**
   * Analyze URL for article patterns
   */
  private analyzeUrl(url: string): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    try {
      const urlPath = new URL(url).pathname;

      // Check against URL patterns
      for (const pattern of this.patterns.urlPatterns) {
        if (pattern.test(urlPath)) {
          score += 0.15;
          reasons.push(`URL matches article pattern: ${pattern.source}`);
          break; // Only count once
        }
      }

      // Check for slug-like patterns (words separated by dashes)
      const pathParts = urlPath.split('/').filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1] || '';

      if (lastPart.includes('-') && lastPart.length > 10) {
        score += 0.1;
        reasons.push('URL has slug-like structure');
      }

      // Negative signals
      const negativePatterns = [
        /^\/?(category|tag|author|page|search|login|register|cart|checkout|account)/i,
        /\.(jpg|png|gif|pdf|zip|css|js)$/i,
        /^\/?(about|contact|privacy|terms|faq|help|support)$/i,
      ];

      for (const pattern of negativePatterns) {
        if (pattern.test(urlPath)) {
          score -= 0.2;
          reasons.push(`URL matches non-article pattern: ${pattern.source}`);
          break;
        }
      }
    } catch {
      // Invalid URL
    }

    return { score: Math.max(0, score), reasons };
  }

  /**
   * Extract main content from the page
   */
  private extractMainContent($: cheerio.CheerioAPI): { content: string; wordCount: number } {
    // Remove elements we don't want
    for (const selector of this.patterns.excludeSelectors) {
      $(selector).remove();
    }

    // Try to find main content using selectors
    let contentElement: cheerio.Cheerio<cheerio.Element> | null = null;

    for (const selector of this.patterns.contentSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        contentElement = element.first();
        break;
      }
    }

    // Fallback to body if no content element found
    if (!contentElement) {
      contentElement = $('body');
    }

    // Extract text
    const content = contentElement.text()
      .replace(/\s+/g, ' ')
      .trim();

    const wordCount = content.split(/\s+/).filter(word => word.length > 0).length;

    return { content, wordCount };
  }

  /**
   * Extract page title
   */
  private extractTitle($: cheerio.CheerioAPI): { title?: string } {
    // Try multiple sources for title
    const sources = [
      $('meta[property="og:title"]').attr('content'),
      $('meta[name="twitter:title"]').attr('content'),
      $('h1').first().text(),
      $('title').text(),
    ];

    for (const source of sources) {
      if (source && source.trim().length > 0) {
        // Clean up title
        let title = source.trim();
        // Remove site name suffix (common pattern: "Article Title | Site Name")
        title = title.split(/\s*[\|–—]\s*/)[0].trim();
        return { title };
      }
    }

    return {};
  }

  /**
   * Extract publish date
   */
  private extractPublishDate($: cheerio.CheerioAPI): { date?: Date } {
    // Try meta tags first
    const metaSources = [
      $('meta[property="article:published_time"]').attr('content'),
      $('meta[name="date"]').attr('content'),
      $('meta[name="publish-date"]').attr('content'),
      $('time[datetime]').attr('datetime'),
      $('time[pubdate]').attr('datetime'),
    ];

    for (const source of metaSources) {
      if (source) {
        const date = new Date(source);
        if (!isNaN(date.getTime())) {
          return { date };
        }
      }
    }

    // Try to find date in text
    const bodyText = $('body').text();
    for (const pattern of this.patterns.datePatterns) {
      const match = bodyText.match(pattern);
      if (match) {
        const date = new Date(match[0]);
        if (!isNaN(date.getTime())) {
          return { date };
        }
      }
    }

    return {};
  }

  /**
   * Extract author name
   */
  private extractAuthor($: cheerio.CheerioAPI): string | undefined {
    const sources = [
      $('meta[name="author"]').attr('content'),
      $('meta[property="article:author"]').attr('content'),
      $('[rel="author"]').text(),
      $('.author-name').text(),
      $('.byline').text(),
      $('[itemprop="author"]').text(),
    ];

    for (const source of sources) {
      if (source && source.trim().length > 0 && source.trim().length < 100) {
        return source.trim();
      }
    }

    return undefined;
  }

  /**
   * Extract summary/description
   */
  private extractSummary($: cheerio.CheerioAPI): string | undefined {
    const sources = [
      $('meta[property="og:description"]').attr('content'),
      $('meta[name="description"]').attr('content'),
      $('meta[name="twitter:description"]').attr('content'),
    ];

    for (const source of sources) {
      if (source && source.trim().length > 0) {
        return source.trim();
      }
    }

    return undefined;
  }

  /**
   * Quick check if URL looks like it could be an article (without fetching)
   */
  quickUrlCheck(url: string): { likelyArticle: boolean; confidence: number } {
    const result = this.analyzeUrl(url);
    return {
      likelyArticle: result.score >= 0.1,
      confidence: result.score,
    };
  }

  /**
   * Set minimum word count for article detection
   */
  setMinWordCount(count: number): void {
    this.minWordCount = count;
  }

  /**
   * Set minimum confidence threshold for article detection
   */
  setMinConfidence(confidence: number): void {
    this.minConfidence = Math.max(0, Math.min(1, confidence));
  }
}

export const articleDetectionService = new ArticleDetectionService();
