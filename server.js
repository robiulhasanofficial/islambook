// server.js
// Node >=14
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;
const CORS_ORIGINS_ENV = process.env.CORS_ORIGINS || "";
const CORS_ORIGINS = CORS_ORIGINS_ENV
  ? CORS_ORIGINS_ENV.split(',').map(s => s.trim()).filter(Boolean)
  : [
      "https://islambook.onrender.com",
      "https://robiulhasanofficial.github.io",
      "http://localhost:3000"
    ];

const POSTS_FILE = path.join(__dirname, 'data', 'posts.json');
const MESSAGES_FILE = path.join(__dirname, 'data', 'messages.json');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');

const POSTS_CACHE_MAX = parseInt(process.env.POSTS_CACHE_MAX,10) || 500;
const MESSAGES_CACHE_MAX = parseInt(process.env.MESSAGES_CACHE_MAX,10) || 1000;
// ============================

// ensure folders
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.dirname(POSTS_FILE), { recursive: true });

// helper load/save
function safeLoadJSON(filePath, fallback){
  try {
    if(fs.existsSync(filePath)){
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    }
  } catch(e){
    console.warn('failed to load', filePath, e);
  }
  return fallback;
}
function safeSaveJSON(filePath, obj){
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
  } catch(e){
    console.error('failed to save', filePath, e);
  }
}

// in-memory caches (load from disk if available)
let POSTS_CACHE = safeLoadJSON(POSTS_FILE, []);
let MESSAGES_CACHE = safeLoadJSON(MESSAGES_FILE, []);
if(!Array.isArray(POSTS_CACHE)) POSTS_CACHE = [];
if(!Array.isArray(MESSAGES_CACHE)) MESSAGES_CACHE = [];

// simple id + time
function uid(){ return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,9); }
function nowISO(){ return new Date().toISOString(); }

function pushPostToCache(post){
  POSTS_CACHE.push(post);
  if(POSTS_CACHE.length > POSTS_CACHE_MAX) POSTS_CACHE.splice(0, POSTS_CACHE.length - POSTS_CACHE_MAX);
  safeSaveJSON(POSTS_FILE, POSTS_CACHE);
}
function pushMessageToCache(msg){
  MESSAGES_CACHE.push(msg);
  if(MESSAGES_CACHE.length > MESSAGES_CACHE_MAX) MESSAGES_CACHE.splice(0, MESSAGES_CACHE.length - MESSAGES_CACHE_MAX);
  safeSaveJSON(MESSAGES_FILE, MESSAGES_CACHE);
}

// CORS helper
function originAllowed(origin){
  if(!origin) return true;
  return CORS_ORIGINS.indexOf(origin) !== -1;
}

// configure socket.io with dynamic origin checking
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (originAllowed(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed by CORS'));
    },
    methods: ["GET","POST"],
    credentials: true
  }
});

// Express middleware
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
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

// serve static client + uploads
app.use(express.static(path.join(__dirname, 'public')));

