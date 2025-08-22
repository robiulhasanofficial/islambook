// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "https://islambook.onrender.com",       // নিজের domain
      "https://robiulhasanofficial.github.io" // GitHub Pages domain root
    ],
    methods: ["GET", "POST"]
  }
});

// optional in-memory cache of recent posts (no DB)
const POSTS_CACHE = []; // keep small, e.g., last 200

// serve client from /public folder
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // যখন ক্লায়েন্ট connect হবে তখন sync চাইলে cache পাঠাও
  socket.on('request_sync', () => {
    socket.emit('sync', POSTS_CACHE);
  });

  // নতুন পোস্ট এলে
  socket.on('new_post', (post) => {
    console.log('[RECV] new_post', post.id);

    // cache এ রাখো
    POSTS_CACHE.push(post);
    if (POSTS_CACHE.length > 300) POSTS_CACHE.shift();

    // 🔥 fix: sender + অন্য সব ক্লায়েন্টে পাঠানো
    socket.broadcast.emit('post', post);
    socket.emit('post', post); 
  });

  // লাইক ইভেন্ট
  socket.on('like', (payload) => {
    socket.broadcast.emit('like', payload);
    socket.emit('like', payload);
  });

  // কমেন্ট ইভেন্ট
  socket.on('comment', (payload) => {
    socket.broadcast.emit('comment', payload);
    socket.emit('comment', payload);
  });
    // delete post (simple owner-check using client-sent userId)
  socket.on('delete_post', (payload, callback) => {
    try {
      const postId = payload && payload.postId;
      const userId = payload && payload.userId;

      if (!postId) {
        if (callback) callback({ ok:false, reason: 'missing_postId' });
        return;
      }

      // find in POSTS_CACHE
      const idx = POSTS_CACHE.findIndex(p => p && p.id === postId);
      if (idx === -1) {
        if (callback) callback({ ok:false, reason: 'not_found' });
        return;
      }

      const post = POSTS_CACHE[idx];

      // ownership check (basic) — client-sent userId must match post.userId
      if (!userId || post.userId !== userId) {
        if (callback) callback({ ok:false, reason: 'forbidden' });
        return;
      }

      // remove from cache
      POSTS_CACHE.splice(idx, 1);

      // notify all clients that the post was deleted
      io.emit('delete_post', { postId });

      // success ack
      if (callback) callback({ ok:true });
      console.log(`[DELETE] post ${postId} deleted by ${userId}`);
    } catch (err) {
      console.error('delete_post err', err);
      if (callback) callback({ ok:false, reason: 'server_error' });
    }
  });
  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
