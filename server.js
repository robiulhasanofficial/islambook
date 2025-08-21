// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors()); // prod-এ origin সীমাবদ্ধ করবে
app.use(express.json());
app.use(express.static('public')); // যদি তুমি client ফাইল সার্ভ করুন; নাহলে অপশনাল

const server = http.createServer(app);

// cors options: production-এ specific origin লিখবে
const io = new Server(server, {
  cors: { origin: '*' }
});

// Simple in-memory store (restart এ হারাবে). পরবর্তীতে DB ব্যবহার করো।
let lastFull = { list: [], lastUpdated: 0 };

io.on('connection', (socket) => {
  console.log('socket connected:', socket.id);

  socket.on('orders:hello', (data) => {
    // যদি সার্ভারে নতুন ডেটা থাকে, ক্লায়েন্টকে পাঠানো হবে
    try {
      if(lastFull.lastUpdated > (data.lastUpdated || 0)){
        socket.emit('orders:full', lastFull);
      }
    } catch(e){ console.error(e); }
  });

  socket.on('orders:sync', (payload) => {
    try {
      // update server memory if payload is newer
      if(payload.lastUpdated && payload.lastUpdated > lastFull.lastUpdated){
        lastFull = { list: payload.list || [], lastUpdated: payload.lastUpdated };
      }
      // broadcast to other clients (not back to sender)
      socket.broadcast.emit('orders:sync', payload);
    } catch(e){ console.error(e); }
  });

  socket.on('disconnect', ()=> {
    console.log('socket disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log(`Server listening on ${PORT}`));