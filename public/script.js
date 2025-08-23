// server.js (updated, Node >= 14)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ========== CONFIG ==========
const DEFAULT_PORT = process.env.PORT || 3000;
const CORS_ORIGINS_ENV = process.env.CORS_ORIGINS || ""; // comma separated allowed origins
const CORS_ORIGINS = CORS_ORIGINS_ENV
  ? CORS_ORIGINS_ENV.split(',').map(s => s.trim()).filter(Boolean)
  : [
    "https://islambook.onrender.com",
    "https://robiulhasanofficial.github.io",
    "http://localhost:3000"
  ];

const POSTS_CACHE_MAX = parseInt(process.env.POSTS_CACHE_MAX, 10) || 300;
const MESSAGES_CACHE_MAX = parseInt(process.env.MESSAGES_CACHE_MAX, 10) || 500;
// ============================

// helper: check allowed origin (allow no-origin requests e.g. curl/file://)
function originAllowed(origin) {
  if (!origin) return true; // allow same-origin / non-browser clients
  return CORS_ORIGINS.indexOf(origin) !== -1;
}

// socket.io server with dynamic origin check
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (originAllowed(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed by CORS'));
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  // allow both transports (client requested websocket + polling)
  allowEIO3: false
});

// simple in-memory caches
const POSTS_CACHE = [];     // newest last
const MESSAGES_CACHE = [];  // oldest first

// presence: map userId -> { userId, userName, lastSeen, sockets: Set(socketId) }
const ACTIVE_USERS = new Map();
// socketId -> userId mapping to cleanup on disconnect
const SOCKET_TO_USER = new Map();

