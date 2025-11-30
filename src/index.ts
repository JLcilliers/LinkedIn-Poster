import express from 'express';
import { config } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/database';
import { logger } from './utils/logger';
import { scheduler } from './scheduler';

// Routes
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import healthRoutes from './routes/health';

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.debug(`${req.method} ${req.path}`, {
      status: res.statusCode,
      duration: `${duration}ms`,
    });
  });
  next();
});

// Routes
app.use('/admin', adminRoutes);
app.use('/auth', authRoutes);
app.use('/health', healthRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'LinkedIn Blog Reposter',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      admin: '/admin',
      auth: '/auth/linkedin',
    },
  });
});

// Error handling
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
async function shutdown(): Promise<void> {
  logger.info('Shutting down...');

  scheduler.stop();
  await disconnectDatabase();

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start(): Promise<void> {
  try {
    // Connect to database
    await connectDatabase();
    logger.info('Database connected');

    // Start scheduler
    scheduler.start();

    // Start HTTP server
    app.listen(config.port, () => {
      logger.info(`Server started on port ${config.port}`);
      logger.info(`Environment: ${config.nodeEnv}`);
      logger.info(`Manual review mode: ${config.manualReviewMode}`);
      logger.info(`Auto-post enabled: ${config.autoPostToLinkedIn}`);

      if (!config.hasLinkedInConfig()) {
        logger.warn('LinkedIn API not configured - set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET');
      }

      if (!config.hasOpenAIConfig()) {
        logger.warn('OpenAI API not configured - set OPENAI_API_KEY');
      }
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

start();
