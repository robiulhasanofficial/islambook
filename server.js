// server.js (presence-enabled, Node >= 14, no extra deps)
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
  "http://localhost:3000" // dev: adjust/remove for production
];
const POSTS_CACHE_MAX = 300;
const MESSAGES_CACHE_MAX = 500;
// presence settings
const PRESENCE_TTL_MS = 90 * 1000; // consider user offline if no heartbeat for 90s
const PRESENCE_CLEANUP_INTERVAL_MS = 30 * 1000; // prune every 30s
// ====================

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ["GET", "POST"]
  }
});

// in-memory caches (simple, ephemeral)
const POSTS_CACHE = [];     // recent posts, newest last
const MESSAGES_CACHE = [];  // recent messages, oldest first

function uid() {
  // simple unique id (no external deps)
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,9);
}
function nowISO(){ return new Date().toISOString(); }

function pushPostToCache(post){
  POSTS_CACHE.push(post);
  if(POSTS_CACHE.length > POSTS_CACHE_MAX) POSTS_CACHE.splice(0, POSTS_CACHE.length - POSTS_CACHE_MAX);
}
function pushMessageToCache(msg){
  MESSAGES_CACHE.push(msg);
  if(MESSAGES_CACHE.length > MESSAGES_CACHE_MAX) MESSAGES_CACHE.splice(0, MESSAGES_CACHE.length - MESSAGES_CACHE_MAX);
}

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Presence structures ----------
/*
 USERS: Map<userId, { userId, userName, sockets:Set<socketId>, lastSeen:timestamp }>
 SOCKET_TO_USER: Map<socketId, userId>
*/
const USERS = new Map();
const SOCKET_TO_USER = new Map();

function markSocketForUser(socketId, userId, userName){
  let entry = USERS.get(userId);
  const now = Date.now();
  if(!entry){
    entry = { userId, userName: userName || 'Anonymous', sockets: new Set(), lastSeen: now };
    USERS.set(userId, entry);
    // broadcast new user join (notify everyone)
    io.emit('user_join', { userId, userName: entry.userName, socketId });
  } else {
    // update username if changed
    if(userName && userName !== entry.userName) entry.userName = userName;
    // optional: emit presence_update to others so UI refreshes name/lastSeen
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
    // broadcast leave
    io.emit('user_leave', { userId, userName: entry.userName, socketId });
  } else {
    // still has other sockets — update presence_update
    io.emit('presence_update', { userId, userName: entry.userName, socketId: null });
  }
}

function getActiveUsersArray(){
  // return minimal list for clients; include lastSeen and one socketId (if any)
  return Array.from(USERS.values()).map(u => ({
    userId: u.userId,
    userName: u.userName,
    lastSeen: u.lastSeen,
    socketId: Array.from(u.sockets.values())[0] || null
  }));
}

// periodic cleanup: if any user hasn't been seen for TTL, remove and notify
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
      // remove any socket mappings for safety
      for(const [sId, uId] of SOCKET_TO_USER.entries()){
        if(uId === r.userId) SOCKET_TO_USER.delete(sId);
      }
      io.emit('user_leave', { userId: r.userId, userName: r.userName });
    }
  }
}, PRESENCE_CLEANUP_INTERVAL_MS);

// ---------- Socket handlers ----------
io.on('connection', (socket) => {
  console.log('[SOCKET] connected', socket.id);

  // client requests full posts sync
  socket.on('request_sync', () => {
    try { socket.emit('sync', POSTS_CACHE.slice()); } catch(e){ console.warn('failed sending sync', e); }
  });

  // client requests messages sync
  socket.on('request_messages', () => {
    try { socket.emit('messages_sync', MESSAGES_CACHE.slice()); } catch(e){ console.warn('failed sending messages_sync', e); }
  });

  // Presence: client announces who they are
  // payload: { userId, userName, socketId? }
  socket.on('im_here', (payload) => {
    try {
      if(!payload || !payload.userId) return;
      markSocketForUser(socket.id, payload.userId, payload.userName || payload.name);
      // optionally respond with current active list
      socket.emit('active_users', getActiveUsersArray());
    } catch(err){ console.error('[ERR] im_here', err); }
  });

  // client asks for active users list explicitly
  socket.on('request_active_users', () => {
    try { socket.emit('active_users', getActiveUsersArray()); }
    catch(e){ console.warn('failed sending active_users', e); }
  });

  // heartbeat: keep-alive from client (payload may contain userId/userName)
  socket.on('heartbeat', (payload) => {
    try {
      // if client provided userId, update mapping (useful if tab reopened)
      if(payload && payload.userId){
        markSocketForUser(socket.id, payload.userId, payload.userName || payload.name);
      } else {
        // if we know socket->userId, refresh lastSeen
        const uid = SOCKET_TO_USER.get(socket.id);
        if(uid){
          const ent = USERS.get(uid);
          if(ent) ent.lastSeen = Date.now();
        }
      }
      // acknowledge
      socket.emit('heartbeat_ack', { serverTime: nowISO() });
    } catch(e){ console.error('[ERR] heartbeat', e); }
  });

  // NEW POST (image upload)
  socket.on('new_post', (post) => {
    try {
      if(!post) return;
      if(!post.id) post.id = uid();
      if(!post.created_at) post.created_at = nowISO();
      post.likes = Array.isArray(post.likes) ? post.likes : [];
      post.comments = Array.isArray(post.comments) ? post.comments : [];

      pushPostToCache(post);
      io.emit('post', post);
      console.log('[RECV] new_post -> broadcast', post.id);
    } catch(err){
      console.error('[ERR] new_post', err);
    }
  });

  // LIKE event (from clients)
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

  // COMMENT event (from clients)
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

  // GLOBAL MESSAGE (chat)
  socket.on('message', (msg) => {
    try {
      if(!msg) return;
      if(!msg.id) msg.id = uid();
      if(!msg.created_at) msg.created_at = nowISO();
      pushMessageToCache(msg);
      io.emit('message', msg);
      console.log('[RECV] message', msg.id, 'from', msg.userId || 'unknown');
    } catch(err){ console.error('[ERR] message', err); }
  });

  // ping (existing)
  socket.on('ping_server', (data) => { socket.emit('pong_server', { serverTime: nowISO(), you: socket.id }); });

  socket.on('disconnect', (reason) => {
    try {
      console.log('[SOCKET] disconnected', socket.id, reason);
      unmarkSocket(socket.id);
    } catch(e){ console.error('[ERR] disconnect handling', e); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT} (port ${PORT})`));
