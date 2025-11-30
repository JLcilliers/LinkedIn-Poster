import { Router, Request, Response } from 'express';
import { prisma } from '../config/database';
import { config } from '../config/env';
import { linkedInPublisherService } from '../services/LinkedInPublisherService';
import { logger } from '../utils/logger';
import type { HealthStatus } from '../types';

const router = Router();

// Full health check
router.get('/', async (req: Request, res: Response) => {
  const status: HealthStatus = {
    status: 'healthy',
    database: { connected: false },
    linkedin: { configured: false, tokenValid: false },
    openai: { configured: false },
    sources: { activeCount: 0 },
    posts: { todayCount: 0 },
  };

  // Check database
  try {
    await prisma.$queryRaw`SELECT 1`;
    status.database.connected = true;
  } catch (error) {
    status.database.connected = false;
    status.database.error = error instanceof Error ? error.message : 'Unknown error';
    status.status = 'unhealthy';
  }

  // Check LinkedIn configuration
  status.linkedin.configured = config.hasLinkedInConfig();

  if (status.linkedin.configured) {
    try {
      const testResult = await linkedInPublisherService.testConnection();
      status.linkedin.tokenValid = testResult.success;
      if (!testResult.success) {
        status.linkedin.error = testResult.error;
        if (status.status === 'healthy') {
          status.status = 'degraded';
        }
      }
    } catch (error) {
      status.linkedin.tokenValid = false;
      status.linkedin.error = error instanceof Error ? error.message : 'Unknown error';
      if (status.status === 'healthy') {
        status.status = 'degraded';
      }
    }
  } else {
    if (status.status === 'healthy') {
      status.status = 'degraded';
    }
  }

  // Check OpenAI configuration
  status.openai.configured = config.hasOpenAIConfig();
  if (!status.openai.configured) {
    status.openai.error = 'OpenAI API key not configured';
    if (status.status === 'healthy') {
      status.status = 'degraded';
    }
  }

  // Get source count
  try {
    status.sources.activeCount = await prisma.blogSource.count({
      where: { active: true },
    });
  } catch (error) {
    logger.error('Failed to count sources', { error });
  }

  // Get today's post count
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    status.posts.todayCount = await prisma.linkedInPost.count({
      where: {
        status: 'PUBLISHED',
        createdAt: { gte: todayStart },
      },
    });

    const lastPost = await prisma.linkedInPost.findFirst({
      where: { status: 'PUBLISHED' },
      orderBy: { createdAt: 'desc' },
    });

    if (lastPost) {
      status.posts.lastPostedAt = lastPost.createdAt;
    }
  } catch (error) {
    logger.error('Failed to get post stats', { error });
  }

  const httpStatus = status.status === 'unhealthy' ? 503 : 200;
  res.status(httpStatus).json(status);
});

// Simple liveness check
router.get('/live', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness check (can accept traffic)
router.get('/ready', async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({
      status: 'not ready',
      error: 'Database connection failed',
      timestamp: new Date().toISOString(),
    });
  }
});

// Get configuration status (no secrets)
router.get('/config', (req: Request, res: Response) => {
  res.json({
    environment: config.nodeEnv,
    autoPostEnabled: config.autoPostToLinkedIn,
    manualReviewMode: config.manualReviewMode,
    watcherCron: config.watcherCron,
    posterCron: config.posterCron,
    linkedInConfigured: config.hasLinkedInConfig(),
    linkedInTokenSet: config.hasLinkedInToken(),
    openAIConfigured: config.hasOpenAIConfig(),
    openAIModel: config.openai.model,
  });
});

export default router;
