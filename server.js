const express = require("express");
app.use(cors());


const server = http.createServer(app);
const io = new Server(server, {
cors: {
origin: "*",
methods: ["GET", "POST"]
}
});


let posts = [];
let messages = [];


io.on("connection", (socket) => {
console.log("⚡ User connected:", socket.id);


socket.on("request_sync", () => {
socket.emit("sync", posts);
});


socket.on("request_messages", () => {
socket.emit("messages_sync", messages);
});


// standard post event
socket.on("post", (post) => {
posts.unshift(post);
io.emit("post", post);
});


// backwards-compatibility: handle older clients that emit 'new_post'
socket.on("new_post", (post) => {
console.warn('[server] received "new_post" (alias)');
posts.unshift(post);
io.emit("post", post);
});


socket.on("like", (payload) => {
io.emit("like", payload);
});


socket.on("comment", (payload) => {
io.emit("comment", payload);
});


socket.on("message", (msg) => {
messages.push(msg);
io.emit("message", msg);
});


socket.on("disconnect", () => {
console.log("❌ User disconnected:", socket.id);
});
});
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
console.log(`🚀 Server listening on http://localhost:${PORT}`);
});