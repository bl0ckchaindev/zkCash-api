/** Mongoose connection and `Commitment` model for the indexer + UTXO/merkle routes. */
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { Commitment } from './commitment.model.js';

export { Commitment } from './commitment.model.js';

export async function connectDb(): Promise<void> {
  if (mongoose.connection.readyState === 1) return;
  if (!config.mongodbUri) {
    throw new Error('MONGODB_URI must be set in environment');
  }
  await mongoose.connect(config.mongodbUri);
  await Commitment.createIndexes();
}
