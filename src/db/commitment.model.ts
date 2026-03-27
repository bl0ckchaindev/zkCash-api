import mongoose, { Schema, type Model } from 'mongoose';

interface CommitmentDoc {
  token: string;
  commitment_index: number;
  commitment: string;
  encrypted_output: string;
  mint_address: string | null;
  transaction_signature: string | null;
  created_at: Date;
  updated_at: Date;
}

const commitmentSchema = new Schema(
  {
    token: { type: String, required: true, default: 'sol' },
    commitment_index: { type: Number, required: true },
    commitment: { type: String, required: true },
    encrypted_output: { type: String, required: true },
    mint_address: { type: String, default: null },
    transaction_signature: { type: String, default: null },
  },
  {
    collection: 'commitments',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

commitmentSchema.index({ commitment: 1 }, { unique: true });
commitmentSchema.index({ token: 1, commitment_index: 1 });
commitmentSchema.index({ token: 1, encrypted_output: 1 });
commitmentSchema.index({ transaction_signature: 1 });
commitmentSchema.index(
  { transaction_signature: 1, commitment: 1 },
  { unique: true, partialFilterExpression: { transaction_signature: { $type: 'string' } } }
);

export const Commitment: Model<CommitmentDoc> =
  (mongoose.models.Commitment as Model<CommitmentDoc>) ??
  mongoose.model<CommitmentDoc>('Commitment', commitmentSchema);
