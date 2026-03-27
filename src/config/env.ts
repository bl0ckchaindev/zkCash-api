import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';

const isDevnet = (process.env.RPC_URL ?? '').includes('devnet') || process.env.NETWORK === 'devnet';

/** Parse CORS origins: comma-separated list, or * for allow-all */
function getCorsOrigins(): string[] | '*' {
  const raw = process.env.CORS_ORIGINS ?? '';
  if (raw === '*' || raw.trim() === '') return '*';
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

export const config = {
  rpcUrl: process.env.RPC_URL ?? 'https://api.devnet.solana.com',
  /** Optional WSS URL for subscriptions (same cluster as rpcUrl). Use if your HTTP host’s WSS endpoint has DNS issues; see .env.example. */
  rpcWsUrl: (process.env.RPC_WS_URL ?? '').trim() || undefined,
  /**
   * How often to reconcile recent program txs over HTTP (in addition to WebSocket logs).
   * Set to 0 to disable (not recommended for production). WS alone can miss notifications on reconnect/DNS blips.
   */
  indexerHttpPollMs: parseInt(process.env.INDEXER_HTTP_POLL_MS ?? '10000', 10),
  /** Max signatures to scan per reconciliation tick (paginated in chunks of up to 1000). Increase if the program has bursts beyond this between polls. */
  indexerReconcileSignatureCap: Math.min(
    10_000,
    Math.max(50, parseInt(process.env.INDEXER_RECONCILE_SIGNATURE_CAP ?? '1000', 10))
  ),
  isDevnet,
  programId: new PublicKey(process.env.PROGRAM_ID ?? '9B3yaayBtBaJspPQ3ggkN31By3a3qjRZtJEmCgtogqAt'),
  relayerKeypairPath: process.env.RELAYER_KEYPAIR_PATH ?? './relayer-keypair.json',
  altAddress: new PublicKey(process.env.ALT_ADDRESS ?? '2sJovo7nMgU6ErmFAQzBqanWb7EAZV9P8sbgWjVkS45g'),
  feeRecipient: new PublicKey(process.env.FEE_RECIPIENT ?? 'FEdh2nUJmEntEme72jq9jB2ZGUfNdsL1NEz2zM8y3aPx'),
  port: parseInt(process.env.PORT ?? '3001', 10),
  mongodbUri: process.env.MONGODB_URI ?? '',
  corsOrigins: getCorsOrigins(),
  configCacheTtlMs: parseInt(process.env.CONFIG_CACHE_TTL_MS ?? '30000', 10), // 30s default
  // 0 = always fetch fresh from chain (avoids UnknownRoot when tree updates between requests)
  merkleCacheTtlMs: parseInt(process.env.MERKLE_CACHE_TTL_MS ?? '0', 10),
} as const;

export function validateConfig(): void {
  const missing: string[] = [];
  if (!config.mongodbUri) {
    missing.push('MONGODB_URI');
  }
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${[...new Set(missing)].join(', ')}`);
  }
}
