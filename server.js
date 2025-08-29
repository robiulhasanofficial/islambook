// server.js (presence-enabled, Node >= 14, no extra deps)
// Updated: adds private_message routing, contacts endpoint, light validation, ack, rate-limits, dedupe
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ====== CONFIG ======
const CORS_ORIGINS = [
  "https://islambook.onrender.com",
  "https://robiulhasanofficial.github.io",
  "http://localhost:3000"
];
const POSTS_CACHE_MAX = 300;
const MESSAGES_CACHE_MAX = 500;
const PRESENCE_TTL_MS = 90 * 1000;
const PRESENCE_CLEANUP_INTERVAL_MS = 30 * 1000;
// rate limit settings
const RATE_LIMIT_WINDOW = 60 * 1000; // 60s sliding window
const RATE_LIMIT_MAX_MESSAGES_PER_MIN = 80; // global messages per user per minute
const RATE_LIMIT_MAX_PRIVATE_PER_MIN = 60; // private messages per user per minute
// max text length
const MAX_TEXT_LENGTH = 2000;
// ====================

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ["GET", "POST"]
  }
});

// in-memory caches (simple, ephemeral)
const POSTS_CACHE = [];
const POSTS_BY_ID = new Map();
const MESSAGES_CACHE = [];  // recent messages, oldest first
const MESSAGES_BY_ID = new Map();

// simple rate-tracker per user
const RATE_TRACKER = new Map(); // userId -> [{ts,type}, ...] where type='global'|'private'

function uid() {
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,9);
}
function nowISO(){ return new Date().toISOString(); }

function sanitizeText(s){
  if(!s) return '';
  // remove control chars except newline/tab; trim and truncate
  let t = String(s).replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, '');
  if(t.length > MAX_TEXT_LENGTH) t = t.slice(0, MAX_TEXT_LENGTH);
  return t;
}

function pushPostToCache(post){
  if(!post || !post.id) return;
  if(POSTS_BY_ID.has(post.id)) return;
  POSTS_CACHE.push(post);
  POSTS_BY_ID.set(post.id, post);
  if(POSTS_CACHE.length > POSTS_CACHE_MAX) {
    const removeCount = POSTS_CACHE.length - POSTS_CACHE_MAX;
    for(let i=0;i<removeCount;i++){
      const removed = POSTS_CACHE.shift();
      if(removed && removed.id) POSTS_BY_ID.delete(removed.id);
    }
  }
}

function pushMessageToCache(msg){
  if(!msg || !msg.id) return;
  if(MESSAGES_BY_ID.has(msg.id)) return;
  MESSAGES_CACHE.push(msg);
  MESSAGES_BY_ID.set(msg.id, msg);
  if(MESSAGES_CACHE.length > MESSAGES_CACHE_MAX) {
    const drop = MESSAGES_CACHE.length - MESSAGES_CACHE_MAX;
    for(let i=0;i<drop;i++){
      const r = MESSAGES_CACHE.shift();
      if(r && r.id) MESSAGES_BY_ID.delete(r.id);
    }
  }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({limit: '10mb'}));

// PRESENCE
const USERS = new Map(); // userId -> { userId, userName, sockets:Set, lastSeen }
const SOCKET_TO_USER = new Map();

function markSocketForUser(socketId, userId, userName){
  let entry = USERS.get(userId);
  const now = Date.now();
  if(!entry){
    entry = { userId, userName: userName || 'Anonymous', sockets: new Set(), lastSeen: now };
    USERS.set(userId, entry);
    io.emit('user_join', { userId, userName: entry.userName, socketId });
  } else {
    if(userName && userName !== entry.userName) entry.userName = userName;
    io.emit('presence_update', { userId, userName: entry.userName, socketId });
  }
  entry.sockets.add(socketId);
  entry.lastSeen = now;
  SOCKET_TO_USER.set(socketId, userId);
}

function unmarkSocket(socketId){
  const userId = SOCKET_TO_USER.get(socketId);
  if(!userId) return;
  SOCKET_TO_USER.delete(socketId);
  const entry = USERS.get(userId);
  if(!entry) return;
  entry.sockets.delete(socketId);
  entry.lastSeen = Date.now();
  if(entry.sockets.size === 0){
    USERS.delete(userId);
    io.emit('user_leave', { userId, userName: entry.userName, socketId });
  } else {
    io.emit('presence_update', { userId, userName: entry.userName, socketId: null });
  }
}

function getActiveUsersArray(){
  return Array.from(USERS.values()).map(u => ({
    userId: u.userId,
    userName: u.userName,
    lastSeen: u.lastSeen,
    socketId: Array.from(u.sockets.values())[0] || null
  }));
}

// cleanup stale presence
setInterval(() => {
  const now = Date.now();
  const toRemove = [];
  for(const [userId, entry] of USERS.entries()){
    if((now - (entry.lastSeen || 0)) > PRESENCE_TTL_MS){
      toRemove.push({ userId, userName: entry.userName });
    }
  }
  if(toRemove.length){
    for(const r of toRemove){
      USERS.delete(r.userId);
      for(const [sId, uId] of SOCKET_TO_USER.entries()){
        if(uId === r.userId) SOCKET_TO_USER.delete(sId);
      }
      io.emit('user_leave', { userId: r.userId, userName: r.userName });
    }
  }
}, PRESENCE_CLEANUP_INTERVAL_MS);

