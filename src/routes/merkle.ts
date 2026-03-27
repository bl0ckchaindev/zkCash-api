import { Router, Request } from 'express';
import { PublicKey } from '@solana/web3.js';
import { fetchMerkleTreeState } from '../solana/contract.js';
import { Commitment } from '../db/index.js';
import { config } from '../config/env.js';
import { createCache } from '../lib/cache.js';
import { sanitizeToken, isValidCommitment } from '../lib/validators.js';

const router = Router();
// Use 0 TTL so every deposit gets the current on-chain root (prevents UnknownRoot after tree updates)
const merkleRootCache = createCache<{ root: string; nextIndex: number; subtrees: string[] }>(config.merkleCacheTtlMs);

const DEVNET_MINTS: Record<string, string> = {
  sol: '11111111111111111111111111111112',
  usdc: 'DWvrXGqTYq1SW9ey857z1nXBxSxihwxdFyQfaRunsAXa',
  usdt: 'EcFc2cMyZxaKBkFK1XooxiyDyCPneLXiMwSJiVY6eTad',
  yesa: 'EwtK6Bydxsm4vAvvMiEG3ymtkJ7WToRpQdeV45wB1Qpa',
  zec: 'Vu3Lcx3chdCHmy9KCCdd19DdJsLejHAZxm1E1bTgE16',
  ore: '6zxkY8UygHKBf64LJDXnzcYr9wdvyqScmj7oGPBFw58Z',
  store: '5MvqBFU5zeHaEfRuAFW2RhqidHLb7Ejsa6sUwPQQXcj1',
};
const MAINNET_MINTS: Record<string, string> = {
  sol: '11111111111111111111111111111112',
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  usdt: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  yesa: 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
  zec: 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS',
  ore: 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp',
  store: 'sTorERYB6xAZ1SSbwpK3zoK2EEwbBrc7TZAzg1uCGiH',
};

const MINT_BY_TOKEN = config.isDevnet ? DEVNET_MINTS : MAINNET_MINTS;

function getMintFromToken(token?: string): PublicKey | undefined {
  if (!token || token === 'sol') return undefined;
  const mintStr = MINT_BY_TOKEN[token];
  if (!mintStr) return undefined;
  return new PublicKey(mintStr);
}

const MERKLE_DEPTH = 26;

router.get('/root', async (req: Request<object, object, object, { token?: string }>, res) => {
  try {
    const token = sanitizeToken(req.query.token);
    const cacheKey = `root:${token}`;
    let data = merkleRootCache.get(cacheKey);
    if (!data) {
      const mint = getMintFromToken(token);
      const state = await fetchMerkleTreeState(mint);
      if (state === null) {
        // SPL tree not initialized (account doesn't exist); SOL tree always expected to exist
        if (mint) {
          return res.status(404).json({
            error: 'Merkle tree not initialized for this token',
            code: 'TREE_NOT_INITIALIZED',
            token,
          });
        }
        data = { root: '0', nextIndex: 0, subtrees: [] };
      } else {
        data = state;
      }
      merkleRootCache.set(cacheKey, data);
    }
    res.json(data);
  } catch (error) {
    console.error('Merkle root error:', error);
    res.status(500).json({ error: 'Failed to fetch merkle root' });
  }
});

/** GET /merkle/path?token=sol&leafIndex=5 — path for leaf index. Returns commitments + nextIndex so the client can build the path with correct internal nodes (same Poseidon/zeros as circuit). */
router.get('/path', async (req: Request<object, object, object, { token?: string; leafIndex?: string }>, res) => {
  try {
    const token = sanitizeToken(req.query.token);
    const leafIndexRaw = req.query.leafIndex;
    const leafIndex = typeof leafIndexRaw === 'string' ? parseInt(leafIndexRaw, 10) : NaN;
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= 2 ** MERKLE_DEPTH) {
      return res.status(400).json({ error: 'Invalid leafIndex; use 0 to ' + (2 ** MERKLE_DEPTH - 1) });
    }
    const mint = getMintFromToken(token);
    const [rootData, commitmentsRows] = await Promise.all([
      fetchMerkleTreeState(mint),
      Commitment.find({ token })
        .select('commitment_index commitment')
        .sort({ commitment_index: 1 })
        .lean(),
    ]);
    if (rootData === null) {
      return res.status(404).json({
        error: 'Merkle tree not initialized for this token',
        code: 'TREE_NOT_INITIALIZED',
        token,
      });
    }
    const commitments = commitmentsRows.map((r) => ({
      commitment_index: Number(r.commitment_index),
      commitment: r.commitment as string,
    }));
    const hasLeaf = commitments.some((c) => c.commitment_index === leafIndex);
    if (!hasLeaf) {
      return res.status(404).json({
        error: 'No commitment at this leaf index',
        hint: 'Indexer may not have indexed this deposit yet, or leafIndex is wrong.',
      });
    }
    res.json({
      root: rootData.root,
      nextIndex: rootData.nextIndex,
      commitments,
    });
  } catch (error) {
    console.error('Merkle path error:', error);
    res.status(500).json({ error: 'Failed to fetch merkle path' });
  }
});

router.get('/proof/:commitment', async (req: Request<{ commitment: string }, object, object, { token?: string }>, res) => {
  try {
    const { commitment } = req.params;
    const token = sanitizeToken(req.query.token);

    if (!isValidCommitment(commitment)) {
      return res.status(400).json({ error: 'Invalid commitment' });
    }

    const commitmentRow = await Commitment.findOne({ commitment, token })
      .select('commitment_index')
      .lean();

    if (!commitmentRow) {
      return res.status(404).json({
        error: 'Commitment not found',
        hint: 'Ensure the indexer is running and this commitment was indexed (e.g. from a prior deposit to this API).',
      });
    }

    const leafIndex = Number(commitmentRow.commitment_index);
    const mint = getMintFromToken(token);
    const [rootData, commitmentsRowsProof] = await Promise.all([
      fetchMerkleTreeState(mint),
      Commitment.find({ token })
        .select('commitment_index commitment')
        .sort({ commitment_index: 1 })
        .lean(),
    ]);
    if (rootData === null) {
      return res.status(404).json({
        error: 'Merkle tree not initialized for this token',
        code: 'TREE_NOT_INITIALIZED',
        token,
      });
    }

    const commitments = commitmentsRowsProof.map((r) => ({
      commitment_index: Number(r.commitment_index),
      commitment: r.commitment as string,
    }));

    res.json({
      leafIndex,
      root: rootData.root,
      nextIndex: rootData.nextIndex,
      commitments,
    });
  } catch (error) {
    console.error('Merkle proof error:', error);
    res.status(500).json({ error: 'Failed to fetch merkle proof' });
  }
});

export default router;
