#!/usr/bin/env node
/**
 * Sovereign Mesh · Relay Server
 * Pure signaling relay — no message storage, no trust, no auth.
 * Nodes register their DID, relay routes by `to` field or broadcasts.
 *
 * Protocol:
 *   Client → Server:  { type, did?, to?, broadcast?, ...payload }
 *   Server → Client:  { type, from?, ...payload }
 *
 * Message types (client → server):
 *   REGISTER       { did, pubHex, handle }           — claim identity
 *   ANNOUNCE       { broadcast:true }                — re-broadcast presence
 *   MSG_ENVELOPE   { to, envelope, correlationId }   — route to peer
 *   KEY_OFFER      { to, keyB64 }                    — key exchange
 *   KEY_ACCEPT     { to, keyB64 }                    — key exchange ack
 *   WTC_OFFER      { to, sdp }                       — WebRTC offer
 *   WTC_ANSWER     { to, sdp }                       — WebRTC answer
 *   WTC_ICE        { to, candidate }                 — ICE candidate
 *
 * Message types (server → client):
 *   PEER_LIST      { peers: [{did,pubHex,handle}] }  — full mesh snapshot
 *   PEER_JOIN      { did, pubHex, handle }            — new peer arrived
 *   PEER_LEAVE     { did }                            — peer disconnected
 *   + all routed client messages, with `from` stamped by server
 */

const http  = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8765;

// did → { ws, did, pubHex, handle, connectedAt }
const peers = new Map();

// ─── HTTP server (health + CORS for browser WS upgrade) ──────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, peers: peers.size, ts: Date.now() }));
  } else if (req.url === '/peers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ peers: peerList() }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Sovereign Mesh Relay · ws://localhost:' + PORT);
  }
});

const wss = new WebSocketServer({ server });

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(msg, excludeDID = null) {
  for (const [did, peer] of peers) {
    if (did !== excludeDID) send(peer.ws, msg);
  }
}

function routeTo(toDID, msg) {
  const peer = peers.get(toDID);
  if (peer) send(peer.ws, msg);
  else console.warn(`[relay] route miss → ${toDID.slice(0,20)}…`);
}

function peerList() {
  return [...peers.values()].map(p => ({
    did: p.did,
    pubHex: p.pubHex,
    handle: p.handle,
    connectedAt: p.connectedAt
  }));
}

function stamp(msg, fromDID) {
  const { ws: _ws, ...clean } = msg; // strip internal fields
  return { ...clean, from: fromDID, relayedAt: Date.now() };
}

// ─── CONNECTION HANDLER ───────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  let myDID = null;
  console.log(`[relay] connect  ${ip}`);

  // Keepalive ping
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(ping);
  }, 25000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── REGISTER ────────────────────────────────────────────────────────────
    if (msg.type === 'REGISTER') {
      if (!msg.did || !msg.pubHex) return;

      // Evict stale entry for same DID if any
      if (peers.has(msg.did)) {
        const old = peers.get(msg.did);
        if (old.ws !== ws) old.ws.terminate();
      }

      myDID = msg.did;
      peers.set(myDID, { ws, did: myDID, pubHex: msg.pubHex, handle: msg.handle || 'Peer·'+myDID.slice(-4), connectedAt: Date.now() });

      console.log(`[relay] register ${myDID.slice(0,28)}… (${peers.size} peers)`);

      // Send full peer list to new joiner
      send(ws, { type: 'PEER_LIST', peers: peerList().filter(p => p.did !== myDID) });

      // Notify existing peers
      broadcast({ type: 'PEER_JOIN', did: myDID, pubHex: msg.pubHex, handle: msg.handle || 'Peer·'+myDID.slice(-4) }, myDID);
      return;
    }

    // Must be registered for everything below
    if (!myDID) return;

    // ── ROUTED (targeted) ────────────────────────────────────────────────────
    const ROUTED = ['MSG_ENVELOPE','KEY_OFFER','KEY_ACCEPT','WTC_OFFER','WTC_ANSWER','WTC_ICE'];
    if (ROUTED.includes(msg.type) && msg.to) {
      routeTo(msg.to, stamp(msg, myDID));
      return;
    }

    // ── BROADCAST (announce, etc.) ───────────────────────────────────────────
    if (msg.broadcast || msg.type === 'ANNOUNCE') {
      broadcast(stamp(msg, myDID), myDID);
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(ping);
    if (myDID) {
      peers.delete(myDID);
      broadcast({ type: 'PEER_LEAVE', did: myDID });
      console.log(`[relay] leave    ${myDID.slice(0,28)}… (${peers.size} peers)`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[relay] error    ${ip}:`, err.message);
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  Sovereign Mesh · Relay Server               ║
║  ws://localhost:${PORT}                        ║
║  http://localhost:${PORT}/health               ║
║  http://localhost:${PORT}/peers                ║
╚══════════════════════════════════════════════╝
`);
});
