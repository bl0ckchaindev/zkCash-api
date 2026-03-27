/**
 * ZKCash program event indexer.
 * Uses connection.onLogs() for low-latency updates plus periodic HTTP reconciliation of recent signatures.
 * WebSocket delivery is best-effort; overlapping HTTP scans close gaps from reconnects, RPC drops, or missed notifications.
 * Inserts are idempotent ($setOnInsert on commitment) so duplicate paths are safe.
 */
import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { getConnection } from '../solana/connection.js';
import { config } from '../config/env.js';
import { Commitment } from '../db/index.js';

/** Anchor event discriminator = first 8 bytes of sha256("event:EventName"). */
function eventDiscriminator(eventName: string): Buffer {
  return createHash('sha256').update(`event:${eventName}`).digest().subarray(0, 8);
}

const DISCRIMINATOR_COMMITMENT = eventDiscriminator('CommitmentData');
const DISCRIMINATOR_SPL_COMMITMENT = eventDiscriminator('SplCommitmentData');

/** Commitment bytes to decimal (big-endian, same as root/circuit/instruction). */
function commitmentToDecimal(commitment: Uint8Array): string {
  const buf = Buffer.from(commitment);
  if (buf.length !== 32) return '0';
  return BigInt('0x' + buf.toString('hex')).toString(10);
}

/** Layout after 8-byte discriminator: index(8) + commitment(32) + encLen(4) + encrypted_output. */
function parseCommitmentData(data: Buffer): { index: number; commitment: string; encryptedOutput: string } | null {
  const minLen = 8 + 8 + 32 + 4;
  if (data.length < minLen) return null;
  const index = Number(data.readBigUInt64LE(8));
  const commitmentBytes = data.slice(16, 48);
  const encLen = data.readUInt32LE(48);
  if (52 + encLen > data.length) return null;
  const encryptedOutput = data.slice(52, 52 + encLen);
  return {
    index,
    commitment: commitmentToDecimal(commitmentBytes),
    encryptedOutput: encryptedOutput.toString('hex'),
  };
}

/** Layout after 8-byte discriminator: index(8) + mint(32) + commitment(32) + encLen(4) + encrypted_output. */
function parseSplCommitmentData(
  data: Buffer
): { index: number; mintAddress: string; commitment: string; encryptedOutput: string } | null {
  const minLen = 8 + 8 + 32 + 32 + 4;
  if (data.length < minLen) return null;
  const index = Number(data.readBigUInt64LE(8));
  const mintBytes = data.slice(16, 48);
  const commitmentBytes = data.slice(48, 80);
  const encLen = data.readUInt32LE(80);
  if (84 + encLen > data.length) return null;
  const encryptedOutput = data.slice(84, 84 + encLen);
  return {
    index,
    mintAddress: new PublicKey(mintBytes).toString(),
    commitment: commitmentToDecimal(commitmentBytes),
    encryptedOutput: encryptedOutput.toString('hex'),
  };
}

/** Canonical mints per network. Always store these in DB so mint_address is never invalid. */
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const MAINNET_MINT_TO_TOKEN: Record<string, string> = {
  '11111111111111111111111111111112': 'sol',
  [SOL_MINT]: 'sol',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'usdc',
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB': 'yesa',
};
const DEVNET_MINT_TO_TOKEN: Record<string, string> = {
  '11111111111111111111111111111112': 'sol',
  [SOL_MINT]: 'sol',
  'DWvrXGqTYq1SW9ey857z1nXBxSxihwxdFyQfaRunsAXa': 'usdc',
  'GykHjnHqwNsFmyY2wFT1drprpm1SZWR69CKPMUSFZBvH': 'yesa',
};

const MAINNET_TOKEN_TO_MINT: Record<string, string> = {
  sol: SOL_MINT,
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  yesa: 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
};
const DEVNET_TOKEN_TO_MINT: Record<string, string> = {
  sol: SOL_MINT,
  usdc: 'DWvrXGqTYq1SW9ey857z1nXBxSxihwxdFyQfaRunsAXa',
  yesa: 'GykHjnHqwNsFmyY2wFT1drprpm1SZWR69CKPMUSFZBvH',
};

