module.exports = (req, res) => {
  res.status(200).json({
    name: 'LinkedIn Blog Reposter',
    version: '1.0.0',
    status: 'running',
    message: 'API is working on Vercel!',
    path: req.url,
    method: req.method,
    timestamp: new Date().toISOString()
  });
};