// ----------------- file upload endpoint (multipart/form-data) -----------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, UPLOAD_DIR); },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const name = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,6);
    cb(null, `${name}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
  fileFilter: (req, file, cb) => {
    // only images
    if(!file.mimetype.startsWith('image/')) return cb(new Error('Only images allowed'), false);
    cb(null, true);
  }
}).single('image');

app.post('/upload', (req, res) => {
  upload(req, res, (err) => {
    if(err){
      console.error('/upload error', err);
      return res.status(400).json({ error: err.message || 'upload error' });
    }
    // expected fields: caption, userId, userName (optional)
    const file = req.file;
    if(!file) return res.status(400).json({ error: 'no file' });

    const caption = req.body.caption || '';
    const userId = req.body.userId || uid();
    const userName = req.body.userName || 'Anonymous';

    const publicPath = `/uploads/${path.basename(file.path)}`;
    const post = {
      id: uid(),
      userId,
      userName,
      caption,
      image: publicPath,
      created_at: nowISO(),
      likes: [],
      comments: []
    };

    pushPostToCache(post);
    // broadcast to all sockets
    io.emit('post', post);
    return res.json({ ok: true, post });
  });
});

// optional endpoints to fetch caches
app.get('/api/posts', (req, res) => res.json(POSTS_CACHE.slice()));
app.get('/api/messages', (req, res) => res.json(MESSAGES_CACHE.slice()));

// ----------------- socket handling -----------------

// presence maps
const ACTIVE_USERS = new Map(); // userId -> { userId, userName, lastSeen, sockets:Set }
const SOCKET_TO_USER = new Map(); // socketId -> userId

function broadcastPresenceUpdate(){
  const snapshot = Array.from(ACTIVE_USERS.values()).map(u => ({
    userId: u.userId,
    userName: u.userName,
    lastSeen: u.lastSeen,
    sockets: u.sockets ? Array.from(u.sockets).slice(0,3) : []
  }));
  io.emit('presence:update', snapshot);
}

function pruneStaleUsers(thresholdMs = 2 * 60 * 1000){
  const now = Date.now();
  let changed = false;
  for(const [userId, entry] of ACTIVE_USERS){
    const last = new Date(entry.lastSeen).getTime();
    if(isNaN(last) || (now - last) > thresholdMs){
      ACTIVE_USERS.delete(userId);
      changed = true;
      io.emit('presence:leave', { userId });
    }
  }
  if(changed) broadcastPresenceUpdate();
}

// periodic prune
setInterval(() => pruneStaleUsers(), 60 * 1000);

// socket connections
io.on('connection', (socket) => {
  console.log('[SOCKET] connected', socket.id);

  socket.on('presence:join', (payload) => {
    try {
      if(!payload || !payload.userId) return;
      const { userId, userName } = payload;
      SOCKET_TO_USER.set(socket.id, userId);

      let entry = ACTIVE_USERS.get(userId);
      if(!entry){
        entry = { userId, userName: userName || 'Anonymous', lastSeen: nowISO(), sockets: new Set() };
        ACTIVE_USERS.set(userId, entry);
      }
      entry.userName = userName || entry.userName;
      entry.lastSeen = nowISO();
      entry.sockets.add(socket.id);

      io.emit('presence:join', { userId: entry.userId, userName: entry.userName, ts: entry.lastSeen });
      broadcastPresenceUpdate();
    } catch(e){ console.error('presence:join', e); }
  });

  socket.on('presence:leave', (payload) => {
    try {
      const userId = (payload && (payload.userId || SOCKET_TO_USER.get(socket.id)));
      if(!userId) return;
      const entry = ACTIVE_USERS.get(userId);
      if(entry){
        entry.sockets.delete(socket.id);
        if(entry.sockets.size === 0){
          ACTIVE_USERS.delete(userId);
          io.emit('presence:leave', { userId });
        } else {
          entry.lastSeen = nowISO();
        }
      }
      SOCKET_TO_USER.delete(socket.id);
      broadcastPresenceUpdate();
    } catch(e){ console.error('presence:leave', e); }
  });

  socket.on('presence:heartbeat', (payload) => {
    try {
      const userId = (payload && (payload.userId || SOCKET_TO_USER.get(socket.id)));
      if(!userId) return;
      const entry = ACTIVE_USERS.get(userId);
      if(entry) entry.lastSeen = nowISO();
      broadcastPresenceUpdate();
    } catch(e){ /* ignore */ }
  });

  socket.on('presence:request', () => {
    try {
      const snapshot = Array.from(ACTIVE_USERS.values()).map(u => ({ userId: u.userId, userName: u.userName, lastSeen: u.lastSeen }));
      socket.emit('activeUsers', snapshot);
    } catch(e){ console.error('presence:request', e); }
  });

  // client asks for posts sync
  socket.on('request_sync', () => {
    try { socket.emit('sync', POSTS_CACHE.slice()); } catch(e){ console.warn('failed sending sync', e); }
  });
  // messages sync
  socket.on('request_messages', () => {
    try { socket.emit('messages_sync', MESSAGES_CACHE.slice()); } catch(e){ console.warn('failed sending messages_sync', e); }
  });

  // handles 'new_post' sent via socket
  socket.on('new_post', async (post) => {
    try {
      if(!post) return;

      // if post contains imageData (dataURL), save to file
      if(post.imageData && typeof post.imageData === 'string' && post.imageData.startsWith('data:')){
        const matches = post.imageData.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
        if(matches){
          const mime = matches[1];
          const b64 = matches[2];
          const ext = mime.split('/')[1] || 'png';
          const filename = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}.${ext}`;
          const filepath = path.join(UPLOAD_DIR, filename);
          fs.writeFileSync(filepath, Buffer.from(b64, 'base64'));
          post.image = `/uploads/${filename}`;
        }
        delete post.imageData;
      }

      post.id = post.id || uid();
      post.created_at = post.created_at || nowISO();
      post.likes = Array.isArray(post.likes) ? post.likes : [];
      post.comments = Array.isArray(post.comments) ? post.comments : [];

      pushPostToCache(post);
      io.emit('post', post);
      console.log('[RECV] new_post -> broadcast', post.id);
    } catch(err){ console.error('[ERR] new_post', err); }
  });

  // like
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

  // comment
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

  // global message
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

  socket.on('ping_server', () => socket.emit('pong_server', { serverTime: nowISO(), you: socket.id }));

  socket.on('disconnect', (reason) => {
    try {
      const userId = SOCKET_TO_USER.get(socket.id);
      if(userId){
        const entry = ACTIVE_USERS.get(userId);
        if(entry){
          entry.sockets.delete(socket.id);
          if(entry.sockets.size === 0){
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
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('Allowed CORS origins:', CORS_ORIGINS);
});
