import { Router, Request, Response } from 'express';
import { prisma } from '../config/database';
import { sourceWatcherService } from '../services/SourceWatcherService';
import { articleFetcherService } from '../services/ArticleFetcherService';
import { relevanceFilterService } from '../services/RelevanceFilterService';
import { postGeneratorService } from '../services/PostGeneratorService';
import { linkedInPublisherService } from '../services/LinkedInPublisherService';
import { scheduler } from '../scheduler';
import { logger } from '../utils/logger';

const router = Router();

// ===== SOURCES =====

// List all sources
router.get('/sources', async (req: Request, res: Response) => {
  try {
    const sources = await sourceWatcherService.listSources();
    res.json(sources);
  } catch (error) {
    logger.error('Failed to list sources', { error });
    res.status(500).json({ error: 'Failed to list sources' });
  }
});

// Add a new source
router.post('/sources', async (req: Request, res: Response) => {
  try {
    const { name, feedUrl, type } = req.body;

    if (!name || !feedUrl) {
      res.status(400).json({ error: 'name and feedUrl are required' });
      return;
    }

    const source = await sourceWatcherService.addSource(name, feedUrl, type || 'RSS');
    res.status(201).json(source);
  } catch (error) {
    logger.error('Failed to add source', { error });
    res.status(500).json({ error: 'Failed to add source' });
  }
});

// Toggle source active status
router.patch('/sources/:id/toggle', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { active } = req.body;

    const source = await sourceWatcherService.toggleSource(id, active);
    res.json(source);
  } catch (error) {
    logger.error('Failed to toggle source', { error });
    res.status(500).json({ error: 'Failed to toggle source' });
  }
});

// Delete a source
router.delete('/sources/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await sourceWatcherService.deleteSource(id);
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete source', { error });
    res.status(500).json({ error: 'Failed to delete source' });
  }
});

// Check sources now
router.post('/sources/check', async (req: Request, res: Response) => {
  try {
    const results = await sourceWatcherService.checkAllSources();
    res.json(results);
  } catch (error) {
    logger.error('Failed to check sources', { error });
    res.status(500).json({ error: 'Failed to check sources' });
  }
});

// ===== ARTICLES =====

// Get article statistics
router.get('/articles/stats', async (req: Request, res: Response) => {
  try {
    const stats = await articleFetcherService.getStats();
    res.json(stats);
  } catch (error) {
    logger.error('Failed to get article stats', { error });
    res.status(500).json({ error: 'Failed to get article stats' });
  }
});

// List articles by status
router.get('/articles', async (req: Request, res: Response) => {
  try {
    const { status, limit } = req.query;
    const articles = await articleFetcherService.getArticlesByStatus(
      status as string || 'NEW',
      parseInt(limit as string) || 50
    );
    res.json(articles);
  } catch (error) {
    logger.error('Failed to list articles', { error });
    res.status(500).json({ error: 'Failed to list articles' });
  }
});

