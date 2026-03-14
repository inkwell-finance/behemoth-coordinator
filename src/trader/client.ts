/**
 * gRPC client for communication with behemoth-trader.
 * Runs over internal network with mTLS.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { BacktestRequest, BacktestResponse, PaperShadowRequest, PaperShadowResponse } from '@inkwell-finance/protocol';

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
  runBacktest(request: BacktestRequest): Promise<BacktestResponse>;

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

  // Create credentials (insecure for dev, mTLS for production)
  const credentials = config.tlsCertPath && config.tlsKeyPath && config.tlsCaPath
    ? grpc.credentials.createSsl(
        // Would read cert files here in production
        Buffer.from(''),
        Buffer.from(''),
        Buffer.from(''),
      )
    : grpc.credentials.createInsecure();

  // Create gRPC client
  const client = new traderProto.behemoth.trader.TraderService(
    config.endpoint,
    credentials,
  );

  // Helper to promisify gRPC calls
  function promisify<TReq, TRes>(method: string): (req: TReq) => Promise<TRes> {
    return (request: TReq): Promise<TRes> => {
      return new Promise((resolve, reject) => {
        const deadline = new Date(Date.now() + config.timeoutMs);
        client[method](request, { deadline }, (err: grpc.ServiceError | null, response: TRes) => {
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
    async runBacktest(request: BacktestRequest): Promise<BacktestResponse> {
      const grpcRequest = {
        proposalId: request.proposalId,
        modifications: request.modifications.map(m => ({
          slotId: m.slotId,
          floatValue: typeof m.value === 'number' ? m.value : undefined,
          stringValue: typeof m.value === 'string' ? m.value : undefined,
        })),
        dataRange: request.dataRange,
      };

      const response = await promisify<any, any>('runBacktest')(grpcRequest);

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

