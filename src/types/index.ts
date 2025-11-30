import type {
  BlogSource,
  Article,
  LinkedInPost,
  CriteriaConfig,
  LinkedInToken,
  ActivityLog,
  SourceType,
  ArticleStatus,
  PostMode,
  LinkedInPostStatus,
} from '@prisma/client';

// Re-export Prisma types
export type {
  BlogSource,
  Article,
  LinkedInPost,
  CriteriaConfig,
  LinkedInToken,
  ActivityLog,
  SourceType,
  ArticleStatus,
  PostMode,
  LinkedInPostStatus,
};

// RSS Feed types
export interface RSSFeedItem {
  guid?: string;
  link?: string;
  title?: string;
  contentSnippet?: string;
  content?: string;
  pubDate?: string;
  isoDate?: string;
  creator?: string;
}

export interface ParsedFeed {
  title?: string;
  description?: string;
  link?: string;
  items: RSSFeedItem[];
}

// Criteria parsing
export interface ParsedCriteria {
  includeKeywords: string[];
  excludeKeywords: string[];
  targetAudienceDescription: string;
  defaultHashtags: string[];
  maxPostsPerDay: number;
}

// LinkedIn API types
export interface LinkedInShareContent {
  shareCommentary: {
    text: string;
  };
  shareMediaCategory: 'NONE' | 'ARTICLE' | 'IMAGE';
}

export interface LinkedInUGCPost {
  author: string;
  lifecycleState: 'PUBLISHED';
  specificContent: {
    'com.linkedin.ugc.ShareContent': LinkedInShareContent;
  };
  visibility: {
    'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' | 'CONNECTIONS';
  };
}

export interface LinkedInPostResponse {
  id: string;
  activity?: string;
}

// Service results
export interface FetchResult {
  success: boolean;
  articlesFound: number;
  articlesNew: number;
  errors: string[];
}

export interface FilterResult {
  articleId: string;
  isRelevant: boolean;
  matchedKeywords: string[];
  excludedKeywords: string[];
}

export interface GenerationResult {
  articleId: string;
  postId: string;
  contentLength: number;
  success: boolean;
  error?: string;
}

export interface PublishResult {
  postId: string;
  linkedInUrn?: string;
  linkedInUrl?: string;
  success: boolean;
  error?: string;
}

// Health check
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  database: {
    connected: boolean;
    error?: string;
  };
  linkedin: {
    configured: boolean;
    tokenValid: boolean;
    error?: string;
  };
  openai: {
    configured: boolean;
    error?: string;
  };
  sources: {
    activeCount: number;
  };
  posts: {
    todayCount: number;
    lastPostedAt?: Date;
  };
}

// Activity log types
export type ActivityType =
  | 'SOURCE_ADDED'
  | 'SOURCE_CHECKED'
  | 'ARTICLE_DISCOVERED'
  | 'ARTICLE_FETCHED'
  | 'ARTICLE_FILTERED'
  | 'ARTICLE_REJECTED'
  | 'POST_GENERATED'
  | 'POST_APPROVED'
  | 'POST_PUBLISHED'
  | 'POST_FAILED'
  | 'LINKEDIN_AUTH'
  | 'SYSTEM_ERROR';