function uid() {
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

function broadcastPresenceUpdate(){
  // create a lightweight array snapshot
  const snapshot = Array.from(ACTIVE_USERS.values()).map(u => ({
    userId: u.userId,
    userName: u.userName,
    lastSeen: u.lastSeen,
    sockets: u.sockets ? Array.from(u.sockets).slice(0,3) : []
  }));
  io.emit('presence:update', snapshot);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS preflight for express routes (static files too)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (originAllowed(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// serve static client from ./public
app.use(express.static(path.join(__dirname, 'public')));

// ===== socket handling =====
io.on('connection', (socket) => {
  console.log('[SOCKET] connected', socket.id);

  // handle presence join from client
  socket.on('presence:join', (payload) => {
    try {
      if (!payload || !payload.userId) {
        console.warn('[presence] join missing payload', payload);
        return;
      }
      const { userId, userName } = payload;
      SOCKET_TO_USER.set(socket.id, userId);

      let entry = ACTIVE_USERS.get(userId);
      if (!entry) {
        entry = { userId, userName: userName || 'Anonymous', lastSeen: nowISO(), sockets: new Set() };
        ACTIVE_USERS.set(userId, entry);
      }
      entry.userName = userName || entry.userName;
      entry.lastSeen = nowISO();
      entry.sockets.add(socket.id);

      // broadcast join
      io.emit('presence:join', { userId: entry.userId, userName: entry.userName, ts: entry.lastSeen });
      broadcastPresenceUpdate();
    } catch (err) {
      console.error('[ERR] presence:join', err);
    }
  });

  socket.on('presence:leave', (payload) => {
    try {
      const userId = payload && (payload.userId || SOCKET_TO_USER.get(socket.id));
      if (!userId) return;
      const entry = ACTIVE_USERS.get(userId);
      if (entry) {
        entry.sockets.delete(socket.id);
        if (entry.sockets.size === 0) {
          ACTIVE_USERS.delete(userId);
          io.emit('presence:leave', { userId });
        } else {
          entry.lastSeen = nowISO();
        }
      }
      SOCKET_TO_USER.delete(socket.id);
      broadcastPresenceUpdate();
    } catch (err) { console.error('[ERR] presence:leave', err); }
  });

  socket.on('presence:back', (payload) => {
    try {
      const userId = payload && payload.userId;
      if (!userId) return;
      const entry = ACTIVE_USERS.get(userId);
      if (entry) {
        entry.lastSeen = nowISO();
      } else {
        // if client didn't explicitly join, create lightweight entry
        ACTIVE_USERS.set(userId, { userId, userName: (payload.userName||'Anonymous'), lastSeen: nowISO(), sockets: new Set([socket.id]) });
      }
      SOCKET_TO_USER.set(socket.id, userId);
      broadcastPresenceUpdate();
    } catch(e){ console.error(e); }
  });

  socket.on('presence:heartbeat', (payload) => {
    try {
      const userId = payload && (payload.userId || SOCKET_TO_USER.get(socket.id));
      if (!userId) return;
      const entry = ACTIVE_USERS.get(userId);
      if (entry) entry.lastSeen = nowISO();
      broadcastPresenceUpdate();
    } catch(e){ /* ignore */ }
  });

  socket.on('presence:request', () => {
    try {
      // send compact active users snapshot
      const snapshot = Array.from(ACTIVE_USERS.values()).map(u => ({ userId: u.userId, userName: u.userName, lastSeen: u.lastSeen }));
      socket.emit('activeUsers', snapshot);
    } catch(e){ console.error('[ERR] presence:request', e); }
  });

  // client requests posts sync
  socket.on('request_sync', () => {
    try { socket.emit('sync', POSTS_CACHE.slice()); } catch(e){ console.warn('failed sending sync', e); }
  });

  // client requests messages sync
  socket.on('request_messages', () => {
    try { socket.emit('messages_sync', MESSAGES_CACHE.slice()); } catch(e){ console.warn('failed sending messages_sync', e); }
  });

  // NEW POST
  socket.on('new_post', (post) => {
    try {
      if(!post) return;
      // basic normalization
      post.id = post.id || uid();
      post.created_at = post.created_at || nowISO();
      post.likes = Array.isArray(post.likes) ? post.likes : [];
      post.comments = Array.isArray(post.comments) ? post.comments : [];

      pushPostToCache(post);
      io.emit('post', post);
      console.log('[RECV] new_post -> broadcast', post.id);
    } catch(err){ console.error('[ERR] new_post', err); }
  });

  // LIKE
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
    } catch(e){ console.error('[ERR] like', e); }
  });

  // COMMENT
  socket.on('comment', (payload) => {
    try {
      if(!payload || !payload.postId || !payload.comment) return;
      const comment = payload.comment;
      comment.id = comment.id || uid();
      comment.created_at = comment.created_at || nowISO();

      const p = POSTS_CACHE.find(x => x.id === payload.postId);
      if(p){
        p.comments = p.comments || [];
        p.comments.unshift(comment);
      }
      io.emit('comment', { postId: payload.postId, comment });
    } catch(e){ console.error('[ERR] comment', e); }
  });

  // GLOBAL MESSAGE
  socket.on('message', (msg) => {
    try {
      if(!msg) return;
      msg.id = msg.id || uid();
      msg.created_at = msg.created_at || nowISO();
      pushMessageToCache(msg);
      io.emit('message', msg);
      console.log('[RECV] message', msg.id, 'from', msg.userId || 'unknown');
    } catch(err){ console.error('[ERR] message', err); }
  });

  socket.on('ping_server', (data) => { socket.emit('pong_server', { serverTime: nowISO(), you: socket.id }); });

  socket.on('disconnect', (reason) => {
    try {
      const userId = SOCKET_TO_USER.get(socket.id);
      if (userId) {
        const entry = ACTIVE_USERS.get(userId);
        if (entry) {
          entry.sockets.delete(socket.id);
          if (entry.sockets.size === 0) {
            ACTIVE_USERS.delete(userId);
            io.emit('presence:leave', { userId });
          } else {
            entry.lastSeen = nowISO();
          }
        }
      }
      SOCKET_TO_USER.delete(socket.id);
      broadcastPresenceUpdate();
    } catch(e){ console.error('[ERR] disconnect cleanup', e); }
    console.log('[SOCKET] disconnected', socket.id, reason);
  });
});

// start
server.listen(DEFAULT_PORT, () => {
  console.log(`Server listening on port ${DEFAULT_PORT}`);
  console.log('Allowed CORS origins:', CORS_ORIGINS);
});
