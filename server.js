// server.js — presence-enabled + media-persist (no external deps required)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

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
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1GB hard cap (configurable)
// presence settings
const PRESENCE_TTL_MS = 90 * 1000; // 90s
const PRESENCE_CLEANUP_INTERVAL_MS = 30 * 1000; // 30s
// ====================

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ["GET", "POST"]
  }
});

// ensure uploads dir exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// in-memory caches (simple, ephemeral)
const POSTS_CACHE = [];     // recent posts, newest last
const POSTS_BY_ID = new Map(); // quick lookup for dedupe
const MESSAGES_CACHE = [];  // recent messages, oldest first

function uid() {
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,9);
}
function nowISO(){ return new Date().toISOString(); }

function pushPostToCache(post){
  if(!post || !post.id) return;
  if(POSTS_BY_ID.has(post.id)) return; // dedupe
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
  MESSAGES_CACHE.push(msg);
  if(MESSAGES_CACHE.length > MESSAGES_CACHE_MAX) MESSAGES_CACHE.splice(0, MESSAGES_CACHE.length - MESSAGES_CACHE_MAX);
}

// Serve static public + uploads
app.use(express.static(path.join(__dirname, 'public')));

// increase JSON/urlencoded limits so base64 uploads can be accepted (careful in prod)
app.use(express.json({limit: '200mb'}));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// ---------- Presence structures ----------
const USERS = new Map();
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

// periodic cleanup
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

// ---------- Helpers for saving files ----------
function guessExtFromMime(mime){
  if(!mime) return '.bin';
  if(mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if(mime.includes('png')) return '.png';
  if(mime.includes('gif')) return '.gif';
  if(mime.includes('webp')) return '.webp';
  if(mime.includes('mp4')) return '.mp4';
  if(mime.includes('webm')) return '.webm';
  if(mime.includes('ogg')) return '.ogv';
  return '.bin';
}

function dataUrlToBuffer(dataUrl){
  const m = /^data:(.+);base64,(.*)$/.exec(dataUrl);
  if(!m) return null;
  const mime = m[1];
  const b = Buffer.from(m[2], 'base64');
  return { mime, buffer: b, size: b.length };
}

// Accept various binary-ish shapes from socket.io (Buffer, serialized Buffer, ArrayBuffer)
function bufferFromCandidate(x){
  if(!x) return null;
  if(Buffer.isBuffer(x)) return x;
  if(x instanceof ArrayBuffer) return Buffer.from(new Uint8Array(x));
  // socket.io sometimes serializes Buffer to { type:'Buffer', data: [...] }
  if(typeof x === 'object' && Array.isArray(x.data)) return Buffer.from(x.data);
  // If base64 string / data URL
  if(typeof x === 'string' && x.startsWith('data:')) {
    const info = dataUrlToBuffer(x);
    return info ? info.buffer : null;
  }
  return null;
}

function saveBufferToUploads(buffer, mime){
  try{
    if(!Buffer.isBuffer(buffer)) return null;
    const ext = guessExtFromMime(mime || '');
    const filename = uid() + ext;
    const absPath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(absPath, buffer);
    return { url: `/uploads/${filename}`, size: buffer.length, filename };
  }catch(e){
    console.error('saveBufferToUploads err', e);
    return null;
  }
}

// ---------- Socket handlers ----------
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
      // ask all connected clients to announce posts (reconciliation)
      for(const [sId, s] of io.sockets.sockets){
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

  // IMPORTANT: handle upload_full_post and persist any binary content to disk
  socket.on('upload_full_post', (post) => {
    try {
      if(!post) return;
      // ensure id/created_at
      if(!post.id) post.id = uid();
      if(!post.created_at) post.created_at = nowISO();
      post.likes = Array.isArray(post.likes) ? post.likes : [];
      post.comments = Array.isArray(post.comments) ? post.comments : [];

      // If post contains imageData as dataURL => save to disk and replace with imageUrl
      if(typeof post.imageData === 'string' && post.imageData.startsWith('data:')){
        const info = dataUrlToBuffer(post.imageData);
        if(info && info.buffer && info.size < MAX_UPLOAD_BYTES){
          const saved = saveBufferToUploads(info.buffer, info.mime);
          if(saved) { post.imageUrl = saved.url; post.meta = post.meta || {}; post.meta.size = saved.size; delete post.imageData; }
        }
      }

      // If post contains imageBlob (binary) => try to convert and save
      if(post.imageBlob){
        const b = bufferFromCandidate(post.imageBlob);
        if(b && b.length < MAX_UPLOAD_BYTES){
          // try to read mime from post.imageMime if present
          const saved = saveBufferToUploads(b, post.imageMime || 'image/jpeg');
          if(saved){ post.imageUrl = saved.url; post.meta = post.meta || {}; post.meta.size = saved.size; delete post.imageBlob; delete post.imageMime; }
        }
      }

      // If post contains videoBlob => save to disk and set videoUrl
      if(post.videoBlob){
        const vb = bufferFromCandidate(post.videoBlob);
        if(vb && vb.length < MAX_UPLOAD_BYTES){
          const saved = saveBufferToUploads(vb, post.videoMime || 'video/mp4');
          if(saved){ post.videoUrl = saved.url; post.meta = post.meta || {}; post.meta.size = saved.size; delete post.videoBlob; delete post.videoMime; }
        }
      }

      // If client supplied thumbData (dataURL), save and set thumbUrl
      if(typeof post.thumbData === 'string' && post.thumbData.startsWith('data:')){
        const info = dataUrlToBuffer(post.thumbData);
        if(info && info.buffer){
          const saved = saveBufferToUploads(info.buffer, info.mime);
          if(saved){ post.thumbUrl = saved.url; delete post.thumbData; }
        }
      }

      // store and broadcast
      pushPostToCache(post);
      io.emit('post', post);
      console.log('[RECV] upload_full_post -> saved/broadcast', post.id);
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

  socket.on('request_upload_posts', (ids) => {
    try{
      if(!Array.isArray(ids)) return;
      for(const id of ids){
        const p = POSTS_BY_ID.get(id);
        if(p){
          try{ socket.emit('upload_full_post', p); }catch(_){}
          try{ socket.emit('new_post', p); }catch(_){}
        }
      }
    } catch(e){ console.error('[ERR] request_upload_posts', e); }
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

  socket.on('disconnect', (reason) => {
    try {
      console.log('[SOCKET] disconnected', socket.id, reason);
      unmarkSocket(socket.id);
    } catch(e){ console.error('[ERR] disconnect handling', e); }
  });
});

// Optional HTTP helper: fetch posts JSON
app.get('/posts', (req, res) => {
  res.json({ posts: POSTS_CACHE.slice() });
});

// HTTP helper endpoint — accept base64/dataURL and save file (optional)
app.post('/upload', (req, res) => {
  try{
    // expected body: { data: 'data:...base64,..', filename?: 'abc.jpg' }
    const { data, filename } = req.body || {};
    if(!data) return res.status(400).json({ error: 'no data' });
    const info = dataUrlToBuffer(data);
    if(!info) return res.status(400).json({ error: 'invalid data URL' });
    if(info.buffer.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'file too large' });
    const ext = guessExtFromMime(info.mime);
    const name = filename ? path.basename(filename) : (uid() + ext);
    const outName = uid() + ext;
    const abs = path.join(UPLOADS_DIR, outName);
    fs.writeFileSync(abs, info.buffer);
    return res.json({ ok: true, url: `/uploads/${outName}`, size: info.buffer.length });
  }catch(e){
    console.error('/upload err', e);
    return res.status(500).json({ error: 'server error' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT} (port ${PORT})`));