// Fetch content now
router.post('/articles/fetch', async (req: Request, res: Response) => {
  try {
    const results = await articleFetcherService.fetchAllPendingContent();
    res.json(results);
  } catch (error) {
    logger.error('Failed to fetch articles', { error });
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// Filter articles now
router.post('/articles/filter', async (req: Request, res: Response) => {
  try {
    const results = await relevanceFilterService.filterAllPending();
    res.json(results);
  } catch (error) {
    logger.error('Failed to filter articles', { error });
    res.status(500).json({ error: 'Failed to filter articles' });
  }
});

// ===== CRITERIA =====

// Get current criteria
router.get('/criteria', async (req: Request, res: Response) => {
  try {
    const criteria = await relevanceFilterService.getCurrentCriteria();
    res.json(criteria);
  } catch (error) {
    logger.error('Failed to get criteria', { error });
    res.status(500).json({ error: 'Failed to get criteria' });
  }
});

// Update criteria
router.post('/criteria', async (req: Request, res: Response) => {
  try {
    const criteria = await relevanceFilterService.setCriteria(req.body);
    res.json(criteria);
  } catch (error) {
    logger.error('Failed to update criteria', { error });
    res.status(500).json({ error: 'Failed to update criteria' });
  }
});

// Re-filter rejected articles
router.post('/criteria/refilter', async (req: Request, res: Response) => {
  try {
    const count = await relevanceFilterService.refilterRejected();
    res.json({ reset: count });
  } catch (error) {
    logger.error('Failed to refilter', { error });
    res.status(500).json({ error: 'Failed to refilter' });
  }
});

// ===== POSTS =====

// Get pending posts for review
router.get('/posts/pending', async (req: Request, res: Response) => {
  try {
    const posts = await postGeneratorService.getPendingPosts();
    res.json(posts);
  } catch (error) {
    logger.error('Failed to get pending posts', { error });
    res.status(500).json({ error: 'Failed to get pending posts' });
  }
});

// Get a specific post
router.get('/posts/:id', async (req: Request, res: Response) => {
  try {
    const post = await postGeneratorService.getPost(req.params.id);
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    res.json(post);
  } catch (error) {
    logger.error('Failed to get post', { error });
    res.status(500).json({ error: 'Failed to get post' });
  }
});

// Generate posts now
router.post('/posts/generate', async (req: Request, res: Response) => {
  try {
    const results = await postGeneratorService.generateAllPending();
    res.json(results);
  } catch (error) {
    logger.error('Failed to generate posts', { error });
    res.status(500).json({ error: 'Failed to generate posts' });
  }
});

// Update post content
router.patch('/posts/:id', async (req: Request, res: Response) => {
  try {
    const { content } = req.body;
    const post = await postGeneratorService.updatePostContent(req.params.id, content);
    res.json(post);
  } catch (error) {
    logger.error('Failed to update post', { error });
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// Regenerate a post
router.post('/posts/:id/regenerate', async (req: Request, res: Response) => {
  try {
    const result = await postGeneratorService.regeneratePost(req.params.id);
    res.json(result);
  } catch (error) {
    logger.error('Failed to regenerate post', { error });
    res.status(500).json({ error: 'Failed to regenerate post' });
  }
});

// Approve a post
router.post('/posts/:id/approve', async (req: Request, res: Response) => {
  try {
    await linkedInPublisherService.approvePost(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to approve post', { error });
    res.status(500).json({ error: 'Failed to approve post' });
  }
});

// Reject a post
router.post('/posts/:id/reject', async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    await linkedInPublisherService.rejectPost(req.params.id, reason);
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to reject post', { error });
    res.status(500).json({ error: 'Failed to reject post' });
  }
});

// Publish a specific post
router.post('/posts/:id/publish', async (req: Request, res: Response) => {
  try {
    const result = await linkedInPublisherService.publishPost(req.params.id);
    res.json(result);
  } catch (error) {
    logger.error('Failed to publish post', { error });
    res.status(500).json({ error: 'Failed to publish post' });
  }
});

// Publish all approved posts
router.post('/posts/publish', async (req: Request, res: Response) => {
  try {
    const results = await linkedInPublisherService.publishApprovedPosts();
    res.json(results);
  } catch (error) {
    logger.error('Failed to publish posts', { error });
    res.status(500).json({ error: 'Failed to publish posts' });
  }
});

// ===== SCHEDULER =====

// Get scheduler status
router.get('/scheduler/status', (req: Request, res: Response) => {
  const status = scheduler.getStatus();
  res.json(status);
});

// Run a specific job
router.post('/scheduler/run/:job', async (req: Request, res: Response) => {
  try {
    await scheduler.runJob(req.params.job);
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to run job', { error });
    res.status(500).json({ error: 'Failed to run job' });
  }
});

// Run full pipeline
router.post('/scheduler/pipeline', async (req: Request, res: Response) => {
  try {
    await scheduler.runFullPipeline();
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to run pipeline', { error });
    res.status(500).json({ error: 'Failed to run pipeline' });
  }
});

// ===== ACTIVITY LOG =====

// Get recent activity
router.get('/activity', async (req: Request, res: Response) => {
  try {
    const { limit, type } = req.query;
    const logs = await prisma.activityLog.findMany({
      where: type ? { type: type as string } : undefined,
      take: parseInt(limit as string) || 50,
      orderBy: { createdAt: 'desc' },
    });
    res.json(logs);
  } catch (error) {
    logger.error('Failed to get activity', { error });
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

export default router;
