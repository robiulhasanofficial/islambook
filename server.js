// server.js (updated)
// Node >= 14 compatible, no extra npm deps required
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

io.on('connection', (socket) => {
  console.log('[SOCKET] connected', socket.id);

  // client requests full posts sync
  socket.on('request_sync', () => {
    // send full posts cache (you can change to paginated if needed)
    try { socket.emit('sync', POSTS_CACHE.slice()); } catch(e){ console.warn('failed sending sync', e); }
  });

  // client requests messages sync
  socket.on('request_messages', () => {
    try { socket.emit('messages_sync', MESSAGES_CACHE.slice()); } catch(e){ console.warn('failed sending messages_sync', e); }
  });

  // NEW POST (image upload)
  socket.on('new_post', (post) => {
    try {
      // basic validation / defaults
      if(!post) return;
      if(!post.id) post.id = uid();
      if(!post.created_at) post.created_at = nowISO();
      // ensure arrays exist
      post.likes = Array.isArray(post.likes) ? post.likes : [];
      post.comments = Array.isArray(post.comments) ? post.comments : [];

      // add to cache
      pushPostToCache(post);

      // emit to all clients (including sender) -- keep event name 'post' to match client
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
      // apply to server cache (best-effort)
      const p = POSTS_CACHE.find(x => x.id === payload.postId);
      if(p){
        p.likes = p.likes || [];
        if(payload.action === 'like'){
          // prevent duplicates
          if(!p.likes.find(l => l.id === payload.likeId || l.userId === payload.userId)){
            p.likes.push({ id: payload.likeId || uid(), userId: payload.userId, userName: payload.userName || null, created_at: payload.created_at || nowISO() });
          }
        } else {
          p.likes = p.likes.filter(l => l.id !== payload.likeId && l.userId !== payload.userId);
        }
      }
      // broadcast to everyone (including sender) so clients update UI
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

      // apply to server cache (best-effort)
      const p = POSTS_CACHE.find(x => x.id === payload.postId);
      if(p){
        p.comments = p.comments || [];
        // insert at front (keep client's ordering expectation)
        p.comments.unshift(comment);
      }

      // broadcast to everyone
      io.emit('comment', { postId: payload.postId, comment });
    } catch(e){ console.error('[ERR] comment', e); }
  });

  // GLOBAL MESSAGE (chat)
  socket.on('message', (msg) => {
    try {
      if(!msg) return;
      if(!msg.id) msg.id = uid();
      if(!msg.created_at) msg.created_at = nowISO();
      // store
      pushMessageToCache(msg);
      // broadcast to everyone (including sender)
      io.emit('message', msg);
      console.log('[RECV] message', msg.id, 'from', msg.userId || 'unknown');
    } catch(err){ console.error('[ERR] message', err); }
  });

  // optional: client asks for a light 'ping' or presence
  socket.on('ping_server', (data) => { socket.emit('pong_server', { serverTime: nowISO(), you: socket.id }); });

  socket.on('disconnect', (reason) => {
    console.log('[SOCKET] disconnected', socket.id, reason);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT} (port ${PORT})`));
