# Callora Backend

API gateway, usage metering, and billing services for the Callora API marketplace. Talks to Soroban contracts and Horizon for on-chain settlement.

## Tech stack

- **Node.js** + **TypeScript**
- **Express** for HTTP API
- **Stellar SDK** for Horizon integration
- **Circuit Breaker & Retry Patterns** for resilience
- Planned: Horizon listener, PostgreSQL, billing engine

## What's included

- Health check: `GET /api/health`
- Placeholder routes: `GET /api/apis`, `GET /api/usage`
- **Vault deposit transactions:** `POST /api/deposits/build`
- **Circuit breaker health:** `GET /api/deposits/health`
- JSON body parsing; ready to add auth, metering, and contract calls

## Resilience Features

The backend implements production-grade resilience patterns for Stellar Horizon network calls:

- ✅ **Bounded Retry with Exponential Backoff** - Automatically retries transient failures
- ✅ **Circuit Breaker Pattern** - Fast-fails during outages to prevent resource exhaustion
- ✅ **Graceful Degradation** - Maps upstream failures to appropriate HTTP status codes (502)
- ✅ **Health Monitoring** - Exposes circuit breaker metrics for observability

See [RESILIENCE.md](./RESILIENCE.md) for detailed documentation.

## Local setup

1. **Prerequisites:** Node.js 18+

2. **Install dependencies:**

   ```bash
   cd callora-backend
   npm install
   ```

3. **Configure environment (optional):**

   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Run in development mode:**

   ```bash
   npm run dev
   ```

5. API base: [http://localhost:3000](http://localhost:3000). Example: [http://localhost:3000/api/health](http://localhost:3000/api/health).

## Scripts

| Command          | Description                    |
|------------------|--------------------------------|
| `npm run dev`    | Run with tsx watch (no build)  |
| `npm run build`  | Compile TypeScript to `dist/`  |
| `npm start`      | Run compiled `dist/index.js`   |
| `npm test`       | Run test suite with Jest       |
| `npm run lint`   | Run ESLint                     |
| `npm run typecheck` | Type-check without building |

## API Endpoints

### Vault Deposits

**POST /api/deposits/build**

Build a vault deposit transaction.

Request:
```json
{
  "sourcePublicKey": "GSOURCE123...",
  "vaultPublicKey": "GVAULT456...",
  "amount": "100.5"
}
```

Response (200):
```json
{
  "success": true,
  "transactionXdr": "AAAAA...ZZZZZ"
}
```

Error (502 - Circuit Breaker Open):
```json
{
  "success": false,
  "error": "Stellar Horizon service is currently unavailable. Circuit breaker is open. Please try again later."
}
```

**GET /api/deposits/health**

Get circuit breaker health metrics.

Response (200):
```json
{
  "success": true,
  "circuitBreaker": {
    "state": "CLOSED",
    "consecutiveFailures": 0,
    "totalFailures": 2,
    "totalSuccesses": 10
  }
}
```

## Project layout

```
callora-backend/
├── src/
│   ├── lib/
│   │   ├── errors.ts                    # Custom error classes
│   │   ├── retry.ts                     # Retry mechanism
│   │   ├── retry.test.ts
│   │   ├── circuitBreaker.ts            # Circuit breaker
│   │   └── circuitBreaker.test.ts
│   ├── services/
│   │   ├── transactionBuilder.ts        # Stellar transaction builder
│   │   └── transactionBuilder.test.ts
│   ├── controllers/
│   │   ├── depositController.ts         # Deposit API controller
│   │   └── depositController.test.ts
│   ├── index.ts                         # Express app and routes
│   └── index.test.ts
├── .env.example                         # Environment configuration template
├── RESILIENCE.md                        # Resilience patterns documentation
├── package.json
└── tsconfig.json
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port | `3000` |
| `HORIZON_URL` | Stellar Horizon endpoint | `https://horizon-testnet.stellar.org` |
| `STELLAR_BASE_FEE` | Transaction base fee (stroops) | `100` |
| `STELLAR_TRANSACTION_TIMEOUT` | Transaction timeout (seconds) | `30` |
| `CIRCUIT_BREAKER_THRESHOLD` | Failures before opening circuit | `5` |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | Cooldown period (ms) | `30000` |
| `RETRY_MAX_ATTEMPTS` | Maximum retry attempts | `3` |
| `RETRY_BASE_DELAY_MS` | Initial retry delay (ms) | `1000` |

See `.env.example` for complete configuration options.

## Testing

Run the test suite:

```bash
npm test
```

Run with coverage:

```bash
npm test -- --coverage
```

The test suite includes:
- Unit tests for retry mechanism
- Unit tests for circuit breaker
- Integration tests for transaction builder
- HTTP integration tests for controllers
- Mock Horizon responses for various scenarios

**Target Coverage:** 90%+ line coverage

## Troubleshooting

### Circuit Breaker Stuck Open

If the circuit breaker remains open:

1. Check `/api/deposits/health` to see current state
2. Verify `HORIZON_URL` is correct and accessible
3. Wait for cooldown period to elapse
4. Restart service to reset circuit breaker

### High Latency

If experiencing high latency:

1. Reduce `RETRY_MAX_ATTEMPTS`
2. Lower `CIRCUIT_BREAKER_THRESHOLD` to fail faster
3. Check Horizon service status
4. Review logs for retry patterns

See [RESILIENCE.md](./RESILIENCE.md) for detailed troubleshooting guide.

## Related Repositories

This repo is part of [Callora](https://github.com/your-org/callora):
- Frontend: `callora-frontend`
- Contracts: `callora-contracts`
