#!/usr/bin/env node
/**
 * Sovereign Mesh · libp2p Relay
 *
 * Single server that does everything:
 *   - Circuit Relay v2  → lets browsers behind NAT dial each other
 *   - GossipSub         → relays peer discovery + chat messages
 *   - WebSocket transport → only transport browsers can use to reach a server
 *
 * Browsers connect here via WS, then negotiate direct WebRTC P2P.
 * Once WebRTC is up the relay carries zero message bytes.
 *
 * Usage:
 *   npm install
 *   node mesh-relay.js
 *
 * Then open sovereign-mesh-talk.html in two browsers on different machines,
 * enter  ws://<this-machine-ip>:8765  and connect.
 */

import { createLibp2p }         from 'libp2p'
import { webSockets }           from '@libp2p/websockets'
import { noise }                from '@chainsafe/libp2p-noise'
import { yamux }                from '@chainsafe/libp2p-yamux'
import { identify }             from '@libp2p/identify'
import { circuitRelayServer }   from '@libp2p/circuit-relay-v2'
import { gossipsub }            from '@chainsafe/libp2p-gossipsub'
import { pubsubPeerDiscovery }  from '@libp2p/pubsub-peer-discovery'
import * as filters             from '@libp2p/websockets/filters'

const PORT = parseInt(process.env.PORT || '8765', 10)
const HOST = process.env.HOST || '0.0.0.0'

const node = await createLibp2p({
  addresses: {
    listen: [`/ip4/${HOST}/tcp/${PORT}/ws`],
  },
  transports: [
    webSockets({ filter: filters.all })   // allow ws:// (not just wss://)
  ],
  connectionEncrypters: [noise()],
  streamMuxers:         [yamux()],
  services: {
    identify: identify(),

    // Circuit Relay v2 — lets browsers use this node as a hop point
    relay: circuitRelayServer({
      reservations: {
        maxReservations: 256,
        reservationTtl: 2 * 60 * 60 * 1000,   // 2 h
      },
    }),

    // GossipSub — relays pubsub messages between browsers
    pubsub: gossipsub({
      allowPublishToZeroTopicPeers: true,
      emitSelf: false,
    }),
  },

  // Peer discovery via the same pubsub (browsers announce themselves here)
  peerDiscovery: [
    pubsubPeerDiscovery({
      interval: 10_000,
      topics: ['sovereign-mesh._peer-discovery._p2p._pubsub'],
    }),
  ],
})

await node.start()

console.log(`
╔════════════════════════════════════════════════════╗
║  Sovereign Mesh · libp2p Relay                     ║
╠════════════════════════════════════════════════════╣`)

for (const addr of node.getMultiaddrs()) {
  console.log(`║  ${addr.toString().padEnd(50)} ║`)
}

console.log(`╠════════════════════════════════════════════════════╣
║  Peer ID: ${node.peerId.toString().padEnd(41)} ║
╠════════════════════════════════════════════════════╣
║  Services: Circuit Relay v2 · GossipSub · Identify ║
║  Browsers: ws://<your-ip>:${PORT}                      ║
╚════════════════════════════════════════════════════╝
`)

// Log peer connects/disconnects
node.addEventListener('peer:connect',    e => console.log(`[+] peer connected    ${e.detail.toString()}`))
node.addEventListener('peer:disconnect', e => console.log(`[-] peer disconnected ${e.detail.toString()}`))

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n[relay] shutting down…')
    await node.stop()
    process.exit(0)
  })
}
