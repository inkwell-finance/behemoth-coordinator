/**
 * gRPC client for communication with behemoth-trader.
 * Runs over internal network with mTLS.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { resolve, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { BacktestRequest, BacktestResponse, PaperShadowRequest, PaperShadowResponse } from '@inkwell-finance/behemoth-protocol';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Proto file path - works in both dev and Docker
function findProtoPath(): string {
  const candidates = [
    // Docker container path
    '/app/behemoth-protocol/src/grpc/trader.proto',
    // Development path (from src/trader/)
    resolve(__dirname, '../../../behemoth-protocol/src/grpc/trader.proto'),
    // Alternative dev path
    resolve(process.cwd(), '../behemoth-protocol/src/grpc/trader.proto'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new Error(`Could not find trader.proto. Searched: ${candidates.join(', ')}`);
}

const PROTO_PATH = findProtoPath();

export interface TraderClientConfig {
  endpoint: string;          // e.g., 'localhost:50051'
  tlsCertPath?: string;      // Path to client certificate (optional for dev)
  tlsKeyPath?: string;       // Path to client key (optional for dev)
  tlsCaPath?: string;        // Path to CA certificate (optional for dev)
  timeoutMs: number;         // Request timeout
}

/**
 * Client interface for communicating with the trader.
 */
export interface TraderClient {
  /**
   * Run a backtest for a proposal.
   */
  runBacktest(request: BacktestRequest, traceId?: string): Promise<BacktestResponse>;

  /**
   * Start paper trading for a proposal.
   */
  startPaperShadow(request: PaperShadowRequest): Promise<PaperShadowResponse>;

  /**
   * Get paper trading results.
   */
  getPaperResults(paperTradeId: string): Promise<PaperResultsResponse>;

  /**
   * Health check.
   */
  healthCheck(): Promise<HealthCheckResponse>;

  /**
   * Close the client connection.
   */
  close(): void;
}

export interface PaperResultsResponse {
  paperTradeId: string;
  status: 'running' | 'completed' | 'stopped' | 'not_found';
  relativePnl?: number;
  daysElapsed?: number;
  sharpeRatio?: number;
  recommendPromotion?: boolean;
}

export interface HealthCheckResponse {
  healthy: boolean;
  version: string;
  uptimeSeconds: number;
  activePaperTrades: number;
}

/**
 * Build gRPC channel credentials from environment variables.
 *
 * Priority:
 *   1. mTLS — when GRPC_CA_CERT, GRPC_CLIENT_KEY, and GRPC_CLIENT_CERT are all set.
 *   2. Insecure — when GRPC_INSECURE=true (dev only).
 *   3. Error — neither condition met; prevents accidental plain-text in production.
 */
function createClientCredentials(): grpc.ChannelCredentials {
  const caPath = process.env.GRPC_CA_CERT;
  const keyPath = process.env.GRPC_CLIENT_KEY;
  const certPath = process.env.GRPC_CLIENT_CERT;

  if (caPath && keyPath && certPath) {
    return grpc.credentials.createSsl(
      readFileSync(caPath),
      readFileSync(keyPath),
      readFileSync(certPath),
    );
  }

  if (process.env.GRPC_INSECURE === 'true') {
    return grpc.credentials.createInsecure();
  }

  throw new Error('gRPC TLS certs not configured. Set GRPC_CA_CERT, GRPC_CLIENT_KEY, GRPC_CLIENT_CERT or GRPC_INSECURE=true for dev.');
}

/**
 * Create a trader client using gRPC.
 */
export function createTraderClient(config: TraderClientConfig): TraderClient {
  // Load proto definition
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const traderProto = grpc.loadPackageDefinition(packageDefinition) as any;

  // Credentials resolved from environment (mTLS in production, insecure in dev)
  const credentials = createClientCredentials();

  // Create gRPC client
  const client = new traderProto.behemoth.trader.TraderService(
    config.endpoint,
    credentials,
  );

  // Helper to promisify gRPC calls
  function promisify<TReq, TRes>(method: string, metadata?: grpc.Metadata): (req: TReq) => Promise<TRes> {
    return (request: TReq): Promise<TRes> => {
      return new Promise((resolve, reject) => {
        const deadline = new Date(Date.now() + config.timeoutMs);
        const meta = metadata ?? new grpc.Metadata();
        meta.set('deadline', deadline.toISOString());
        client[method](request, meta, { deadline }, (err: grpc.ServiceError | null, response: TRes) => {
          if (err) {
            reject(err);
          } else {
            resolve(response);
          }
        });
      });
    };
  }

  return {
    async runBacktest(request: BacktestRequest, traceId?: string): Promise<BacktestResponse> {
      const grpcRequest = {
        proposalId: request.proposalId,
        modifications: request.modifications.map(m => ({
          slotId: m.slotId,
          floatValue: typeof m.value === 'number' ? m.value : undefined,
          stringValue: typeof m.value === 'string' ? m.value : undefined,
        })),
        dataRange: request.dataRange,
      };

      const metadata = new grpc.Metadata();
      if (traceId) {
        metadata.set('x-trace-id', traceId);
      }
      const response = await promisify<any, any>('runBacktest', metadata)(grpcRequest);

      return {
        success: response.success,
        result: response.result,
        error: response.error,
      };
    },

    async startPaperShadow(request: PaperShadowRequest): Promise<PaperShadowResponse> {
      const grpcRequest = {
        proposalId: request.proposalId,
        modifications: request.modifications.map(m => ({
          slotId: m.slotId,
          floatValue: typeof m.value === 'number' ? m.value : undefined,
          stringValue: typeof m.value === 'string' ? m.value : undefined,
        })),
        durationDays: request.durationDays,
      };

      const response = await promisify<any, any>('startPaperShadow')(grpcRequest);

      return {
        success: response.success,
        paperTradeId: response.paperTradeId,
        error: response.error,
      };
    },

    async getPaperResults(paperTradeId: string): Promise<PaperResultsResponse> {
      const response = await promisify<any, any>('getPaperResults')({ paperTradeId });

      return {
        paperTradeId: response.paperTradeId,
        status: response.status as PaperResultsResponse['status'],
        relativePnl: response.relativePnl,
        daysElapsed: response.daysElapsed,
        sharpeRatio: response.sharpeRatio,
        recommendPromotion: response.recommendPromotion,
      };
    },

    async healthCheck(): Promise<HealthCheckResponse> {
      const response = await promisify<any, any>('healthCheck')({});

      return {
        healthy: response.healthy,
        version: response.version,
        uptimeSeconds: parseInt(response.uptimeSeconds) || 0,
        activePaperTrades: response.activePaperTrades,
      };
    },

    close(): void {
      client.close();
    },
  };
}