const MINT_TO_TOKEN = config.isDevnet ? DEVNET_MINT_TO_TOKEN : MAINNET_MINT_TO_TOKEN;
const TOKEN_TO_MINT = config.isDevnet ? DEVNET_TOKEN_TO_MINT : MAINNET_TOKEN_TO_MINT;

function processLogLines(
  logLines: string[],
  transactionSignature: string
): Array<{
  token: string;
  commitment_index: number;
  commitment: string;
  encrypted_output: string;
  mint_address: string | null;
  transaction_signature: string;
}> {
  const rows: Array<{
    token: string;
    commitment_index: number;
    commitment: string;
    encrypted_output: string;
    mint_address: string | null;
    transaction_signature: string;
  }> = [];

  for (const log of logLines) {
    if (!log.includes('Program data:')) continue;
    const parts = log.split('Program data: ');
    if (parts.length < 2) continue;
    const dataEncoded = parts[1].trim();
    let data: Buffer;
    try {
      data = Buffer.from(dataEncoded, 'base64');
    } catch {
      try {
        data = Buffer.from(dataEncoded, 'hex');
      } catch {
        continue;
      }
    }
    if (data.length < 8) continue;

    const disc = data.subarray(0, 8);
    let parsed: ReturnType<typeof parseCommitmentData> | ReturnType<typeof parseSplCommitmentData> = null;
    if (disc.equals(DISCRIMINATOR_COMMITMENT)) {
      parsed = parseCommitmentData(data);
    } else if (disc.equals(DISCRIMINATOR_SPL_COMMITMENT)) {
      parsed = parseSplCommitmentData(data);
    }
    if (!parsed) continue;

    const token = 'mintAddress' in parsed ? (MINT_TO_TOKEN[parsed.mintAddress as string] ?? 'sol') : 'sol';
    const mintAddress: string | null = TOKEN_TO_MINT[token] ?? SOL_MINT;
    rows.push({
      token,
      commitment_index: parsed.index,
      commitment: parsed.commitment,
      encrypted_output: parsed.encryptedOutput,
      mint_address: mintAddress,
      transaction_signature: transactionSignature,
    });
  }

  return rows;
}

