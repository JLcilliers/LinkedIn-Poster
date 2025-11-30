const express = require('express');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root endpoint - simple health check
app.get('/', (req, res) => {
  res.json({
    name: 'LinkedIn Blog Reposter',
    version: '1.0.0',
    status: 'running',
    environment: process.env.NODE_ENV || 'development',
    message: 'API is working on Vercel!',
    endpoints: {
      health: '/health',
      admin: '/admin',
      auth: '/auth/linkedin',
    },
  });
});

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

// Catch-all for other routes
app.all('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

module.exports = app;
