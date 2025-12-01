import * as cheerio from 'cheerio';
import axios from 'axios';
import { logger } from './logger';

interface ExtractedContent {
  title: string;
  content: string;
  author?: string;
  publishedDate?: string;
  rawHtml?: string;
}

export async function extractArticleContent(url: string): Promise<ExtractedContent> {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.5',
      },
      timeout: 30000,
    });

    const $ = cheerio.load(response.data);

    // Remove unwanted elements
    $('script, style, nav, header, footer, aside, .ad, .advertisement, .social-share, .comments, .related-posts').remove();

    // Try to find the main content using common selectors
    const contentSelectors = [
      'article',
      '[role="main"]',
      'main',
      '.post-content',
      '.article-content',
      '.entry-content',
      '.content-body',
      '.article-body',
      '#article-body',
      '.story-body',
      '.post-body',
    ];

    let content = '';
    for (const selector of contentSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        content = element.text().trim();
        if (content.length > 200) {
          break;
        }
      }
    }

    // Fallback to body if no content found
    if (content.length < 200) {
      content = $('body').text().trim();
    }

    // Clean up the content
    content = cleanText(content);

    // Extract title
    let title = '';
    const titleSelectors = [
      'h1',
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'title',
    ];

    for (const selector of titleSelectors) {
      if (selector.startsWith('meta')) {
        const meta = $(selector).attr('content');
        if (meta) {
          title = meta.trim();
          break;
        }
      } else {
        const element = $(selector).first();
        if (element.length > 0) {
          title = element.text().trim();
          if (title.length > 0) {
            break;
          }
        }
      }
    }

    // Extract author
    let author: string | undefined;
    const authorSelectors = [
      'meta[name="author"]',
      'meta[property="article:author"]',
      '.author-name',
      '.byline',
      '[rel="author"]',
    ];

    for (const selector of authorSelectors) {
      if (selector.startsWith('meta')) {
        const meta = $(selector).attr('content');
        if (meta) {
          author = meta.trim();
          break;
        }
      } else {
        const element = $(selector).first();
        if (element.length > 0) {
          author = element.text().trim();
          if (author && author.length > 0) {
            break;
          }
        }
      }
    }

    // Extract published date
    let publishedDate: string | undefined;
    const dateSelectors = [
      'meta[property="article:published_time"]',
      'meta[name="publish-date"]',
      'time[datetime]',
      '.publish-date',
      '.post-date',
    ];

    for (const selector of dateSelectors) {
      if (selector.startsWith('meta')) {
        const meta = $(selector).attr('content');
        if (meta) {
          publishedDate = meta.trim();
          break;
        }
      } else if (selector === 'time[datetime]') {
        const datetime = $('time').attr('datetime');
        if (datetime) {
          publishedDate = datetime.trim();
          break;
        }
      } else {
        const element = $(selector).first();
        if (element.length > 0) {
          publishedDate = element.text().trim();
          if (publishedDate && publishedDate.length > 0) {
            break;
          }
        }
      }
    }

    return {
      title,
      content,
      author,
      publishedDate,
      rawHtml: response.data as string,
    };
  } catch (error) {
    logger.error('Failed to extract article content', { url, error });
    throw new Error(`Failed to extract content from ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function cleanText(text: string): string {
  return text
    // Replace multiple whitespace/newlines with single space
    .replace(/\s+/g, ' ')
    // Remove leading/trailing whitespace
    .trim()
    // Remove common noise phrases
    .replace(/Share this article/gi, '')
    .replace(/Subscribe to our newsletter/gi, '')
    .replace(/Follow us on/gi, '')
    .replace(/Read more:/gi, '')
    .replace(/Related articles?:/gi, '')
    // Clean up again after removals
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  // Find a good breaking point (end of sentence or paragraph)
  const truncated = content.substring(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastNewline = truncated.lastIndexOf('\n');

  const breakPoint = Math.max(lastPeriod, lastNewline);
  if (breakPoint > maxLength * 0.8) {
    return truncated.substring(0, breakPoint + 1);
  }

  // Fall back to word boundary
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 0) {
    return truncated.substring(0, lastSpace) + '...';
  }

  return truncated + '...';
}
