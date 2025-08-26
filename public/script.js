// script.js — Updated to support image + video uploads, DB storage of blobs, and lightbox video playback
// Backwards-compatible: keeps existing image flow, adds video flow (thumb generation, blob storage, feed preview)

(function(){
  'use strict';

  // ---------- preserved app logic (improved/responsive tweaks) ----------
  let currentUser = localStorage.getItem("mini_user_name");
  let currentUserId = localStorage.getItem("mini_user_id");
  if (!currentUser) { currentUser = prompt("আপনার নাম লিখুন:")?.trim() || "Anonymous"; localStorage.setItem("mini_user_name", currentUser); }
  if (!currentUserId) { const raw = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('id-' + Date.now() + '-' + Math.random().toString(36).slice(2)); const suffix = raw.replace(/-/g,'').slice(0,6); const cleanName = currentUser.replace(/\s+/g,'').slice(0,12) || 'User'; currentUserId = `${cleanName}#${suffix}`; localStorage.setItem("mini_user_id", currentUserId); }
  const idBadgeEl = document.getElementById('idBadge');
  if(idBadgeEl) idBadgeEl.textContent = `You: ${currentUserId}`;
  if(idBadgeEl) idBadgeEl.addEventListener('click', ()=>{ navigator.clipboard?.writeText(currentUserId).then(()=>{ const b = idBadgeEl; const prev = b.textContent; b.textContent='Copied!'; setTimeout(()=> b.textContent = `You: ${currentUserId}`,900); }).catch(()=>alert('Copy failed — your ID: '+currentUserId)); });

  // ------------------ Socket.IO connection ------------------
  const socket = io("https://islambook.onrender.com", { transports: ['websocket','polling'] });
  socket.on('connect', () => { console.log('[SOCKET] connected', socket.id); socket.emit('request_sync'); socket.emit('request_messages');
    // announce presence to server
    socket.emit('im_here', { userId: currentUserId, userName: currentUser });
    socket.emit('request_active_users');
  });

  // ------------------ Active Users widget (NEW) ------------------
  // Elements
  const auToggle = document.getElementById('active-users-toggle');
  const auListPanel = document.getElementById('active-users-list');
  const auUl = document.getElementById('active-users-ul');
  const auTemplate = document.getElementById('au-item-template');
  const auCountEl = document.getElementById('active-users-count');
  const auCloseBtn = document.getElementById('au-list-close');
  const auCopyBtn = document.getElementById('au-copy-list');
  const auRefreshBtn = document.getElementById('au-refresh');

  // Internal state
  const activeUsers = new Map(); // userId -> {userId, userName, lastSeen, socketId}

  function setActiveCount(n){ if(auCountEl) auCountEl.textContent = String(n || 0); if(auToggle && auListPanel) auToggle.setAttribute('aria-expanded', String(Boolean(auListPanel && !auListPanel.hasAttribute('hidden')))); }

  function renderActiveUsers(){
    if(!auUl) return;
    // clear list
    auUl.innerHTML = '';
    if(activeUsers.size === 0){ const li = document.createElement('li'); li.className = 'au-empty'; li.textContent = 'কেউ অনলাইন নেই'; auUl.appendChild(li); setActiveCount(0); return; }

    // sort by lastSeen desc (most recent first)
    const arr = Array.from(activeUsers.values()).sort((a,b)=> (b.lastSeen||0) - (a.lastSeen||0));
    arr.forEach(u => {
      const node = auTemplate.content.cloneNode(true);
      const li = node.querySelector('.au-item');
      li.dataset.userId = u.userId;
      const nameEl = li.querySelector('.au-item-name');
      const idEl = li.querySelector('.au-item-id');
      nameEl.textContent = u.userName || 'Anonymous';
      idEl.textContent = u.userId;
      // clicking a user copies their id
      li.addEventListener('click', async ()=>{
        try{ await navigator.clipboard.writeText(u.userId); // small UI feedback
          const old = idEl.textContent;
          idEl.textContent = 'Copied!';
          setTimeout(()=> idEl.textContent = old, 900);
        }catch(e){ alert('Copy failed: '+u.userId); }
      });
      auUl.appendChild(li);
    });

    setActiveCount(activeUsers.size);
  }

  function openAuPanel(){ if(!auListPanel) return; auListPanel.removeAttribute('hidden'); auListPanel.setAttribute('aria-hidden','false'); if(auToggle) auToggle.setAttribute('aria-expanded','true'); auListPanel.classList.add('open'); if(auCloseBtn) auCloseBtn.focus(); }
  function closeAuPanel(){ if(!auListPanel) return; auListPanel.setAttribute('hidden',''); auListPanel.setAttribute('aria-hidden','true'); if(auToggle) auToggle.setAttribute('aria-expanded','false'); auListPanel.classList.remove('open'); }
  function toggleAuPanel(){ if(!auListPanel) return; if(auListPanel.hasAttribute('hidden')) openAuPanel(); else closeAuPanel(); }

  // toggle events
  if(auToggle) auToggle.addEventListener('click', (e)=>{ e.stopPropagation(); toggleAuPanel(); });
  if(auCloseBtn) auCloseBtn.addEventListener('click', (e)=>{ e.stopPropagation(); closeAuPanel(); });

  // copy list
  if(auCopyBtn) auCopyBtn.addEventListener('click', async ()=>{
    if(activeUsers.size===0) return alert('No active users to copy');
    const lines = Array.from(activeUsers.values()).map(u=>`${u.userName||'Anon'} \t ${u.userId}`);
    const payload = lines.join('\n');
    try{ await navigator.clipboard.writeText(payload); auCopyBtn.textContent = 'Copied'; setTimeout(()=> auCopyBtn.textContent = 'কপি', 900); }catch(e){ alert('Copy failed'); }
  });

  // refresh -> request server for active list
  if(auRefreshBtn) auRefreshBtn.addEventListener('click', ()=>{ socket.emit('request_active_users'); auRefreshBtn.textContent = '...'; setTimeout(()=> auRefreshBtn.textContent = 'রিফ্রেশ', 800); });

  // close panel when clicking outside
  document.addEventListener('click', (e)=>{ if(auListPanel && auToggle && !auListPanel.contains(e.target) && !auToggle.contains(e.target)){ closeAuPanel(); } });

  // ------------------ presence helpers & socket integration ------------------
  function markUserActive(u){ if(!u || !u.userId) return; const now = Date.now(); const prev = activeUsers.get(u.userId) || {}; activeUsers.set(u.userId, { userId: u.userId, userName: u.userName||u.name||'Anonymous', lastSeen: now, socketId: u.socketId||prev.socketId || null }); }
  function removeUser(userId){ activeUsers.delete(userId); }

  // handle a bulk list from server
  socket.on('active_users', (list)=>{
    try{
      activeUsers.clear();
      (list||[]).forEach(u=> markUserActive(u));
      renderActiveUsers();
    }catch(e){ console.error('[presence] active_users handler err', e); }
  });

  // optional server events (more granular)
  socket.on('user_join', (u)=>{ try{ markUserActive(u); renderActiveUsers(); }catch(e){} });
  socket.on('user_leave', (payload)=>{ try{ const id = (payload && (payload.userId||payload.id)) || payload; if(id) removeUser(id); renderActiveUsers(); }catch(e){} });
  socket.on('presence_update', (u)=>{ try{ markUserActive(u); renderActiveUsers(); }catch(e){} });

  // Fallback: some servers might send 'presence' or 'presence_list'
  socket.on('presence', (p)=>{ try{ if(Array.isArray(p)){ activeUsers.clear(); p.forEach(markUserActive); } else if(p && p.userId){ markUserActive(p); } renderActiveUsers(); }catch(e){} });
  socket.on('presence_list', (arr)=>{ try{ activeUsers.clear(); (arr||[]).forEach(markUserActive); renderActiveUsers(); }catch(e){} });

  // if server sends individual notifications named differently
  socket.on('online', (payload)=>{ try{ if(Array.isArray(payload)){ activeUsers.clear(); payload.forEach(markUserActive); } else markUserActive(payload); renderActiveUsers(); }catch(e){} });

  // heartbeat: periodically re-announce presence so server can keep TTL
  setInterval(()=>{ if(socket && socket.connected){ socket.emit('heartbeat', { userId: currentUserId, userName: currentUser }); } }, 30000);

  // expose a small API so other code can mark local presence (if you switch tabs)
  window.__miniAppPresence = { markLocalActive: ()=>{ markUserActive({ userId: currentUserId, userName: currentUser }); renderActiveUsers(); } };

  // initial UI render
  renderActiveUsers();

  // ------------------ IndexedDB helpers (existing) ------------------
  const DB_NAME = 'mini_social_v1'; const STORE = 'posts'; const MSTORE = 'messages'; let dbPromise = null;
  const DEFAULT_DB_VERSION = 2; // bumped to add messages store

  function openDB(){
    if(dbPromise) return dbPromise;
    dbPromise = new Promise((res, rej) => {
      let triedDelete = false;

      const setupObjectStore = (db) => {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('created_at', 'created_at');
          store.createIndex('userId', 'userId');
        }
        if (!db.objectStoreNames.contains(MSTORE)) {
          const m = db.createObjectStore(MSTORE, { keyPath: 'id' });
          m.createIndex('created_at', 'created_at');
          m.createIndex('userId', 'userId');
        }
      };

      const attempt = (version) => {
        const req = indexedDB.open(DB_NAME, version);

        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          try{ setupObjectStore(db); }catch(err){ console.error('[DB] upgrade error', err); }
        };

        req.onsuccess = () => {
          const db = req.result;
          // Close if another tab triggers a versionchange
          db.onversionchange = () => { db.close(); console.warn('[DB] connection closed due to versionchange'); };
          res(db);
        };

        req.onerror = (e) => {
          const err = e.target && e.target.error;
          // If version mismatch happens (requested version < existing), attempt to delete DB and retry.
          if (err && err.name === 'VersionError' && !triedDelete) {
            triedDelete = true;
            console.warn('[DB] VersionError detected — deleting existing DB and retrying (development fallback).');
            const del = indexedDB.deleteDatabase(DB_NAME);
            del.onsuccess = () => { console.warn('[DB] deleted old DB — retrying open'); attempt(version); };
            del.onerror = () => { dbPromise = null; rej(del.error || new Error('Failed to delete DB')); };
            del.onblocked = () => { dbPromise = null; rej(new Error('Delete blocked — close other tabs using the DB')); };
          } else {
            // Reset dbPromise so future calls can try again
            dbPromise = null;
            rej(err || e);
          }
        };
      };

      attempt(DEFAULT_DB_VERSION);
    });
    return dbPromise;
  }

  async function savePostToDB(post){ const db = await openDB(); return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(post); tx.oncomplete = ()=> res(); tx.onerror = ()=> rej(tx.error); }); }
  async function existsInDB(postId){ const db = await openDB(); return new Promise((res, rej) => { const tx = db.transaction(STORE,'readonly'); const req = tx.objectStore(STORE).get(postId); req.onsuccess = ()=> res(!!req.result); req.onerror = ()=> rej(req.error); }); }
  async function getAllPostsFromDB(){ const db = await openDB(); return new Promise((res, rej) => { const tx = db.transaction(STORE,'readonly'); const req = tx.objectStore(STORE).getAll(); req.onsuccess = ()=> res((req.result||[]).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at))); req.onerror = ()=> rej(req.error); }); }
  async function updatePostInDB(post){ return savePostToDB(post); }

  // messages helpers
  async function saveMessageToDB(msg){ const db = await openDB(); return new Promise((res, rej) => { const tx = db.transaction(MSTORE, 'readwrite'); tx.objectStore(MSTORE).put(msg); tx.oncomplete = ()=> res(); tx.onerror = ()=> rej(tx.error); }); }
  async function existsMessageInDB(id){ const db = await openDB(); return new Promise((res, rej) => { const tx = db.transaction(MSTORE,'readonly'); const req = tx.objectStore(MSTORE).get(id); req.onsuccess = ()=> res(!!req.result); req.onerror = ()=> rej(req.error); }); }
  async function getAllMessagesFromDB(){ const db = await openDB(); return new Promise((res, rej) => { const tx = db.transaction(MSTORE,'readonly'); const req = tx.objectStore(MSTORE).getAll(); req.onsuccess = ()=> res((req.result||[]).sort((a,b)=> new Date(a.created_at) - new Date(b.created_at))); req.onerror = ()=> rej(req.error); }); }

  function uid(){ return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2,9); }
  function timeNow(){ return new Date().toISOString(); }
  function escapeHtml(s){ return (!s? '': String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m]))); }

  // ---------- Responsive image processing on upload (auto-size per device) ----------
  function chooseTargetSize(){
    const w = Math.max(window.innerWidth || 360, 360);
    if (w >= 1400) return {w:1600,h:1000};
    if (w >= 1000) return {w:1400,h:880};
    if (w >= 700) return {w:1200,h:800};
    return {w:900,h:600};
  }

  function supportsWebP(){
    try{
      const c = document.createElement('canvas');
      return !!(c && c.toDataURL && c.toDataURL('image/webp').indexOf('data:image/webp') === 0);
    }catch(e){return false}
  }

  async function processImageFile(file){
    const target = chooseTargetSize();
    const mimePref = supportsWebP() && file.type !== 'image/png' ? 'image/webp' : (file.type === 'image/png' ? 'image/png' : 'image/jpeg');
    const quality = mimePref === 'image/webp' ? 0.85 : 0.92;
    return new Promise((res, rej) => {
      const img = new Image(); img.onload = () => {
        try{
          const canvas = document.createElement('canvas'); canvas.width = target.w; canvas.height = target.h; const ctx = canvas.getContext('2d');
          if (mimePref === 'image/png') ctx.clearRect(0,0,canvas.width,canvas.height); else { ctx.fillStyle='#000'; ctx.fillRect(0,0,canvas.width,canvas.height); }
          const iw = img.naturalWidth||img.width, ih = img.naturalHeight||img.height;
          const scale = Math.min(target.w/iw, target.h/ih);
          const drawW = Math.round(iw*scale), drawH = Math.round(ih*scale);
          const dx = Math.round((target.w - drawW)/2), dy = Math.round((target.h - drawH)/2);
          ctx.drawImage(img,0,0,iw,ih,dx,dy,drawW,drawH);
          const out = canvas.toDataURL(mimePref, quality);
          res(out);
        }catch(err){ rej(err); }
      };
      img.onerror = (e)=> rej(e);
      const fr = new FileReader(); fr.onload = ()=> img.src = fr.result; fr.onerror = (e)=> rej(e); fr.readAsDataURL(file);
    });
  }

  // Create a poster/thumbnail for a video file (capture frame near 0.7s)
  async function createVideoThumbnail(file){
    return new Promise((res)=>{
      try{
        const url = URL.createObjectURL(file);
        const vid = document.createElement('video'); vid.preload = 'metadata'; vid.muted = true; vid.playsInline = true; vid.src = url;
        const cleanup = ()=>{ try{ URL.revokeObjectURL(url); }catch(_){} vid.remove(); };
        vid.addEventListener('loadeddata', ()=>{
          // seek to a small time to ensure frame available
          const seekTo = Math.min(0.7, Math.max(0.1, (vid.duration || 0.5) / 4));
          vid.currentTime = seekTo;
        });
        vid.addEventListener('seeked', ()=>{
          try{
            const canvas = document.createElement('canvas'); canvas.width = Math.min(640, vid.videoWidth || 640); canvas.height = Math.round(canvas.width * (vid.videoHeight/vid.videoWidth || 9/16));
            const ctx = canvas.getContext('2d'); ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            cleanup(); res(dataUrl);
          }catch(err){ cleanup(); res(null); }
        });
        vid.addEventListener('error', ()=>{ cleanup(); res(null); });
      }catch(e){ res(null); }
    });
  }

  // ---------- UI: render feed with nicer cards and accessibility ----------
  const feedEl = document.getElementById('feed'); const searchInput = document.getElementById('searchInput'); const searchBtn = document.getElementById('searchBtn'); const searchInfo = document.getElementById('searchInfo');

  function renderComments(container, comments){
    container.innerHTML = '';
    if(!comments || comments.length === 0){
      container.innerHTML = "<div style='opacity:0.75'>কোনো কমেন্ট নেই</div>";
      return;
    }
    comments.forEach(c=>{
      const div = document.createElement('div');
      div.className = 'comment-item';
      div.innerHTML = `<strong>${escapeHtml(c.userName||'Anon')}:</strong> ${escapeHtml(c.text)}`;
      container.appendChild(div);
    });
  }

  // helper: revoke object URLs inside a node before removing it
  function revokeObjectUrlsIn(node){
    if(!node) return;
    const imgs = node.querySelectorAll('img[data-obj-url]');
    imgs.forEach(i=>{
      try{ URL.revokeObjectURL(i.getAttribute('data-obj-url')); }catch(_){} i.removeAttribute('data-obj-url');
    });
    const vids = node.querySelectorAll('video[data-obj-url]');
    vids.forEach(v=>{
      try{ URL.revokeObjectURL(v.getAttribute('data-obj-url')); }catch(_){} v.removeAttribute('data-obj-url');
    });
  }

  function createPostElement(post){
    const el = document.createElement('article'); el.className='post'; el.id='post-'+post.id; el.setAttribute('tabindex','0');
    const meta = document.createElement('div'); meta.className='meta';
    const left = document.createElement('div'); left.className='user-meta'; left.innerHTML = `<strong>${escapeHtml(post.userName||'Anonymous')}</strong>` + (post.userId? ` <small style="color:var(--muted)">${escapeHtml(post.userId)}</small>`:'');
    const right = document.createElement('div'); right.textContent = new Date(post.created_at).toLocaleString(); meta.appendChild(left); meta.appendChild(right);

    const frame = document.createElement('div'); frame.className='img-frame aspect-16-10';

    if(post.type === 'video'){
      // video preview: use poster if available, or create object URL from blob or use videoUrl
      const videoWrap = document.createElement('div'); videoWrap.className = 'video-wrap'; videoWrap.style.position = 'relative';
      const vid = document.createElement('video'); vid.className = 'post-video'; vid.controls = false; vid.preload = 'metadata'; vid.playsInline = true; vid.muted = true; vid.setAttribute('aria-label','Open video viewer'); vid.style.maxWidth='100%'; vid.style.borderRadius='8px';

      // choose src: prefer blob stored in DB, else videoUrl (from server)
      let objUrl = null;
      if(post.videoBlob) {
        try{ objUrl = URL.createObjectURL(post.videoBlob); vid.src = objUrl; vid.setAttribute('data-obj-url', objUrl); }catch(e){}
      } else if(post.videoUrl) {
        vid.src = post.videoUrl;
      }
      if(post.thumbData) vid.poster = post.thumbData;

      // play on hover (small preview) and pause when leaving (nicer UX)
      videoWrap.addEventListener('mouseenter', ()=>{ try{ vid.play().catch(()=>{}); }catch(_){} });
      videoWrap.addEventListener('mouseleave', ()=>{ try{ vid.pause(); vid.currentTime = 0; }catch(_){} });

      // clicking opens the full lightbox video and plays there
      const playOverlay = document.createElement('div'); playOverlay.className = 'play-overlay';
      playOverlay.style.position='absolute'; playOverlay.style.inset='0'; playOverlay.style.display='flex'; playOverlay.style.alignItems='center'; playOverlay.style.justifyContent='center';
      const playBtn = document.createElement('button'); playBtn.className = 'play-btn lb-small-btn'; playBtn.type='button'; playBtn.innerHTML = '▶'; playBtn.title = 'Play in viewer';
      playBtn.style.fontSize='20px';
      playBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); openLightboxForVideo(post); });
      playOverlay.appendChild(playBtn);

      videoWrap.appendChild(vid); videoWrap.appendChild(playOverlay);
      frame.appendChild(videoWrap);
    } else {
      // image path (same as before)
      const img = document.createElement('img'); img.className='post-img'; img.alt = post.caption || ''; img.loading='lazy'; img.decoding='async';
      if(post.imageData) img.src = post.imageData;
      else if(post.imageBlob){
        try{
          const url = URL.createObjectURL(post.imageBlob);
          img.src = url;
          img.setAttribute('data-obj-url', url);
        }catch(e){}
      }
      img.draggable=false; img.setAttribute('aria-label','Open image viewer');
      img.addEventListener('click', ()=> openLightboxForImage(post));
      frame.appendChild(img);
    }

    const caption = document.createElement('div'); caption.className='caption'; caption.textContent = post.caption || '';

    const actions = document.createElement('div'); actions.className='actions';
    const likeBtn = document.createElement('button'); likeBtn.className='lb-small-btn'; likeBtn.innerHTML = `🤍 <span class="like-count">${(post.likes||[]).length}</span>`; likeBtn.onclick = ()=> toggleLike(post.id, likeBtn);

    const commentToggle = document.createElement('button'); commentToggle.className='lb-small-btn'; const commentCount = (post.comments || []).length; commentToggle.innerHTML = `💬 <span class="comment-count">${commentCount}</span>`; commentToggle.title='Show comments';

    actions.appendChild(likeBtn); actions.appendChild(commentToggle);

    const commentsWrap = document.createElement('div'); commentsWrap.className='comments';
    const commentsList = document.createElement('div'); commentsList.className='comments-list';
    renderComments(commentsList, post.comments||[]);
    commentsWrap.appendChild(commentsList);

    const commentForm = document.createElement('form'); commentForm.className='comment-form'; commentForm.style.display='none'; commentsWrap.style.display='none';
    const commentInput = document.createElement('input'); commentInput.type='text'; commentInput.placeholder='কমেন্ট লিখুন...'; commentInput.setAttribute('aria-label','Write a comment');
    const commentSubmit = document.createElement('button'); commentSubmit.type='submit'; commentSubmit.textContent='Send';
    commentForm.appendChild(commentInput); commentForm.appendChild(commentSubmit);

    commentForm.addEventListener('submit', (ev)=>{
      ev.preventDefault(); const text = commentInput.value.trim(); if(!text) return; commentSubmit.disabled = true;
      postComment(post.id, text).then(()=> {
        const span = commentToggle.querySelector('.comment-count');
        if(span) span.textContent = (parseInt(span.textContent||'0',10) + 1);
      }).finally(()=> { commentInput.value=''; setTimeout(()=> commentSubmit.disabled = false, 300); });
    });

    commentToggle.addEventListener('click', ()=>{
      const isHidden = commentsWrap.style.display === 'none';
      commentsWrap.style.display = isHidden ? 'flex' : 'none';
      commentForm.style.display = isHidden ? 'flex' : 'none';
      commentToggle.title = isHidden ? 'Hide comments' : 'Show comments';
      if(isHidden){ renderComments(commentsList, post.comments||[]); }
    });

    el.appendChild(meta); el.appendChild(frame); el.appendChild(caption); el.appendChild(actions);
    el.appendChild(commentsWrap);
    el.appendChild(commentForm);

    return el;
  }

  function prependPostToFeed(post){ const existing = document.getElementById('post-'+post.id); if(existing){ // revoke object urls inside old element
      revokeObjectUrlsIn(existing); existing.remove(); }
    const el = createPostElement(post); if(feedEl) feedEl.insertAdjacentElement('afterbegin', el);
  }
  function refreshPostInDOM(postId, post){ const container = document.getElementById('post-'+postId); if(!container) return; revokeObjectUrlsIn(container); const newEl = createPostElement(post); container.replaceWith(newEl); }

  async function loadAndRenderFeed(filter=null, opts={partial:true,profile:false}){ const posts = await getAllPostsFromDB(); let shown = posts; if(filter){ const q = filter.toLowerCase(); if(opts.partial) shown = posts.filter(p=>((p.userId||'').toLowerCase().includes(q) || (p.userName||'').toLowerCase().includes(q))); else shown = posts.filter(p=>((p.userId||'').toLowerCase()===q || (p.userName||'').toLowerCase()===q)); if(searchInfo){ searchInfo.style.display='block'; searchInfo.innerHTML = opts.profile? `Profile: <strong>${escapeHtml(filter)}</strong> — ${shown.length} post(s)` : `Search: <strong>${escapeHtml(filter)}</strong> — ${shown.length} result(s)`; } } else { if(searchInfo){ searchInfo.style.display='none'; searchInfo.textContent=''; } }
    if(feedEl) feedEl.innerHTML=''; if(shown.length===0){ if(feedEl) feedEl.innerHTML=`<div style="padding:20px;color:var(--muted)">No posts found${filter? ' for '+escapeHtml(filter):''}.</div>`; return; } shown.forEach(p=>{ if(feedEl) feedEl.appendChild(createPostElement(p)); }); }

  window.clearAndShowAll = async function(){ if(searchInput) searchInput.value=''; await loadAndRenderFeed(); };

  // ---------- Socket handlers (keep existing emit/listen) ----------
  socket.on('sync', async (posts)=>{ for(const p of posts||[]){ try{ if(!(await existsInDB(p.id))) await savePostToDB(p); }catch(e){} } await loadAndRenderFeed(); });
  socket.on('post', async (post)=>{ if(!post) return; if(await existsInDB(post.id)) return; await savePostToDB(post); prependPostToFeed(post); });
  socket.on('like', async (payload)=>{ try{ const db = await openDB(); const tx = db.transaction(STORE,'readwrite'); const store = tx.objectStore(STORE); const req = store.get(payload.postId); req.onsuccess = async ()=>{ const post = req.result; if(!post) return; post.likes = post.likes||[]; if(payload.action==='like'){ if(!post.likes.find(l=>l.id===payload.likeId||l.userId===payload.userId)) post.likes.push({id:payload.likeId,userId:payload.userId,userName:payload.userName||null,created_at:payload.created_at}); } else { post.likes = post.likes.filter(l=>l.id!==payload.likeId&&l.userId!==payload.userId); } await updatePostInDB(post); refreshPostInDOM(post.id,post); }; }catch(e){console.error(e);} });
  socket.on('comment', async (payload)=>{ try{ const db = await openDB(); const tx = db.transaction(STORE,'readwrite'); const store = tx.objectStore(STORE); const req = store.get(payload.postId); req.onsuccess = async ()=>{ const post = req.result; if(!post) return; post.comments = post.comments||[]; if(!post.comments.find(c=>c.id===payload.comment.id)){ post.comments.unshift(payload.comment); await updatePostInDB(post); refreshPostInDOM(post.id,post); } }; }catch(e){console.error(e);} });

  // NEW: respond to server's request to announce local posts (metadata only)
  socket.on('please_announce_posts', async ()=>{
    try{
      const posts = await getAllPostsFromDB();
      const metaList = posts.map(p=>({ id: p.id, created_at: p.created_at, userId: p.userId, userName: p.userName, meta: { size: (p.imageData && p.imageData.length) || (p.videoBlob && p.videoBlob.size) || 0, caption: p.caption || '' }, hasBlob: !!p.imageBlob || !!p.videoBlob }));
      socket.emit('announce_posts', metaList);
    }catch(e){ console.error('[announce_posts] failed', e); }
  });

  // NEW: if server asks this client to upload specific posts (ids), send full posts
  socket.on('request_upload_posts', async (ids)=>{
    try{
      if(!Array.isArray(ids) || ids.length===0) return;
      for(const id of ids){
        try{
          const db = await openDB();
          const tx = db.transaction(STORE,'readonly');
          const req = tx.objectStore(STORE).get(id);
          req.onsuccess = ()=>{
            const post = req.result;
            if(post){
              // prefer 'upload_full_post' (new protocol); also emit 'new_post' for backward compatibility
              try{ socket.emit('upload_full_post', post); }catch(_){}
              try{ socket.emit('new_post', post); }catch(_){}
            }
          };
        }catch(e){ console.error('[request_upload_posts] per-id error', e); }
      }
    }catch(e){ console.error('[request_upload_posts] failed', e); }
  });

  // NEW: server tells this client which server-posts the client is missing
  socket.on('sync_needed', async (ids)=>{
    try{
      if(!Array.isArray(ids) || ids.length===0) return;
      socket.emit('request_posts_by_id', ids);
    }catch(e){ console.error('[sync_needed] failed', e); }
  });

  // NEW: server bulk-sends posts requested by this client
  socket.on('bulk_posts', async (posts)=>{
    try{
      if(!Array.isArray(posts) || posts.length===0) return;
      for(const p of posts){
        try{ if(!(await existsInDB(p.id))) await savePostToDB(p); }catch(e){}
        prependPostToFeed(p);
      }
    }catch(e){ console.error('[bulk_posts] handler failed', e); }
  });

  // messages socket handlers
  socket.on('messages_sync', async (messages)=>{ // optional server support
    for(const m of messages||[]){ try{ if(!(await existsMessageInDB(m.id))) await saveMessageToDB(m); }catch(e){} }
    // if panel open, reload messages
    if(chatPanelOpen) loadAndRenderMessages();
  });

  socket.on('message', async (msg)=>{ // single new message from server
    try{
      if(!(await existsMessageInDB(msg.id))){
        await saveMessageToDB(msg);
        if(chatPanelOpen) appendMessageToUI(msg); else incrementUnreadBadge();
      }
    }catch(e){ console.error(e); }
  });

  // ---------- Upload handler (image + video) ----------
  const mediaInputEl = document.getElementById('imageInput'); // keeps same id for backward compatibility
  const uploadBtnEl = document.getElementById('uploadBtn');

  if(uploadBtnEl) uploadBtnEl.addEventListener('click', async (e)=>{
    e.preventDefault();
    const file = mediaInputEl && mediaInputEl.files && mediaInputEl.files[0];
    const caption = (document.getElementById('caption')||{value:''}).value.trim();
    if(!file) return alert('Choose an image or a video first');
    // warn larger files (video can be bigger)
    if(file.size > 200 * 1024 * 1024 && !confirm('File is large (>200MB). Continue?')) return;

    const id = uid();
    const common = { id, userId:currentUserId, userName:currentUser, caption, created_at: timeNow(), likes:[], comments:[] };

    try{
      if((file.type||'').startsWith('image/')){
        let processedDataUrl;
        try{ processedDataUrl = await processImageFile(file); }catch(err){ console.warn('processImageFile failed, falling back to dataURL', err); processedDataUrl = await new Promise((res,rej)=>{ const fr = new FileReader(); fr.onload = ()=> res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); }); }
        const post = Object.assign({}, common, { type:'image', imageData: processedDataUrl });
        await savePostToDB(post); prependPostToFeed(post);
        try{ socket.emit('upload_full_post', post); }catch(e){} try{ socket.emit('new_post', post); }catch(e){}
      } else if((file.type||'').startsWith('video/')){
        const thumb = await createVideoThumbnail(file);
        // store video Blob directly in post so it persists in IndexedDB
        const post = Object.assign({}, common, { type:'video', videoBlob: file, thumbData: thumb });
        await savePostToDB(post);
        prependPostToFeed(post);
        try{ socket.emit('upload_full_post', post); }catch(e){} try{ socket.emit('new_post', post); }catch(e){}
      } else {
        return alert('Unsupported file type');
      }

      // reset UI
      if(mediaInputEl) mediaInputEl.value=''; const capEl = document.getElementById('caption'); if(capEl) capEl.value='';
    }catch(err){ console.error('upload error', err); alert('Upload failed: '+(err && err.message||err)); }

  });

  // ---------- like/comment helpers (same as before) ----------
  async function toggleLike(postId, btnEl){ const userId=currentUserId; const userName=currentUser; const likeId=uid(); const db=await openDB(); const tx=db.transaction(STORE,'readwrite'); const store = tx.objectStore(STORE); const req = store.get(postId); req.onsuccess = async ()=>{ const post = req.result; if(!post) return; post.likes = post.likes||[]; const existing = post.likes.find(l=>l.userId===userId); const payload = { postId, userId, userName, likeId, action:'like', created_at:timeNow() }; if(existing){ payload.action='unlike'; payload.likeId = existing.id; post.likes = post.likes.filter(l=>l.userId!==userId); btnEl.classList.remove('liked'); } else { post.likes.push({id:likeId,userId,userName,created_at:payload.created_at}); btnEl.classList.add('liked'); } const countEl = btnEl.querySelector('.like-count'); if(countEl) countEl.textContent = post.likes.length; await updatePostInDB(post); socket.emit('like', payload); }; req.onerror = (e)=> console.error(e); }
  async function postComment(postId,text){ const comment = { id:uid(), userId:currentUserId, userName:currentUser, text, created_at:timeNow() }; const payload = { postId, comment }; const db = await openDB(); const tx = db.transaction(STORE,'readwrite'); const store = tx.objectStore(STORE); const req = store.get(postId); req.onsuccess = async ()=>{ const post = req.result; if(!post) return; post.comments = post.comments||[]; post.comments.unshift(comment); await updatePostInDB(post); refreshPostInDOM(postId,post); socket.emit('comment', payload); }; req.onerror = (e)=> console.error(e); }

  // ---------- Lightbox: support for image zoom/pan and video playback ----------
  const lbOverlay = document.getElementById('lightboxOverlay');
  const lbInner = document.querySelector('.lightbox-inner');
  const lbCanvas = document.querySelector('.lightbox-canvas');
  const lbImgEl = document.getElementById('lbImg');
  let lbVideoEl = null; // will create lazily
  const lbCaptionEl = document.getElementById('lbCaption');
  const btnIn = document.getElementById('zoomIn');
  const btnOut = document.getElementById('zoomOut');
  const btnReset = document.getElementById('resetZoom');
  const btnClose = document.getElementById('closeLBox');

  let viewer = { scale:1, min:1, max:4, x:0, y:0, dragging:false };

  function ensureLbVideo(){
    if(lbVideoEl) return lbVideoEl;
    lbVideoEl = document.createElement('video');
    lbVideoEl.setAttribute('id','lbVideo');
    lbVideoEl.style.maxWidth = '100%';
    lbVideoEl.style.maxHeight = '100%';
    lbVideoEl.style.display = 'none';
    lbVideoEl.playsInline = true;
    lbVideoEl.controls = true;
    lbVideoEl.controlsList = 'nodownload';
    lbVideoEl.setAttribute('aria-label','Video viewer');
    // insert after lbImgEl inside canvas
    if(lbCanvas){
      lbCanvas.appendChild(lbVideoEl);
    }
    return lbVideoEl;
  }

  function openLightboxForImage(post){
    if(!lbOverlay) return;
    const src = post.imageData || (post.imageBlob? URL.createObjectURL(post.imageBlob) : null);
    if(!src) return;
    // cleanup video if any
    const lbV = lbVideoEl;
    if(lbV){ try{ lbV.pause(); lbV.style.display='none'; if(lbV.dataset._objurl){ try{ URL.revokeObjectURL(lbV.dataset._objurl); }catch(_){} delete lbV.dataset._objurl; } }catch(_){} }
    if(lbImgEl){
      lbImgEl.style.display = 'block';
      lbImgEl.src = src;
      if(post.imageBlob) lbImgEl.setAttribute('data-obj-url', src);
      lbImgEl.alt = post.caption||'';
      lbCaptionEl.textContent = post.caption||'';
      viewer.scale = 1; viewer.x=0; viewer.y=0; lbImgEl.style.transform = 'translate(0px,0px) scale(1)';
    }
    lbOverlay.classList.add('open'); lbOverlay.setAttribute('aria-hidden','false'); document.body.classList.add('lightbox-open'); btnClose && btnClose.focus();
  }

  function openLightboxForVideo(post){
    if(!lbOverlay) return;
    if(lbImgEl){ lbImgEl.style.display = 'none'; lbImgEl.src = ''; try{ if(lbImgEl.dataset && lbImgEl.dataset._objurl){ try{ URL.revokeObjectURL(lbImgEl.dataset._objurl); }catch(_){} delete lbImgEl.dataset._objurl; } }catch(_){} }
    const video = ensureLbVideo();
    // choose source: videoBlob -> objectURL, else use videoUrl
    let src = null;
    if(post.videoBlob){
      try{ src = URL.createObjectURL(post.videoBlob); video.dataset._objurl = src; }catch(e){ src = null; }
    }
    if(!src && post.videoUrl) src = post.videoUrl;
    if(!src) return;
    video.src = src;
    if(post.thumbData) video.poster = post.thumbData;
    video.style.display = 'block';
    video.currentTime = 0;
    video.muted = false;
    // try to autoplay (may be blocked, ignore errors)
    const p = video.play();
    if(p && typeof p.then === 'function'){ p.catch(()=>{}); }
    lbCaptionEl.textContent = post.caption||'';
    lbOverlay.classList.add('open'); lbOverlay.setAttribute('aria-hidden','false'); document.body.classList.add('lightbox-open'); btnClose && btnClose.focus();
  }

  function closeLightbox(){
    if(!lbOverlay) return;
    lbOverlay.classList.remove('open');
    lbOverlay.setAttribute('aria-hidden','true');
    document.body.classList.remove('lightbox-open');
    // cleanup object urls used by lbVideo
    if(lbVideoEl && lbVideoEl.dataset && lbVideoEl.dataset._objurl){ try{ URL.revokeObjectURL(lbVideoEl.dataset._objurl); }catch(_){} delete lbVideoEl.dataset._objurl; }
    // cleanup image object url if used
    if(lbImgEl && lbImgEl.dataset && lbImgEl.dataset._objurl){ try{ URL.revokeObjectURL(lbImgEl.dataset._objurl); }catch(_){} delete lbImgEl.dataset._objurl; }
    try{ lbVideoEl && lbVideoEl.pause(); }catch(_){} setTimeout(()=>{ if(lbImgEl) lbImgEl.src=''; if(lbVideoEl) lbVideoEl.src=''; }, 300);
  }

  if(btnClose) btnClose.addEventListener('click', closeLightbox);
  if(lbOverlay) lbOverlay.addEventListener('click', (e)=>{ if(e.target === lbOverlay) closeLightbox(); });

  function applyViewer(){ if(lbImgEl) lbImgEl.style.transform = `translate(${viewer.x}px, ${viewer.y}px) scale(${viewer.scale})`; }
  function zoomTo(newScale, cx, cy){ if(!lbImgEl) return; const rect = lbImgEl.getBoundingClientRect(); const imgX = (cx - viewer.x) / viewer.scale; const imgY = (cy - viewer.y) / viewer.scale; viewer.x = cx - imgX * newScale; viewer.y = cy - imgY * newScale; viewer.scale = Math.max(viewer.min, Math.min(viewer.max, newScale)); applyViewer(); }
  function zoomBy(factor){ if(!lbImgEl) return; const rect = lbImgEl.getBoundingClientRect(); zoomTo(viewer.scale * factor, rect.width/2, rect.height/2); }
  if(btnIn) btnIn.addEventListener('click', ()=> zoomBy(1.25));
  if(btnOut) btnOut.addEventListener('click', ()=> zoomBy(0.8));
  if(btnReset) btnReset.addEventListener('click', ()=>{ viewer.scale=1; viewer.x=0; viewer.y=0; applyViewer(); });

  // pointer pan (image only)
  let pDown=false, pId=null, lastX=0, lastY=0;
  if(lbImgEl){
    lbImgEl.addEventListener('pointerdown',(e)=>{ try{ lbImgEl.setPointerCapture(e.pointerId);}catch(_){} pDown=true; pId=e.pointerId; lastX=e.clientX; lastY=e.clientY; viewer.dragging=true; });
    lbImgEl.addEventListener('pointermove',(e)=>{ if(!pDown||e.pointerId!==pId) return; const dx = e.clientX - lastX; const dy = e.clientY - lastY; lastX=e.clientX; lastY=e.clientY; if(viewer.scale>1.01){ viewer.x += dx; viewer.y += dy; applyViewer(); } });
    lbImgEl.addEventListener('pointerup',(e)=>{ pDown=false; viewer.dragging=false; try{ lbImgEl.releasePointerCapture(e.pointerId);}catch(_){} });
    lbImgEl.addEventListener('pointercancel',()=>{ pDown=false; viewer.dragging=false; });
    lbImgEl.addEventListener('dblclick',(e)=>{ const rect=lbImgEl.getBoundingClientRect(); const cx=e.clientX-rect.left; const cy=e.clientY-rect.top; if(viewer.scale<=1.05) zoomTo(2.5,cx,cy); else { viewer.scale=1; viewer.x=0; viewer.y=0; applyViewer(); } });
    lbImgEl.addEventListener('wheel',(e)=>{ if(!lbOverlay || !lbOverlay.classList.contains('open')) return; e.preventDefault(); const dir = e.deltaY < 0 ? 1.12 : 0.88; const rect=lbImgEl.getBoundingClientRect(); const cx=e.clientX-rect.left; const cy=e.clientY-rect.top; zoomTo(viewer.scale * dir, cx, cy); }, { passive:false });
    // pinch handlers
    let pinchState={active:false, startDist:0, startScale:1, midX:0, midY:0};
    lbImgEl.addEventListener('touchstart',(e)=>{ if(e.touches.length===2){ e.preventDefault(); pinchState.active=true; pinchState.startDist=distanceBetween(e.touches[0], e.touches[1]); pinchState.startScale=viewer.scale; const rect=lbImgEl.getBoundingClientRect(); pinchState.midX = (e.touches[0].clientX + e.touches[1].clientX)/2 - rect.left; pinchState.midY = (e.touches[0].clientY + e.touches[1].clientY)/2 - rect.top; } }, {passive:false});
    lbImgEl.addEventListener('touchmove',(e)=>{ if(pinchState.active && e.touches.length===2){ e.preventDefault(); const dist = distanceBetween(e.touches[0], e.touches[1]); const factor = dist / pinchState.startDist; const target = Math.max(viewer.min, Math.min(viewer.max, pinchState.startScale * factor)); zoomTo(target, pinchState.midX, pinchState.midY); } }, {passive:false});
    lbImgEl.addEventListener('touchend',(e)=>{ if(pinchState.active && e.touches.length<2) pinchState.active=false; });
  }
  function distanceBetween(a,b){ return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }

  window.addEventListener('keydown',(e)=>{ if(!lbOverlay || !lbOverlay.classList.contains('open')) return; if(e.key==='Escape') closeLightbox(); if(e.key==='ArrowUp'){ viewer.y += 20; applyViewer(); } if(e.key==='ArrowDown'){ viewer.y -= 20; applyViewer(); } if(e.key==='ArrowLeft'){ viewer.x += 20; applyViewer(); } if(e.key==='ArrowRight'){ viewer.x -=20; applyViewer(); } });

  // ---------- Search handlers ----------
  if(searchBtn) searchBtn.addEventListener('click', async ()=>{ await loadAndRenderFeed(searchInput.value.trim()); });
  if(searchInput) searchInput.addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); loadAndRenderFeed(searchInput.value.trim()); } });

  // ---------- Global chat logic ----------
  const chatToggleBtn = document.getElementById('chatToggleBtn');
  const chatPanel = document.getElementById('chatPanel');
  const chatCloseBtn = document.getElementById('chatCloseBtn');
  const chatMessagesEl = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');
  const chatUnread = document.getElementById('chatUnread');

  let chatPanelOpen = false;
  let unreadCount = 0;

  function showUnreadBadge(){ if(chatUnread){ if(unreadCount>0){ chatUnread.style.display='flex'; chatUnread.textContent = unreadCount>99? '99+' : String(unreadCount); } else chatUnread.style.display='none'; } }
  function incrementUnreadBadge(){ unreadCount++; showUnreadBadge(); }

  if(chatToggleBtn) chatToggleBtn.addEventListener('click', async ()=>{
    chatPanelOpen = !chatPanelOpen;
    if(chatPanel) chatPanel.style.display = chatPanelOpen ? 'flex' : 'none';
    if(chatPanelOpen){
      unreadCount = 0; showUnreadBadge();
      await loadAndRenderMessages();
      chatInput && chatInput.focus();
    }
  });
  if(chatCloseBtn) chatCloseBtn.addEventListener('click', ()=>{ chatPanelOpen = false; if(chatPanel) chatPanel.style.display='none'; });

  if(chatSendBtn) chatSendBtn.addEventListener('click', ()=>{ const txt = chatInput.value.trim(); if(!txt) return; sendMessage(txt); chatInput.value=''; });
  if(chatInput) chatInput.addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); chatSendBtn.click(); } });

  async function sendMessage(text){
    const msg = { id: uid(), userId: currentUserId, userName: currentUser, text, created_at: timeNow() };
    try{
      await saveMessageToDB(msg);
      appendMessageToUI(msg);
      // optimistic: emit to server so others receive
      socket.emit('message', msg);
    }catch(e){ console.error('message save failed', e); alert('Message failed to send locally.'); }
  }

  function appendMessageToUI(msg){
    if(!chatMessagesEl) return;
    const div = document.createElement('div');
    div.className = 'chat-msg';
    const when = new Date(msg.created_at).toLocaleTimeString();
    div.innerHTML = `<strong>${escapeHtml(msg.userName||'Anon')}</strong><div>${escapeHtml(msg.text)}</div><div style="font-size:11px;color:var(--muted);margin-top:6px">${when}</div>`;
    chatMessagesEl.appendChild(div);
    // keep scroll at bottom
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  async function loadAndRenderMessages(){
    if(!chatMessagesEl) return;
    chatMessagesEl.innerHTML = '';
    try{
      const msgs = await getAllMessagesFromDB();
      msgs.forEach(m=>{ appendMessageToUI(m); });
      // keep scroll bottom
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }catch(e){ console.error('load messages failed', e); chatMessagesEl.innerHTML = "<div style='opacity:0.75'>Unable to load messages</div>"; }
  }

  // called when we receive a message and panel is closed
  function handleIncomingMessage(msg){
    if(chatPanelOpen){
      appendMessageToUI(msg);
    } else {
      incrementUnreadBadge();
    }
  }

  // helper for server-driven sync
  async function loadAndRenderMessagesIfOpen(){
    if(chatPanelOpen) await loadAndRenderMessages();
  }

  // ---------- Initial load ----------
  (async ()=>{ await openDB(); await loadAndRenderFeed(); // preload messages count for badge
    try{
      const msgs = await getAllMessagesFromDB();
      // set unread to zero initially (you could compute unread by timestamp if you want)
      unreadCount = 0;
      showUnreadBadge();
    }catch(e){ console.warn('messages preload failed', e); }
  })();

})();
