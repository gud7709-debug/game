import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT || 8080);
const rooms = new Map();
const clients = new Map();

function send(ws, msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  for (const p of room.players.values()) send(p.ws, msg);
}

function lobby(room) {
  return { t: 'lobby', players: [...room.players.values()].map(p => ({ id: p.id, role: p.role })), seekerCount: room.seekerCount, maxPlayers: 6 };
}

function leave(ws) {
  const p = clients.get(ws);
  if (!p) return;
  clients.delete(ws);
  const room = rooms.get(p.room);
  if (!room) return;
  room.players.delete(p.id);
  broadcast(room, { t: 'left', id: p.id });
  if (room.host === p.id) {
    broadcast(room, { t: 'roomClosed' });
    for (const q of room.players.values()) clients.delete(q.ws);
    rooms.delete(p.room);
  } else if (!room.players.size) rooms.delete(p.room);
}

function createRoom(ws, d) {
  const code = String(d.code || '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(code) || rooms.has(code)) return send(ws, { t: 'serverError', message: 'Room code unavailable.' });
  const id = String(d.id || crypto.randomUUID());
  const room = { code, host: id, seekerCount: 1, started: false, players: new Map() };
  room.players.set(id, { id, role: 'SEEKER', ws });
  rooms.set(code, room);
  clients.set(ws, { id, room: code, ws });
  send(ws, { t: 'created', id, code });
  send(ws, lobby(room));
}

function joinRoom(ws, d) {
  const code = String(d.code || '');
  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'serverError', message: 'Room not found.' });
  if (room.players.size >= 6) return send(ws, { t: 'full' });
  const id = String(d.id || crypto.randomUUID());
  room.players.set(id, { id, role: 'HIDER', ws });
  clients.set(ws, { id, room: code, ws });
  send(ws, { t: 'joined', id, code, host: room.host });
  broadcast(room, lobby(room));
}

function startRoom(room, d) {
  if (room.started) return;
  const n = Math.max(1, Math.min(5, Number(d.seekerCount) || 1, room.players.size));
  room.seekerCount = n;
  const ids = [...room.players.keys()];
  const selected = ids.filter(id => id === room.host || room.players.get(id).role === 'SEEKER');
  for (const id of ids) if (selected.length < n && !selected.includes(id)) selected.push(id);
  const roles = {};
  for (const id of ids) roles[id] = selected.slice(0, n).includes(id) ? 'SEEKER' : 'HIDER';
  for (const [id, p] of room.players) p.role = roles[id];
  room.started = true;
  broadcast(room, { t: 'start', roles, seekerCount: n });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size })); }
  if (req.url === '/' || req.url === '/index.html') {
    try { const html = await readFile(new URL('./index.html', import.meta.url)); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html); }
    catch { res.writeHead(500); return res.end('index.html unavailable'); }
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw.toString()); } catch { return send(ws, { t: 'serverError', message: 'Invalid message.' }); }
    const current = clients.get(ws);
    if (d.t === 'create') return createRoom(ws, d);
    if (d.t === 'join') return joinRoom(ws, d);
    if (!current) return;
    const room = rooms.get(current.room); if (!room) return;
    if (d.t === 'lobbyJoin' && !room.started) { const p = room.players.get(current.id); if (p) p.role = d.role === 'SEEKER' ? 'SEEKER' : 'HIDER'; return broadcast(room, lobby(room)); }
    if (d.t === 'lobbyConfig' && current.id === room.host && !room.started) { room.seekerCount = Math.max(1, Math.min(5, Number(d.seekerCount) || 1)); return broadcast(room, lobby(room)); }
    if (d.t === 'start' && current.id === room.host) return startRoom(room, d);
    if (d.t === 'p' || d.t === 'state' || d.t === 'carry' || d.t === 'carryPos' || d.t === 'carryDrop' || d.t === 'jail' || d.t === 'captureReq' || d.t === 'jailReq') return broadcast(room, d);
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

server.listen(port, () => console.log(`Pixel Hunt server listening on :${port}`));
