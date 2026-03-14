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
import { P2PBridge, P2PBridgeConfig, P2P_TOPICS } from './bridge';

type MessageHandler = (message: unknown, peerId: string) => void;

/**
 * Create a real libp2p-based P2P bridge for the coordinator.
 */
export async function createP2PBridge(config: P2PBridgeConfig): Promise<P2PBridge & { peerId: string; getMultiaddrs(): string[] }> {
  const subscriptions = new Map<string, MessageHandler[]>();
  
  // Create libp2p node with full stack
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const node: any = await createLibp2p({
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

  // Set up message handler for pubsub
  pubsub.addEventListener('message', (evt: { detail: { topic: string; data: Uint8Array; from?: { toString(): string } } }) => {
    const topic = evt.detail.topic;
    const handlers = subscriptions.get(topic);
    if (handlers && handlers.length > 0) {
      try {
        const data = JSON.parse(new TextDecoder().decode(evt.detail.data));
        const fromPeer = evt.detail.from?.toString() ?? 'unknown';
        for (const handler of handlers) {
          handler(data, fromPeer);
        }
      } catch (e) {
        console.error('[P2P] Failed to parse pubsub message:', e);
      }
    }
  });

  return {
    peerId,

    async start(): Promise<void> {
      console.log(`[P2P] Coordinator starting with peer ID: ${peerId}`);
      console.log(`[P2P] Listen addresses:`, config.listenAddresses);
      
      await node.start();
      
      const addrs = node.getMultiaddrs();
      console.log(`[P2P] Listening on:`, addrs.map((a: { toString(): string }) => a.toString()));

      // Connect to bootstrap peers
      if (config.bootstrapPeers.length > 0) {
        console.log(`[P2P] Connecting to bootstrap peers:`, config.bootstrapPeers);
        for (const peerAddr of config.bootstrapPeers) {
          try {
            const ma = multiaddr(peerAddr);
            await node.dial(ma);
            console.log(`[P2P] Connected to: ${peerAddr}`);
          } catch (e) {
            console.warn(`[P2P] Failed to connect to ${peerAddr}:`, e);
          }
        }
      }

      // Subscribe to all topics
      for (const topic of Object.values(P2P_TOPICS)) {
        pubsub.subscribe(topic);
        console.log(`[P2P] Subscribed to: ${topic}`);
      }
    },

    async stop(): Promise<void> {
      console.log(`[P2P] Coordinator stopping...`);
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
      const data = new TextEncoder().encode(JSON.stringify(message));
      await pubsub.publish(topic, data);
    },

    getPeers(): string[] {
      return node.getConnections().map((conn: { remotePeer: { toString(): string } }) => 
        conn.remotePeer.toString()
      );
    },

    async sendDirect(targetPeerId: string, message: unknown): Promise<void> {
      // For now, use pubsub broadcast - direct messaging requires protocol stream
      console.log(`[P2P] Sending to ${targetPeerId}:`, message);
      // In production, this would use a custom protocol stream
    },

    getMultiaddrs(): string[] {
      return node.getMultiaddrs().map((ma: { toString(): string }) => ma.toString());
    },
  };
}