async function indexLogs(logLines: string[], transactionSignature: string): Promise<void> {
  const rows = processLogLines(logLines, transactionSignature);
  if (rows.length === 0) return;

  const deduped = [...new Map(rows.map((r) => [r.commitment, r])).values()];

  try {
    await Commitment.bulkWrite(
      deduped.map((row) => ({
        updateOne: {
          filter: { commitment: row.commitment },
          update: {
            $setOnInsert: {
              token: row.token,
              commitment_index: row.commitment_index,
              commitment: row.commitment,
              encrypted_output: row.encrypted_output,
              mint_address: row.mint_address,
              transaction_signature: row.transaction_signature,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  } catch (e) {
    console.error('Indexer insert error:', e);
  }
}

/** Solana RPC max per getSignaturesForAddress page. */
const SIGNATURE_PAGE_SIZE = 1000;
const RESUBSCRIBE_DELAY_MS = 5000;
const GET_TX_ATTEMPTS = 4;
const GET_TX_RETRY_BASE_MS = 400;

let fullCatchUpInFlight = false;
let reconcileInFlight = false;

async function fetchParsedTransactionLogged(connection: ReturnType<typeof getConnection>, signature: string) {
  let lastErr: unknown;
  for (let attempt = 0; attempt < GET_TX_ATTEMPTS; attempt++) {
    try {
      return await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, GET_TX_RETRY_BASE_MS * (attempt + 1)));
    }
  }
  console.error(`Indexer: getParsedTransaction failed after ${GET_TX_ATTEMPTS} tries:`, signature, lastErr);
  return null;
}

async function indexSignatures(connection: ReturnType<typeof getConnection>, signatures: string[]): Promise<void> {
  for (const signature of signatures) {
    const tx = await fetchParsedTransactionLogged(connection, signature);
    if (tx?.meta?.logMessages?.length) {
      await indexLogs(tx.meta.logMessages, signature);
    }
  }
}

async function catchUpFullGuarded(): Promise<void> {
  if (fullCatchUpInFlight) return;
  fullCatchUpInFlight = true;
  try {
    await catchUpFullHistory();
  } finally {
    fullCatchUpInFlight = false;
  }
}

async function reconcileRecentGuarded(): Promise<void> {
  if (reconcileInFlight) return;
  reconcileInFlight = true;
  try {
    await reconcileRecentSignatures();
  } finally {
    reconcileInFlight = false;
  }
}

/** Paginate from newest until chain history for this program is exhausted (startup backfill). */
async function catchUpFullHistory(): Promise<void> {
  const connection = getConnection();
  let before: string | undefined;
  let page = 0;

  try {
    for (;;) {
      const sigs = await connection.getSignaturesForAddress(config.programId, {
        limit: SIGNATURE_PAGE_SIZE,
        before,
      });
      if (sigs.length === 0) break;

      page += 1;
      if (page === 1 || page % 10 === 0) {
        console.log(`ZKCash indexer: catch-up page ${page} (${sigs.length} signatures, before=${before ?? 'head'})`);
      }

      await indexSignatures(
        connection,
        sigs.map((s) => s.signature)
      );

      before = sigs[sigs.length - 1]!.signature;
      if (sigs.length < SIGNATURE_PAGE_SIZE) break;
    }
  } catch (e) {
    console.error('Indexer catch-up error:', e);
  }
}

/**
 * Walk recent signatures (newest first) up to indexerReconcileSignatureCap — backup path when WS misses txs.
 */
async function reconcileRecentSignatures(): Promise<void> {
  const connection = getConnection();
  const cap = config.indexerReconcileSignatureCap;
  let before: string | undefined;
  let fetched = 0;

  try {
    while (fetched < cap) {
      const chunk = Math.min(SIGNATURE_PAGE_SIZE, cap - fetched);
      const sigs = await connection.getSignaturesForAddress(config.programId, {
        limit: chunk,
        before,
      });
      if (sigs.length === 0) break;

      await indexSignatures(
        connection,
        sigs.map((s) => s.signature)
      );

      fetched += sigs.length;
      before = sigs[sigs.length - 1]!.signature;
      if (sigs.length < chunk) break;
    }
  } catch (e) {
    console.error('Indexer reconcile error:', e);
  }
}

/**
 * Start the indexer: subscribe to logs immediately, run full history backfill in parallel, and reconcile on an interval.
 * Call this when the backend starts (e.g. after app.listen).
 */
export function startIndexer(): void {
  const connection = getConnection();

  console.log('ZKCash indexer: starting (WS + HTTP reconcile)...');

  catchUpFullGuarded()
    .then(() => {
      console.log('ZKCash indexer: full history catch-up done.');
    })
    .catch((e) => {
      console.error('ZKCash indexer: full catch-up failed:', e);
    });

  const pollMs = config.indexerHttpPollMs;
  if (pollMs > 0) {
    const runReconcile = () => {
      reconcileRecentGuarded().catch((e) => {
        console.error('ZKCash indexer: reconcile error:', e);
      });
    };
    setTimeout(runReconcile, 2000);
    setInterval(runReconcile, pollMs);
    console.log(
      `ZKCash indexer: HTTP reconcile every ${pollMs}ms, up to ${config.indexerReconcileSignatureCap} sigs/tick (INDEXER_HTTP_POLL_MS, INDEXER_RECONCILE_SIGNATURE_CAP)`
    );
  } else {
    console.warn(
      'ZKCash indexer: INDEXER_HTTP_POLL_MS=0 — only WebSocket logs; missed notifications will not be repaired until restart.'
    );
  }

  const subscribe = (): void => {
    try {
      connection.onLogs(
        config.programId,
        (logs, _ctx) => {
          const signature = (logs as { signature?: string; logs?: string[] }).signature;
          if (logs.logs?.length && signature) {
            indexLogs(logs.logs, signature).catch((e) => {
              console.error('Indexer callback error:', e);
            });
          }
        },
        'confirmed'
      );
      console.log('ZKCash indexer: subscribed to program logs (confirmed).');
    } catch (e) {
      console.error('ZKCash indexer: subscribe error, resubscribing in', RESUBSCRIBE_DELAY_MS, 'ms:', e);
      setTimeout(subscribe, RESUBSCRIBE_DELAY_MS);
    }
  };

  subscribe();
}
