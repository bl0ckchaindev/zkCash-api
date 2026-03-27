# ZKCash API

Backend API for the ZKCash privacy protocol. Bridges the [ZKCash smart contracts](../zkcash) with the [privacy-cash-sdk](../privacy-cash-sdk) frontend, providing:

- **Config** – On-chain fee rates and rent fees
- **Merkle** – Root and proof lookups for UTXO inclusion
- **UTXOs** – Indexed commitments and encrypted outputs from contract events
- **Relayer** – Deposit and withdraw transaction relay

## Prerequisites

- Node.js 18+
- Solana CLI (for relayer keypair)
- RPC endpoint (devnet/mainnet)
- MongoDB 6+ (local, Atlas, or compatible)

## Setup

```bash
cd zkcash-api
npm install
cp .env.example .env
```

Edit `.env`:

```env
RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=9B3yaayBtBaJspPQ3ggkN31By3a3qjRZtJEmCgtogqAt
ALT_ADDRESS=HEN49U2ySJ85Vc78qprSW9y6mFDhs1NczRxyppNHjofe
FEE_RECIPIENT=AWexibGxNFKTa1b5R5MN4PJr9HWnWRwf8EW9g8cLx3dM
PORT=3001

# MongoDB (database name in URI path)
MONGODB_URI=mongodb://localhost:27017/zkcash
```

**Database:** [Mongoose](https://mongoosejs.com/) connects on startup and ensures indexes on the `commitments` collection (unique `commitment`, compound `token` + `commitment_index`, etc.).

## Running

```bash
npm run dev
```

The event indexer (CommitmentData / SplCommitmentData) starts automatically with the API server.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/config` | Fee rates and rent fees from on-chain GlobalConfig |
| GET | `/merkle/root` | Current merkle root and next index (query: `?token=sol|usdc|...`) |
| GET | `/merkle/proof/:commitment` | Merkle proof for commitment (query: `?token=`) |
| GET | `/utxos/range` | UTXOs in range (query: `start`, `end`, `token`) |
| GET | `/utxos/check/:encryptedOutput` | Check if UTXO exists (query: `?token=`) |
| POST | `/utxos/indices` | Get indices for encrypted outputs (body: `{ encrypted_outputs: [] }`) |
| POST | `/deposit` | Relay signed SOL deposit transaction |
| POST | `/deposit/spl` | Relay signed SPL token deposit |
| POST | `/withdraw` | Build unsigned SOL withdraw tx OR submit signed tx |
| POST | `/withdraw/spl` | Build unsigned SPL withdraw tx OR submit signed tx |

## Security

- **CORS**: Set `CORS_ORIGINS` to comma-separated frontend URLs in production (avoid `*`)
- **Rate limiting**: Relay endpoints (deposit/withdraw) limited to 30 req/min per IP; general endpoints to 120 req/min
- **Input validation**: All params validated (addresses, base64, commitment format, array sizes)
- **Error handling**: Internal errors never leaked to clients
- **Helmet**: Security headers enabled
- **Request size**: JSON body limited to 512KB

## Frontend Integration (privacy-cash-sdk)

Set `NEXT_PUBLIC_RELAYER_API_URL` (or `RELAYER_API_URL`) to your API base URL:

```env
NEXT_PUBLIC_RELAYER_API_URL=http://localhost:3001
```

### Withdraw Flow (Two-Step)

Withdraw requires the user to sign. The API supports:

1. **Build**: POST `/withdraw` with `serializedProof`, accounts, etc. → returns `{ transaction: base64 }`
2. **Submit**: POST `/withdraw` with `{ signedTransaction: base64 }` → returns `{ signature, success }`

The privacy-cash-sdk may need a small update to:
- Call the API to get the unsigned transaction
- Have the user sign it in their wallet
- Send the signed transaction back to the API for submission

## Project Structure

```
zkcash-api/
├── src/
│   ├── config/     # Env config
│   ├── db/         # Mongoose models (commitments)
│   ├── solana/     # Connection, contract state
│   ├── routes/     # Express route handlers
│   ├── indexer/    # Event indexer (CommitmentData, SplCommitmentData)
│   └── index.ts    # Express app entry
└── package.json
```

## Architecture

```
┌─────────────────────┐     ┌──────────────┐     ┌─────────────────────┐
│  privacy-cash-sdk   │────▶│  ZKCash API  │────▶│  ZKCash Program     │
│  (frontend)         │     │  (this)      │     │  (Solana)           │
└─────────────────────┘     └──────────────┘     └─────────────────────┘
        │                            │
        │                            ▼
        │                    ┌──────────────┐
        └───────────────────│   MongoDB    │
                            │ (commitments)│
                            └──────────────┘
```
