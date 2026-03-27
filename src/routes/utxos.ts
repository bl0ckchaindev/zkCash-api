import { Router, Request } from 'express';
import { Commitment } from '../db/index.js';
import { sanitizeToken, clampInt, isValidEncryptedOutput } from '../lib/validators.js';

const router = Router();

const MAX_RANGE_SIZE = 1000;
const MAX_INDICES_BATCH = 500;

router.get(
  '/range',
  async (
    req: Request<object, object, object, { token?: string; start?: string; end?: string }>,
    res
  ) => {
    try {
      const token = sanitizeToken(req.query.token);
      const start = clampInt(req.query.start, 0, 0, Number.MAX_SAFE_INTEGER);
      const end = clampInt(req.query.end, 20000, start, start + MAX_RANGE_SIZE);

      const [total, rows] = await Promise.all([
        Commitment.countDocuments({ token }),
        Commitment.find({ token, commitment_index: { $gte: start, $lt: end } })
          .select('commitment_index commitment encrypted_output')
          .sort({ commitment_index: 1 })
          .limit(MAX_RANGE_SIZE)
          .lean(),
      ]);

      const list = rows;
      // Only include non-empty encrypted_output so clients get decryptable entries
      const encrypted_outputs = list
        .map((r) => (r as { encrypted_output?: string | null }).encrypted_output)
        .filter((eo): eo is string => typeof eo === 'string' && eo.length > 0);

      if (list.length > 0 && encrypted_outputs.length < list.length) {
        console.warn(`[utxos/range] token=${token} start=${start} end=${end}: ${list.length} rows, ${encrypted_outputs.length} with encrypted_output (${list.length - encrypted_outputs.length} null/empty)`);
      }

      res.json({
        encrypted_outputs,
        total,
        hasMore: list.length >= MAX_RANGE_SIZE || end < total,
        len: list.length,
        utxos: list.map((r) => ({
          index: r.commitment_index,
          commitment: r.commitment,
          encrypted_output: r.encrypted_output,
        })),
      });
    } catch (error) {
      console.error('UTXOs range error:', error);
      res.status(500).json({ error: 'Failed to fetch UTXOs' });
    }
  }
);

router.get('/check/:encryptedOutput', async (req: Request<{ encryptedOutput: string }, object, object, { token?: string }>, res) => {
  try {
    const { encryptedOutput } = req.params;
    const token = sanitizeToken(req.query.token);

    if (!isValidEncryptedOutput(encryptedOutput)) {
      return res.status(400).json({ error: 'Invalid encrypted output' });
    }

    const row = await Commitment.findOne({ encrypted_output: encryptedOutput, token })
      .select('_id')
      .lean();

    res.json({ exists: !!row });
  } catch (error) {
    console.error('UTXO check error:', error);
    res.status(500).json({ error: 'Failed to check UTXO' });
  }
});

router.post('/indices', async (req, res) => {
  try {
    const { encrypted_outputs, token: bodyToken } = req.body as { encrypted_outputs?: unknown; token?: unknown };
    if (!Array.isArray(encrypted_outputs)) {
      return res.status(400).json({ error: 'encrypted_outputs must be an array' });
    }
    if (encrypted_outputs.length > MAX_INDICES_BATCH) {
      return res.status(400).json({ error: `Maximum ${MAX_INDICES_BATCH} items per request` });
    }

    const valid = encrypted_outputs.filter((e): e is string => typeof e === 'string' && isValidEncryptedOutput(e));
    const invalidCount = encrypted_outputs.length - valid.length;
    if (invalidCount > 0) {
      return res.status(400).json({ error: `${invalidCount} invalid encrypted output(s)` });
    }

    const token = sanitizeToken(bodyToken);
    const rows = await Commitment.find({ token, encrypted_output: { $in: valid } })
      .select('encrypted_output commitment_index')
      .lean();

    const byEnc = new Map<string, number>();
    for (const r of rows) {
      byEnc.set(r.encrypted_output, r.commitment_index);
    }

    const indices = valid.map((enc) => byEnc.get(enc) ?? -1);

    res.json({ indices });
  } catch (error) {
    console.error('UTXO indices error:', error);
    res.status(500).json({ error: 'Failed to fetch indices' });
  }
});

export default router;
