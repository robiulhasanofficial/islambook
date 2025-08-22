// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // প্রয়োজনে শুধু তোমার সাইটের origin বসাও
    methods: ["GET", "POST"]
  }
});

// সব ডাটা ইন-মেমোরিতে রাখা (প্রয়োজনে DB যুক্ত করা যাবে)
let posts = [];
let messages = []; // নতুন: গ্রুপ চ্যাট মেসেজ

io.on("connection", (socket) => {
  console.log("⚡ User connected:", socket.id);

  // নতুন ইউজার এলে তাদেরকে আগের সব পোস্ট পাঠানো
  socket.on("request_sync", () => {
    socket.emit("sync", posts);
  });

  // নতুন ইউজার এলে আগের সব মেসেজ পাঠানো
  socket.on("request_messages", () => {
    socket.emit("messages_sync", messages);
  });

  // নতুন পোস্ট
  socket.on("post", (post) => {
    posts.unshift(post);
    io.emit("post", post);
  });

  // লাইক / আনলাইক
  socket.on("like", (payload) => {
    io.emit("like", payload);
  });

  // কমেন্ট
  socket.on("comment", (payload) => {
    io.emit("comment", payload);
  });

  // নতুন মেসেজ (গ্রুপ চ্যাট)
  socket.on("message", (msg) => {
    messages.push(msg);
    io.emit("message", msg); // সবাইকে পাঠানো
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);
  });
});

// সার্ভার চালানো
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});