// rate-limit helpers
function pruneRate(userId){
  const now = Date.now();
  const arr = RATE_TRACKER.get(userId) || [];
  const filtered = arr.filter(x => (now - x.ts) <= RATE_LIMIT_WINDOW);
  RATE_TRACKER.set(userId, filtered);
  return filtered;
}
function allowRate(userId, type, max){
  if(!userId) return false;
  const arr = pruneRate(userId);
  const countOfType = arr.filter(x => x.type === type).length;
  if(countOfType >= max) return false;
  arr.push({ ts: Date.now(), type });
  RATE_TRACKER.set(userId, arr);
  return true;
}

// Socket handlers
io.on('connection', (socket) => {
  console.log('[SOCKET] connected', socket.id);

  socket.on('request_sync', () => {
    try { socket.emit('sync', POSTS_CACHE.slice()); } catch(e){ console.warn('failed sending sync', e); }
  });

  socket.on('request_messages', () => {
    try { socket.emit('messages_sync', MESSAGES_CACHE.slice()); } catch(e){ console.warn('failed sending messages_sync', e); }
  });

  socket.on('im_here', (payload) => {
    try {
      if(!payload || !payload.userId) return;
      markSocketForUser(socket.id, payload.userId, payload.userName || payload.name);
      socket.emit('active_users', getActiveUsersArray());

      // ask all clients to announce posts so server can reconcile
      for(const s of io.sockets.sockets.values()){
        try { s.emit('please_announce_posts'); } catch(e){}
      }
    } catch(err){ console.error('[ERR] im_here', err); }
  });

  socket.on('request_active_users', () => {
    try { socket.emit('active_users', getActiveUsersArray()); }
    catch(e){ console.warn('failed sending active_users', e); }
  });

  socket.on('heartbeat', (payload) => {
    try {
      if(payload && payload.userId){
        markSocketForUser(socket.id, payload.userId, payload.userName || payload.name);
      } else {
        const uid = SOCKET_TO_USER.get(socket.id);
        if(uid){
          const ent = USERS.get(uid);
          if(ent) ent.lastSeen = Date.now();
        }
      }
      socket.emit('heartbeat_ack', { serverTime: nowISO() });
    } catch(e){ console.error('[ERR] heartbeat', e); }
  });

  socket.on('upload_full_post', (post) => {
    try {
      if(!post) return;
      if(!post.id) post.id = uid();
      if(!post.created_at) post.created_at = nowISO();
      post.likes = Array.isArray(post.likes) ? post.likes : [];
      post.comments = Array.isArray(post.comments) ? post.comments : [];
      pushPostToCache(post);
      io.emit('post', post);
      console.log('[RECV] upload_full_post -> broadcast', post.id);
    } catch(err){ console.error('[ERR] upload_full_post', err); }
  });

  socket.on('announce_posts', (list) => {
    try {
      if(!Array.isArray(list)) return;
      const missingOnServer = [];
      const clientIds = new Set();
      for(const item of list){
        if(!item || !item.id) continue;
        clientIds.add(item.id);
        if(!POSTS_BY_ID.has(item.id)) missingOnServer.push(item.id);
      }
      if(missingOnServer.length) socket.emit('request_upload_posts', missingOnServer);
      const needOnClient = POSTS_CACHE.filter(p => !clientIds.has(p.id)).map(p => p.id);
      if(needOnClient.length) socket.emit('sync_needed', needOnClient);
    } catch(e){ console.error('[ERR] announce_posts', e); }
  });

  socket.on('request_posts_by_id', (ids) => {
    try{
      if(!Array.isArray(ids)) return;
      const found = ids.map(id => POSTS_BY_ID.get(id)).filter(Boolean);
      if(found.length) socket.emit('bulk_posts', found);
    } catch(e){ console.error('[ERR] request_posts_by_id', e); }
  });

  socket.on('like', (payload) => {
    try {
      if(!payload || !payload.postId) return;
      const p = POSTS_CACHE.find(x => x.id === payload.postId);
      if(p){
        p.likes = p.likes || [];
        if(payload.action === 'like'){
          if(!p.likes.find(l => l.id === payload.likeId || l.userId === payload.userId)){
            p.likes.push({ id: payload.likeId || uid(), userId: payload.userId, userName: payload.userName || null, created_at: payload.created_at || nowISO() });
          }
        } else {
          p.likes = p.likes.filter(l => l.id !== payload.likeId && l.userId !== payload.userId);
        }
      }
      io.emit('like', payload);
    } catch(e) { console.error('[ERR] like', e); }
  });

  socket.on('comment', (payload) => {
    try {
      if(!payload || !payload.postId || !payload.comment) return;
      const comment = payload.comment;
      if(!comment.id) comment.id = uid();
      if(!comment.created_at) comment.created_at = nowISO();
      const p = POSTS_CACHE.find(x => x.id === payload.postId);
      if(p){
        p.comments = p.comments || [];
        p.comments.unshift(comment);
      }
      io.emit('comment', { postId: payload.postId, comment });
    } catch(e){ console.error('[ERR] comment', e); }
  });

  socket.on('message', (msg, ack) => {
    try {
      if(!msg || typeof msg !== 'object') {
        if(typeof ack === 'function') ack({ ok:false, error: 'INVALID_MESSAGE' });
        return;
      }
      const senderId = msg.userId || SOCKET_TO_USER.get(socket.id) || null;
      if(!senderId){
        if(typeof ack === 'function') ack({ ok:false, error: 'UNKNOWN_SENDER' });
        return;
      }
      // rate-limit global messages
      if(!allowRate(senderId, 'global', RATE_LIMIT_MAX_MESSAGES_PER_MIN)){
        if(typeof ack === 'function') ack({ ok:false, error: 'RATE_LIMIT' });
        return;
      }

      msg.id = msg.id || uid();
      msg.created_at = msg.created_at || nowISO();
      msg.userId = senderId;
      msg.userName = sanitizeText(msg.userName || msg.name || '');
      msg.text = sanitizeText(msg.text || '');

      pushMessageToCache(msg);
      io.emit('message', msg);
      if(typeof ack === 'function') ack({ ok:true, id: msg.id });
      console.log('[RECV] message', msg.id, 'from', msg.userId);
    } catch(err){ console.error('[ERR] message', err); if(typeof ack === 'function') ack({ ok:false, error: 'ERR' }); }
  });

  // Private message routing with validation, rate-limit, ack
  socket.on('private_message', (msg, ack) => {
    try {
      if(!msg || typeof msg !== 'object'){
        if(typeof ack === 'function') ack({ ok:false, error:'INVALID_PAYLOAD' });
        return;
      }

      // basic fields validation
      if(!msg.fromId || !msg.toId || typeof msg.text !== 'string' || msg.text.trim().length === 0){
        if(typeof ack === 'function') ack({ ok:false, error:'INVALID_PRIVATE_MESSAGE' });
        return;
      }

      // Validate that the socket is actually the claimed fromId
      const mapped = SOCKET_TO_USER.get(socket.id);
      if(!mapped || mapped !== msg.fromId){
        // mismatch => reject (security)
        console.warn('[SEC] private_message fromId mismatch', { socketId: socket.id, mapped, claimed: msg.fromId });
        if(typeof ack === 'function') ack({ ok:false, error:'FROM_ID_MISMATCH' });
        return;
      }

      // rate-limit per-user private messages
      if(!allowRate(msg.fromId, 'private', RATE_LIMIT_MAX_PRIVATE_PER_MIN)){
        if(typeof ack === 'function') ack({ ok:false, error:'RATE_LIMIT_PRIVATE' });
        return;
      }

      msg.id = msg.id || uid();
      msg.created_at = msg.created_at || nowISO();
      msg.text = sanitizeText(msg.text);
      msg.fromName = sanitizeText(msg.fromName || msg.userName || '');

      // push server cache (server retains private messages in cache too)
      pushMessageToCache(msg);

      // deliver to recipient sockets only (not broadcast)
      const recipient = USERS.get(msg.toId);
      if(recipient && recipient.sockets && recipient.sockets.size){
        for(const sId of recipient.sockets){
          io.to(sId).emit('private_message', msg);
        }
      }

      // also send an echo to all sender sockets (so sender sees delivered copy)
      const senderEntry = USERS.get(msg.fromId);
      if(senderEntry && senderEntry.sockets && senderEntry.sockets.size){
        for(const sId of senderEntry.sockets){
          io.to(sId).emit('private_message', msg);
        }
      } else {
        // fallback: emit back to origin socket
        socket.emit('private_message', msg);
      }

      if(typeof ack === 'function') ack({ ok:true, id: msg.id, deliveredTo: recipient? Array.from(recipient.sockets) : [] });
      console.log('[RECV] private_message', msg.id, 'from', msg.fromId, 'to', msg.toId);
    } catch(err){
      console.error('[ERR] private_message', err);
      if(typeof ack === 'function') ack({ ok:false, error:'ERR' });
    }
  });

  socket.on('request_contacts', () => {
    try {
      socket.emit('contacts', getActiveUsersArray());
    } catch(e){ console.warn('failed sending contacts', e); }
  });

  socket.on('ping_server', (data) => { socket.emit('pong_server', { serverTime: nowISO(), you: socket.id }); });

  socket.on('disconnect', (reason) => {
    try {
      console.log('[SOCKET] disconnected', socket.id, reason);
      unmarkSocket(socket.id);
    } catch(e){ console.error('[ERR] disconnect handling', e); }
  });
});

// Optional HTTP helpers
app.get('/posts', (req, res) => {
  res.json({ posts: POSTS_CACHE.slice() });
});
app.get('/messages', (req, res) => {
  res.json({ messages: MESSAGES_CACHE.slice() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT} (port ${PORT})`));
