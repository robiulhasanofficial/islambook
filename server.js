// server.js (persistent + image save)
// Node >= 14, no extra npm deps required
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const app = express();
const server = http.createServer(app);

// ====== CONFIG ======
const CORS_ORIGINS = [
  "https://islambook.onrender.com",
  "https://robiulhasanofficial.github.io",
  "http://localhost:3000"
];
// If you want server to generate absolute image urls, set SERVER_BASE env var (e.g. https://islambook.onrender.com)
const SERVER_BASE = process.env.SERVER_BASE || 'https://islambook.onrender.com';

const POSTS_CACHE_MAX = 300;
const MESSAGES_CACHE_MAX = 500;

const DATA_DIR = path.join(__dirname, 'data');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
// ====================

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ["GET", "POST"]
  }
});

// in-memory caches (also persisted to disk)
let POSTS_CACHE = [];     // newest last
let MESSAGES_CACHE = [];  // oldest first

function uid() {
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,9);
}
function nowISO(){ return new Date().toISOString(); }

async function ensureDirs(){
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
}

async function loadCachesFromDisk(){
  try{
    const [pstat, mstat] = await Promise.allSettled([fsp.stat(POSTS_FILE), fsp.stat(MESSAGES_FILE)]);
    if(pstat.status === 'fulfilled'){
      const raw = await fsp.readFile(POSTS_FILE, 'utf8');
      POSTS_CACHE = JSON.parse(raw) || [];
    }
    if(mstat.status === 'fulfilled'){
      const raw = await fsp.readFile(MESSAGES_FILE, 'utf8');
      MESSAGES_CACHE = JSON.parse(raw) || [];
    }
    console.log('[DATA] loaded posts:', POSTS_CACHE.length, 'messages:', MESSAGES_CACHE.length);
  }catch(err){
    console.warn('[DATA] load failed or no data yet', err);
  }
}

let saveTimer = null;
function scheduleSaveToDisk(delay = 500){
  if(saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async ()=>{
    try{
      await fsp.writeFile(POSTS_FILE, JSON.stringify(POSTS_CACHE, null, 2), 'utf8');
      await fsp.writeFile(MESSAGES_FILE, JSON.stringify(MESSAGES_CACHE, null, 2), 'utf8');
      // console.log('[DATA] caches flushed to disk');
    }catch(e){
      console.error('[DATA] save failed', e);
    }
    saveTimer = null;
  }, delay);
}

// helper: map mime -> ext
function mimeToExt(mime){
  if(!mime) return '.bin';
  if(mime.includes('png')) return '.png';
  if(mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if(mime.includes('webp')) return '.webp';
  if(mime.includes('gif')) return '.gif';
  return '.bin';
}

// decode dataURL and write file, return public absolute URL
async function saveDataUrlToFile(dataUrl, fileId){
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if(!m) throw new Error('Invalid data url');
  const mime = m[1];
  const b64 = m[2];
  const ext = mimeToExt(mime);
  const filename = `${fileId}${ext}`;
  const filepath = path.join(UPLOADS_DIR, filename);
  const buf = Buffer.from(b64, 'base64');
  await fsp.writeFile(filepath, buf);
  const publicUrl = `${SERVER_BASE.replace(/\/$/,'')}/uploads/${filename}`;
  return publicUrl;
}

// push helpers + truncate
function pushPostToCache(post){
  POSTS_CACHE.push(post);
  if(POSTS_CACHE.length > POSTS_CACHE_MAX) POSTS_CACHE.splice(0, POSTS_CACHE.length - POSTS_CACHE_MAX);
}
function pushMessageToCache(msg){
  MESSAGES_CACHE.push(msg);
  if(MESSAGES_CACHE.length > MESSAGES_CACHE_MAX) MESSAGES_CACHE.splice(0, MESSAGES_CACHE.length - MESSAGES_CACHE_MAX);
}

// serve static
app.use(express.static(path.join(__dirname, 'public')));

// handy REST endpoint (optional)
app.get('/posts', (req, res) => {
  res.json(POSTS_CACHE.slice().reverse()); // newest first for convenience
});

io.on('connection', (socket) => {
  console.log('[SOCKET] connected', socket.id);

  socket.on('request_sync', () => {
    try { socket.emit('sync', POSTS_CACHE.slice()); } catch(e){ console.warn('failed sending sync', e); }
  });

  socket.on('request_messages', () => {
    try { socket.emit('messages_sync', MESSAGES_CACHE.slice()); } catch(e){ console.warn('failed sending messages_sync', e); }
  });

  // NEW POST (image upload)
  socket.on('new_post', async (post) => {
    try {
      if(!post) return;
      if(!post.id) post.id = uid();
      if(!post.created_at) post.created_at = nowISO();
      post.likes = Array.isArray(post.likes) ? post.likes : [];
      post.comments = Array.isArray(post.comments) ? post.comments : [];

      // if imageData is a data: url -> save to disk and replace with absolute URL
      try{
        if(typeof post.imageData === 'string' && post.imageData.startsWith('data:')){
          const fileId = post.id || uid();
          const url = await saveDataUrlToFile(post.imageData, fileId);
          post.imageData = url;
        }
      }catch(e){ console.warn('[POST] image save failed, keeping original dataUrl', e); }

      pushPostToCache(post);
      scheduleSaveToDisk();
      io.emit('post', post);
      console.log('[RECV] new_post -> broadcast', post.id);
    } catch(err){
      console.error('[ERR] new_post', err);
    }
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
      scheduleSaveToDisk();
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

      scheduleSaveToDisk();
      io.emit('comment', { postId: payload.postId, comment });
    } catch(e){ console.error('[ERR] comment', e); }
  });

  socket.on('message', (msg) => {
    try {
      if(!msg) return;
      if(!msg.id) msg.id = uid();
      if(!msg.created_at) msg.created_at = nowISO();
      pushMessageToCache(msg);
      scheduleSaveToDisk();
      io.emit('message', msg);
      console.log('[RECV] message', msg.id, 'from', msg.userId || 'unknown');
    } catch(err){ console.error('[ERR] message', err); }
  });

  socket.on('disconnect', (reason) => {
    console.log('[SOCKET] disconnected', socket.id, reason);
  });
});

// startup
(async ()=>{
  try{
    await ensureDirs();
    await loadCachesFromDisk();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
    // flush caches on exit
    const flushAndExit = async () => {
      try{
        if(saveTimer) clearTimeout(saveTimer);
        await fsp.writeFile(POSTS_FILE, JSON.stringify(POSTS_CACHE, null, 2), 'utf8');
        await fsp.writeFile(MESSAGES_FILE, JSON.stringify(MESSAGES_CACHE, null, 2), 'utf8');
        console.log('[DATA] final flush complete');
      }catch(e){ console.warn('[DATA] final flush failed', e); }
      process.exit();
    };
    process.on('SIGINT', flushAndExit);
    process.on('SIGTERM', flushAndExit);
  }catch(e){
    console.error('startup failed', e);
    process.exit(1);
  }
})();
