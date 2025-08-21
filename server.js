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
      "https://robiulhasanofficial.github.io/islambook/public/" // GitHub Pages domain
    ],
    methods: ["GET", "POST"]
  }
});


// optional in-memory cache of recent posts (no DB)
const POSTS_CACHE = []; // keep small, e.g., last 200

app.use(express.static(path.join(__dirname, 'public'))); // serve client from /public

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // when a client asks for sync (on connect) send cached posts
  socket.on('request_sync', () => {
    socket.emit('sync', POSTS_CACHE);
  });

  // receive new post from a client (post contains id, user, caption, imageData (base64), created_at)
  socket.on('new_post', (post) => {
    // keep small cache
    POSTS_CACHE.push(post);
    if (POSTS_CACHE.length > 300) POSTS_CACHE.shift();
    // broadcast to all clients (including sender)
    io.emit('post', post);
  });

  // like event: { postId, userId, likeId, action: 'like'|'unlike', created_at }
  socket.on('like', (payload) => {
    io.emit('like', payload);
  });

  // comment event: { postId, comment: { id, userId, text, created_at } }
  socket.on('comment', (payload) => {
    io.emit('comment', payload);
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
