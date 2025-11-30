import express from 'express';
import { config } from '../src/config/env';
import { connectDatabase } from '../src/config/database';
import { logger } from '../src/utils/logger';

// Routes
import adminRoutes from '../src/routes/admin';
import authRoutes from '../src/routes/auth';
import healthRoutes from '../src/routes/health';

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
    environment: 'vercel',
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

// Initialize database connection (lazy)
let dbInitialized = false;
app.use(async (req, res, next) => {
  if (!dbInitialized) {
    try {
      await connectDatabase();
      dbInitialized = true;
    } catch (error) {
      logger.error('Database connection failed', { error });
    }
  }
  next();
});

export default app;
