import express, { Request, Response, NextFunction } from 'express';
import { buildDepositTransaction, getDepositHealth } from './controllers/depositController.js';

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'callora-backend' });
});

// Placeholder routes
app.get('/api/apis', (_req, res) => {
  res.json({ apis: [] });
});

app.get('/api/usage', (_req, res) => {
  res.json({ calls: 0, period: 'current' });
});

// Deposit routes
app.post('/api/deposits/build', buildDepositTransaction);
app.get('/api/deposits/health', getDepositHealth);

// Error handler middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';

  console.error(`[Error] ${statusCode}: ${message}`, err);

  res.status(statusCode).json({
    success: false,
    error: message,
  });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Callora backend listening on http://localhost:${PORT}`);
  });
}

export default app;