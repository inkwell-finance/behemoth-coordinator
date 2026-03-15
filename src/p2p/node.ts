/**
 * Real libp2p node implementation for the coordinator.
 */

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { P2PBridge, P2PBridgeConfig, P2P_TOPICS } from './bridge';
import { loadP2PSigningKey, verifyP2PSignature } from './signing';
import logger from '../shared/logger.js';
import { getRedisClient } from '../shared/redis.js';
import { failedBroadcastsTotal } from '../metrics.js';

const DIRECT_PROTOCOL = '/behemoth/direct/1.0.0';
const DIRECT_SEND_TIMEOUT_MS = 5000;
const DIRECT_SEND_MAX_ATTEMPTS = 3;
const MAX_MESSAGE_BYTES = 1_048_576; // 1 MB

type MessageHandler = (message: unknown, peerId: string) => void;

/**
 * Signed message envelope wrapping any outgoing P2P payload.
 */
interface SignedEnvelope {
  payload: unknown;
  senderPubkey: string;
  signature: string;
}

/**
 * Create a real libp2p-based P2P bridge for the coordinator.
 */
export async function createP2PBridge(config: P2PBridgeConfig): Promise<P2PBridge & { peerId: string; getMultiaddrs(): string[] }> {
  const subscriptions = new Map<string, MessageHandler[]>();
  const signingKey = loadP2PSigningKey();

  // Derive the libp2p Ed25519 identity from the COORDINATOR_KEYPAIR seed so
  // that the peerId is deterministically bound to the on-chain Solana public key.
  let libp2pPrivateKey: Awaited<ReturnType<typeof generateKeyPairFromSeed>> | undefined;
  const keypairEnv = process.env.COORDINATOR_KEYPAIR;
  if (keypairEnv) {
    try {
      const raw = JSON.parse(keypairEnv) as number[];
      const bytes = new Uint8Array(raw);
      if (bytes.length !== 64) throw new Error(`Expected 64 bytes, got ${bytes.length}`);
      const seed = bytes.slice(0, 32);
      libp2pPrivateKey = await generateKeyPairFromSeed('Ed25519', seed);
      logger.info({ solanaPublicKey: signingKey.publicKeyBase58 }, 'Derived libp2p identity from COORDINATOR_KEYPAIR seed');
    } catch (err) {
      logger.warn({ err }, 'Failed to derive libp2p key from COORDINATOR_KEYPAIR, using random identity');
    }
  } else {
    logger.warn('No COORDINATOR_KEYPAIR env var — libp2p will use a random ephemeral identity');
  }

  // Create libp2p node with full stack
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const node: any = await createLibp2p({
    privateKey: libp2pPrivateKey,
    addresses: {
      listen: config.listenAddresses,
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      // Cast to any to avoid version mismatch between libp2p and @libp2p/interface
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: false,
        fallbackToFloodsub: true,
      }) as any,
      dht: kadDHT({
        clientMode: false,
      }),
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pubsub: any = node.services.pubsub;
  const peerId = node.peerId.toString();

  /**
   * Verify a received signed envelope and extract the inner payload.
   * Returns null if the message should be rejected.
   */
  function verifyEnvelope(raw: unknown, fromPeer: string): unknown | null {
    const env = raw as Partial<SignedEnvelope>;
    if (
      typeof env.senderPubkey !== 'string' ||
      typeof env.signature !== 'string' ||
      env.payload === undefined
    ) {
      logger.warn({ fromPeer }, 'Rejected unsigned/malformed message');
      return null;
    }
    const payloadJson = JSON.stringify(env.payload);
    if (!verifyP2PSignature(env.senderPubkey, payloadJson, env.signature)) {
      logger.warn({ fromPeer, senderPubkey: env.senderPubkey }, 'Rejected message with invalid signature');
      return null;
    }
    return env.payload;
  }

  // Set up message handler for pubsub
  pubsub.addEventListener('message', (evt: { detail: { topic: string; data: Uint8Array; from?: { toString(): string } } }) => {
    const topic = evt.detail.topic;
    const handlers = subscriptions.get(topic);
    if (handlers && handlers.length > 0) {
      try {
        const rawBytes = evt.detail.data;

        // Size limit check
        if (rawBytes.length > MAX_MESSAGE_BYTES) {
          logger.warn({ topic, bytes: rawBytes.length }, 'Rejected oversized pubsub message');
          return;
        }

        const fromPeer = evt.detail.from?.toString() ?? 'unknown';
        const raw = JSON.parse(new TextDecoder().decode(rawBytes));
        const payload = verifyEnvelope(raw, fromPeer);
        if (payload === null) return;

        for (const handler of handlers) {
          handler(payload, fromPeer);
        }
      } catch (e) {
        logger.error({ err: e }, 'Failed to parse pubsub message');
      }
    }
  });

  // Register direct messaging protocol handler for incoming streams
  node.handle(DIRECT_PROTOCOL, async ({ stream, connection }: { stream: any; connection: any }) => {
    const fromPeer = connection.remotePeer.toString();
    try {
      const chunks: Uint8Array[] = [];
      let totalLength = 0;
      for await (const chunk of stream.source) {
        const c = chunk instanceof Uint8Array ? chunk : chunk.subarray();
        totalLength += c.length;
        if (totalLength > MAX_MESSAGE_BYTES) {
          logger.warn({ fromPeer, bytes: totalLength }, 'Rejected oversized direct message');
          return;
        }
        chunks.push(c);
      }
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      const message = JSON.parse(new TextDecoder().decode(combined));
      const topic = message?.topic as string | undefined;
      if (topic) {
        const handlers = subscriptions.get(topic);
        if (handlers && handlers.length > 0) {
          const payload = verifyEnvelope(message.data, fromPeer);
          if (payload === null) return;
          for (const handler of handlers) {
            handler(payload, fromPeer);
          }
        }
      }
      logger.info({ fromPeer }, 'Received direct message');
    } catch (e) {
      logger.error({ err: e, fromPeer }, 'Failed to handle direct message');
    } finally {
      await stream.close().catch(() => {});
    }
  });

  return {
    peerId,

    async start(): Promise<void> {
      logger.info({ peerId, listenAddresses: config.listenAddresses }, 'Coordinator P2P starting');

      await node.start();

      const addrs = node.getMultiaddrs();
      logger.info({ addrs: addrs.map((a: { toString(): string }) => a.toString()) }, 'P2P listening on addresses');

      // Connect to bootstrap peers
      if (config.bootstrapPeers.length > 0) {
        logger.info({ bootstrapPeers: config.bootstrapPeers }, 'Connecting to bootstrap peers');
        for (const peerAddr of config.bootstrapPeers) {
          try {
            const ma = multiaddr(peerAddr);
            await node.dial(ma);
            logger.info({ peerAddr }, 'Connected to bootstrap peer');
          } catch (e) {
            logger.warn({ err: e, peerAddr }, 'Failed to connect to bootstrap peer');
          }
        }
      }

      // Subscribe to all topics
      for (const topic of Object.values(P2P_TOPICS)) {
        pubsub.subscribe(topic);
        logger.info({ topic }, 'P2P subscribed to topic');
      }
    },

    async stop(): Promise<void> {
      logger.info('Coordinator P2P stopping');
      await node.stop();
    },

    subscribe(topic: string, handler: MessageHandler): void {
      const handlers = subscriptions.get(topic) || [];
      handlers.push(handler);
      subscriptions.set(topic, handlers);

      if (!pubsub.getTopics().includes(topic)) {
        pubsub.subscribe(topic);
      }
    },

    async publish(topic: string, message: unknown): Promise<void> {
      const payloadJson = JSON.stringify(message);
      const envelope: SignedEnvelope = {
        payload: message,
        senderPubkey: signingKey.publicKeyBase58,
        signature: signingKey.sign(payloadJson),
      };
      const data = new TextEncoder().encode(JSON.stringify(envelope));
      await pubsub.publish(topic, data);
    },

    getPeers(): string[] {
      return node.getConnections().map((conn: { remotePeer: { toString(): string } }) =>
        conn.remotePeer.toString()
      );
    },

    async sendDirect(targetPeerId: string, message: unknown): Promise<void> {
      const payloadJson = JSON.stringify(message);
      const envelope: SignedEnvelope = {
        payload: message,
        senderPubkey: signingKey.publicKeyBase58,
        signature: signingKey.sign(payloadJson),
      };
      const payload = new TextEncoder().encode(JSON.stringify(envelope));

      let lastError: unknown;
      for (let attempt = 1; attempt <= DIRECT_SEND_MAX_ATTEMPTS; attempt++) {
        try {
          const timeoutSignal = AbortSignal.timeout(DIRECT_SEND_TIMEOUT_MS);
          const stream = await node.dialProtocol(multiaddr(`/p2p/${targetPeerId}`), DIRECT_PROTOCOL, { signal: timeoutSignal });
          await stream.sink([payload]);
          await stream.close();
          logger.info({ targetPeerId, attempt }, 'Direct message sent');
          return;
        } catch (e) {
          lastError = e;
          logger.warn({ err: e, targetPeerId, attempt, maxAttempts: DIRECT_SEND_MAX_ATTEMPTS }, 'Direct send attempt failed');
        }
      }

      // All direct attempts failed — fall back to pubsub broadcast
      logger.warn({ targetPeerId, maxAttempts: DIRECT_SEND_MAX_ATTEMPTS }, 'Direct send failed, falling back to pubsub');
      try {
        const data = new TextEncoder().encode(JSON.stringify(envelope));
        await pubsub.publish(P2P_TOPICS.ANNOUNCEMENTS, data);
      } catch (fallbackError) {
        logger.error({ err: fallbackError, targetPeerId }, 'Pubsub fallback also failed');
        failedBroadcastsTotal.inc();
        const proposalId = (message as Record<string, unknown>)?.proposalId as string | undefined;
        try {
          const redis = getRedisClient();
          await redis.rpush('coordinator:failed_broadcasts', JSON.stringify({
            proposalId, timestamp: Date.now(), error: (fallbackError as Error).message,
          }));
          await redis.expire('coordinator:failed_broadcasts', 7 * 24 * 3600);
        } catch (redisErr) {
          logger.error({ err: redisErr }, 'Failed to persist failed broadcast to Redis');
        }
        throw lastError;
      }
    },

    getMultiaddrs(): string[] {
      return node.getMultiaddrs().map((ma: { toString(): string }) => ma.toString());
    },
  };
}
