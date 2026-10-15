'use strict';
const $ = id => document.getElementById(id);
const video = $('video'), shell = $('video-shell');
const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4];
let file = null, objectURL = null, key = 'study-player:general', messages = [], loaded = false;
let accessToken = '', connected = false, busy = false, controller = null, noticeTimer, toastTimer;
let frame = null, dragDepth = 0, lastSave = 0, restoreTime = 0, restoring = false, detectingDuration = false, durationTimer, storageWarningShown = false;
let currentRecord = null, libraryEntries = [], importing = false, libraryBooting = true, openedAt = 0, draftSaveTimer;
let currentConversation = null, conversationSwitching = false, conversationMenuTarget = null, dialogTarget = null, undoDeletion = null, undoTimer;
let showArchivedVideos = false, projectMenuTarget = null, deleteVideoTarget = null;
const projectStates = new Map(), expandedProjects = new Set();
const markdown = window.markdownit({ html: false, linkify: true, breaks: true });

function mathHTML(source, displayMode = false) {
  try { return katex.renderToString(source, { displayMode, throwOnError: false, trust: false, strict: 'ignore' }); }
  catch { return markdown.utils.escapeHtml(source); }
}
markdown.inline.ruler.before('escape', 'latex_inline', (state, silent) => {
  if (state.src.slice(state.pos, state.pos + 2) !== '\\(') return false;
  const end = state.src.indexOf('\\)', state.pos + 2);
  if (end === -1) return false;
  if (!silent) { const token = state.push('latex_inline', '', 0); token.content = state.src.slice(state.pos + 2, end); }
  state.pos = end + 2; return true;
});
markdown.renderer.rules.latex_inline = (tokens, index) => mathHTML(tokens[index].content);
markdown.block.ruler.before('paragraph', 'latex_display', (state, startLine, endLine, silent) => {
  const begin = state.bMarks[startLine] + state.tShift[startLine];
  const open = state.src.slice(begin, begin + 2);
  if (!['\\[', '$$'].includes(open)) return false;
  const close = open === '\\[' ? '\\]' : '$$';
  const end = state.src.indexOf(close, begin + 2);
  if (end < 0 || end > state.eMarks[endLine - 1]) return false;
  let finish = startLine; while (finish < endLine && state.eMarks[finish] < end + 2) finish++;
  if (state.src.slice(end + 2, state.eMarks[finish]).trim()) return false;
  if (silent) return true;
  const token = state.push('latex_display', '', 0); token.content = state.src.slice(begin + 2, end); token.map = [startLine, finish + 1]; token.block = true;
  state.line = finish + 1; return true;
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
markdown.renderer.rules.latex_display = (tokens, index) => mathHTML(tokens[index].content, true) + '\n';
const originalLink = markdown.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank'); tokens[idx].attrSet('rel', 'noopener noreferrer'); return originalLink(tokens, idx, options, env, self);
};
document.querySelectorAll('[data-math]').forEach(el => { el.innerHTML = mathHTML(el.dataset.math); });
function clock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const sec = String(value % 60).padStart(2, '0'), min = String(Math.floor(value / 60) % 60).padStart(2, '0'), hour = Math.floor(value / 3600);
  return hour ? `${hour}:${min}:${sec}` : `${min}:${sec}`;
}
function notice(text) { $('notice').textContent = text; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5000); }
function toast(text, math = false) { $('video-toast').innerHTML = math ? mathHTML(text) : markdown.utils.escapeHtml(text); $('video-toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('video-toast').hidden = true; }, 1300); }
function storageRead(id) { try { return JSON.parse(localStorage.getItem(id) || 'null'); } catch { return null; } }
function save() {
  if (restoring || libraryBooting) return Promise.resolve();
  const id = videoId(), value = videoState(), recordId = currentRecord?.id, snapshot = captureConversation();
  if (recordId) setSaveStatus('正在保存进度…');
  const progress = studyLibrary.available ? studyLibrary.saveState(id, value).then(state => {
    const entry = libraryEntries.find(entry => entry.record.id === id);
    if (entry) entry.state = state;
    setProjectState(id, { ...(projectStates.get(id) || state), ...value, updatedAt: state.updatedAt });
    if (recordId && currentRecord?.id === recordId) setSaveStatus('已保存到 ' + clock(state.time || 0));
  }) : Promise.resolve();
  const hasChat = snapshot && (snapshot.messages.length || snapshot.draft || snapshot.context ||
    projectChats(projectStates.get(id)).some(chat => chat.id === snapshot.id));
  const conversation = hasChat ? persistConversation(snapshot) : Promise.resolve();
  return Promise.all([progress, conversation]).catch(error => {
    if (id !== videoId()) return;
    if (recordId) setSaveStatus('记录未能保存，请检查浏览器空间');
    if (!storageWarningShown) { storageWarningShown = true; notice(error.message || '记录未能保存，请检查浏览器存储空间。'); }
  });
}

function setSpeed(value, notify = false) {
  const speed = Math.max(0.25, Math.min(4, Number(value) || 1));
  video.playbackRate = speed; $('rate').value = speed;
  $('rate-label').innerHTML = mathHTML(`${speed}\\times`);
  $('rate-label').setAttribute('aria-label', `当前${speed}倍速，点击打开调速滑条`);
  if (notify) toast(`${speed}\\times`, true);
  if (!restoring) save();
}
function shiftSpeed(delta) {
  const current = speeds.findIndex(x => x >= video.playbackRate - 0.001);
  setSpeed(speeds[Math.max(0, Math.min(speeds.length - 1, current + delta))], true);
}
function closeRatePopover(returnFocus = false) {
  $('rate-popover').hidden = true; $('rate-label').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('rate-label').focus();
}
function toggleRatePopover() {
  const open = $('rate-popover').hidden;
  $('rate-popover').hidden = !open; $('rate-label').setAttribute('aria-expanded', String(open));
  if (open) $('rate').focus();
}
function updateTransport() {
  $('current-time').textContent = clock(video.currentTime); $('duration').textContent = Number.isFinite(video.duration) ? clock(video.duration) : loaded ? '待检测' : '00:00';
  $('timeline').value = loaded && Number.isFinite(video.duration) && video.duration ? Math.round(video.currentTime / video.duration * 1000) : 0;
  $('ask-position').textContent = loaded ? `当前 ${clock(video.currentTime)}` : '未加载视频';
}
function playIcon() {
  $('play').innerHTML = video.paused ? '<svg viewBox="0 0 24 24"><path d="m7 4 14 8-14 8z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>';
  $('play').setAttribute('aria-label', video.paused ? '播放' : '暂停');
}
async function togglePlay() {
  if (!loaded) { notice('先打开一段视频。'); return; }
  if (video.paused) { try { await video.play(); } catch { notice('这个视频暂时无法播放，请换用浏览器支持的格式。'); } }
  else video.pause();
}
function seek(seconds) {
  if (!loaded) return;
  video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + seconds)); updateTransport(); save();
  toast(`${seconds < 0 ? '-' : '+'}${Math.abs(seconds)}\\,\\mathrm{s}`, true);
}
async function fullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await shell.requestFullscreen(); }
  catch { notice('此浏览器无法进入全屏，可以按浏览器的全屏快捷键。'); }
}
function volumeIcon() {
  $('mute').setAttribute('aria-label', video.muted ? '取消静音' : '静音');
  $('mute').style.opacity = video.muted || !video.volume ? '0.4' : '1';
}
function setEnabled() { ['play', 'back', 'forward'].forEach(id => { $(id).disabled = !loaded; }); $('timeline').disabled = !loaded || !Number.isFinite(video.duration); }
function finishLoading() {
  clearTimeout(durationTimer); detectingDuration = false;
  loaded = video.readyState >= 1 && video.videoWidth > 0; setEnabled();
  if (loaded) video.currentTime = Number.isFinite(video.duration) ? Math.min(restoreTime, Math.max(0, video.duration - 0.1)) : restoreTime;
  updateTransport();
}
function currentFrame() {
  if (!loaded || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(1, 1600 / video.videoWidth, 1200 / video.videoHeight);
  const canvas = document.createElement('canvas'); canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
  try { canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height); return { data: canvas.toDataURL('image/jpeg', 0.88), time: video.currentTime }; }
  catch { notice('无法截取当前画面，可以取消附图后提问。'); return null; }
}
function waitForVideoFrame(signal) {
  if (!loaded || signal?.aborted) return Promise.resolve(false);
  if (!video.seeking && video.readyState >= 2) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const cleanup = value => {
      clearTimeout(timer); ['seeked', 'loadeddata', 'canplay'].forEach(name => video.removeEventListener(name, check));
      video.removeEventListener('error', fail); signal?.removeEventListener('abort', fail); resolve(value);
    };
    const check = () => { if (!video.seeking && video.readyState >= 2) cleanup(true); };
    const fail = () => cleanup(false);
    ['seeked', 'loadeddata', 'canplay'].forEach(name => video.addEventListener(name, check));
    video.addEventListener('error', fail); signal?.addEventListener('abort', fail, { once: true }); timer = setTimeout(fail, 5000); check();
  });
}
async function showFrame(options = {}) {
  if (!$('attach-frame').checked) { frame = null; $('frame-preview').hidden = true; return; }
  const captureKey = key + ':' + currentConversation?.id, ready = await waitForVideoFrame(options.signal);
  if (captureKey !== key + ':' + currentConversation?.id) return null;
  frame = ready && $('attach-frame').checked ? currentFrame() : null; $('frame-preview').hidden = !frame;
  if (frame) { $('frame-image').src = frame.data; $('frame-time').textContent = `画面 ${clock(frame.time)}`; }
  return frame;
}
async function pauseAsk() {
  video.pause();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  await showFrame(); $('question').focus();
  if (window.innerWidth < 800) $('question').scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function historyForModel() {
  return messages.filter(x => ['user', 'assistant'].includes(x.role)).slice(-12).map(x => ({ role: x.role, text: x.role === 'user' ? `[${x.file || '未加载视频'} ${clock(x.time)}] ${x.text}` : x.text }));
}
function emptyChat() {
  $('chat-messages').innerHTML = '<div class="empty-chat"><h3>卡住的地方，慢慢讲清楚。</h3><p>暂停视频，把当前画面带上。可以问推导、概念，也可以让我举一个更简单的例子。</p><div class="suggestions"><button class="suggestion" type="button">请解释当前画面中的核心概念</button><button class="suggestion" type="button">这一步推导用了什么条件？</button><button class="suggestion" type="button">给我一个从简单到完整的例子</button></div></div>';
  $('chat-messages').querySelectorAll('.suggestion').forEach(el => el.addEventListener('click', async () => { $('question').value = el.textContent; await pauseAsk(); }));
}
function messageElement(message) {
  const article = document.createElement('article'); article.className = `message ${message.role}`;
  const head = document.createElement('div'); head.className = 'message-head';
  const label = document.createElement('strong'); label.textContent = message.role === 'user' ? '我' : message.role === 'assistant' ? 'Codex' : '暂时未能回答'; head.append(label);
  if (message.time !== undefined && message.file) {
    const jump = document.createElement('button'); jump.type = 'button'; jump.className = 'jump-link'; jump.textContent = `回到 ${clock(message.time)}`;
    jump.addEventListener('click', () => { if (!loaded || file?.name !== message.file) { notice('先重新打开这段视频。'); return; } video.currentTime = Math.min(video.duration, Math.max(0, message.time)); updateTransport(); save(); });
    head.append(jump);
  }
  const body = document.createElement('div'); body.className = 'message-body';
  if (message.role === 'assistant') body.innerHTML = markdown.render(message.text); else body.textContent = message.text;
  article.append(head, body); return article;
}
function renderMessages() {
  $('chat-messages').replaceChildren();
  if (!messages.length) emptyChat(); else messages.forEach(x => $('chat-messages').append(messageElement(x)));
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
  updateConversationHeading();
}
function setBusy(value) {
  busy = value; $('ask').disabled = value || !connected; $('cancel').hidden = !value;
  $('question').disabled = value; $('open-file').disabled = value; $('file-input').disabled = value; $('new-chat').disabled = value;
  $('attach-frame').disabled = value; $('retake').disabled = value;
  $('ask').textContent = value ? '等待回答' : '问 Codex';
  if (!value) $('ask-status').textContent = '按 Ctrl + Enter 提问';
  updateLibraryControls();
}
function connectionStatus(ready, text) {
  connected = ready; $('connection-dot').classList.toggle('ready', ready); $('reconnect').textContent = text; $('ask').disabled = busy || !ready; updateLibraryControls();
}
async function configure() {
  try {
    const response = await fetch('/api/config'); if (!response.ok) throw new Error();
    const data = await response.json(); accessToken = data.token; connectionStatus(data.ready, data.message);
  } catch { connectionStatus(false, '本地服务未连接'); notice('播放器服务未连接，请双击“启动播放器”再打开。'); }
}
async function sendQuestion(event) {
  event?.preventDefault(); if (busy || importing || conversationSwitching || libraryBooting) return;
  const question = $('question').value.trim(); if (!question) { $('question').focus(); return; }
  if (!connected) { notice('先让 Codex 完成登录，再点击右上角重新连接。'); return; }
  setBusy(true); controller = new AbortController();
  try { await persistConversation(); } catch (error) { controller = null; setBusy(false); notice(error.message || '对话未能保存，请重试。'); return; }
  video.pause(); await showFrame({ signal: controller.signal });
  if (controller.signal.aborted) { controller = null; setBusy(false); notice('已停止这次提问。'); return; }
  if (loaded && $('attach-frame').checked && !frame) { controller = null; setBusy(false); notice('视频画面仍在加载，请稍后再问，或取消附图。'); return; }
  const time = loaded ? video.currentTime : 0;
  const payload = { conversationId: currentConversation.id, projectId: videoId(), question, file: file?.name || '未加载视频', timestamp: clock(time), context: $('lesson-context').value, frame: $('attach-frame').checked ? frame?.data || null : null, history: historyForModel() };
  messages.push({ role: 'user', text: question, time, file: file?.name, attached: !!payload.frame }); renderMessages(); save();
  $('ask-status').textContent = 'Codex 正在查看问题…';
  let received = false;
  function consume(line) {
    if (!line.trim()) return; const event = JSON.parse(line);
    if (event.type === 'status') $('ask-status').textContent = event.text;
    if (event.type === 'answer') { messages.push({ role: 'assistant', text: event.text, time, file: file?.name }); received = true; $('question').value = ''; renderMessages(); save(); }
    if (event.type === 'error') { messages.push({ role: 'error', text: event.text }); received = true; renderMessages(); }
  }
  try {
    const response = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Token': accessToken }, body: JSON.stringify(payload), signal: controller.signal });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || '提问失败，请重试。'); }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let index; while ((index = buffer.indexOf('\n')) !== -1) { consume(buffer.slice(0, index)); buffer = buffer.slice(index + 1); } }
    buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
    if (!received) throw new Error('连接已断开，没有收到答案，请重试。');
  } catch (error) {
    messages.push({ role: 'error', text: error.name === 'AbortError' ? '已停止这次回答，可以修改问题后再问。' : error.message || '网络连接失败，请重试。' }); renderMessages();
  } finally { controller = null; setBusy(false); $('question').focus(); }
}
async function loadVideo(selected, record = null, restoredOverride = null, requestedChatId = null) {
  if (busy) { notice('等当前回答结束后再换视频。'); return; }
  if (!selected) return;
  if (!selected.type.startsWith('video/') && !/\.(mp4|webm|mkv|mov|m4v|avi|ogg|ogv)$/i.test(selected.name)) { notice('请选择视频文件。'); return; }
  await save(); video.pause(); restoring = true; if (objectURL) URL.revokeObjectURL(objectURL);
  clearTimeout(durationTimer); detectingDuration = false; loaded = false; setEnabled();
  file = selected; key = 'study-player:video:' + file.name + ':' + file.size + ':' + file.lastModified;
  currentRecord = record; openedAt = Date.now();
  let restored = restoredOverride;
  if (!restored && studyLibrary.available) {
    const latest = await studyLibrary.getState(record?.id || key);
    restored = Object.keys(latest).length ? latest : await studyLibrary.getState(key);
  }
  if (!restored || !Object.keys(restored).length) restored = storageRead(key) || {};
  const project = await ensureProjectState(videoId(), restored);
  restoreTime = Math.max(0, Number(restored.time) || 0);
  expandedProjects.add(videoId()); applyConversation(project, requestedChatId);
  if (requestedChatId) await mutateConversations('selectConversation', videoId(), requestedChatId);
  $('video-name').textContent = selected.name; $('video-name').title = selected.name;
  objectURL = URL.createObjectURL(selected); video.src = objectURL; video.load();
  setSpeed(restored.rate || 1); restoring = false;
  $('drop-zone').hidden = true; shell.classList.add('loaded');
  $('player-hint').textContent = '空格播放 / 暂停；方向键快进快退；Q 暂停提问。';
  setSaveStatus(record ? '视频已保存，正在恢复进度…' : '视频未保存，关闭后需重新选择原文件');
  save(); renderLibrary();
}

function videoState() {
  return {
    time: loaded ? video.currentTime : restoreTime, duration: Number.isFinite(video.duration) ? video.duration : 0,
    rate: video.playbackRate, openedAt
  };
}
function videoId() { return currentRecord?.id || key; }
function storageFailure(error) {
  const quota = error?.name === 'QuotaExceededError' || /quota|space|storage full/i.test(error?.message || '');
  return quota ? '浏览器空间不足，视频没有保存；可以继续观看，关闭后需重新选择文件。' :
    '浏览器未能保存视频；可以继续观看，关闭后需重新选择文件。请检查浏览器存储设置。';
}
function setSaveStatus(text) { if ($('save-status').textContent !== text) $('save-status').textContent = text; }
function updateLibraryControls() {
  const disabled = busy || importing || libraryBooting || conversationSwitching;
  $('open-file').disabled = disabled; $('file-input').disabled = disabled; $('sidebar-add-video').disabled = disabled;
  const noProject = !file && !projectChats(projectStates.get('study-player:general')).length;
  $('new-chat').disabled = disabled || noProject; $('sidebar-new-chat').disabled = disabled || noProject;
  $('question').disabled = busy || libraryBooting || conversationSwitching;
  $('lesson-context').disabled = busy || libraryBooting || conversationSwitching;
  document.querySelectorAll('.project-open,.project-new-chat,.project-more,.conversation-open,.conversation-more').forEach(el => { el.disabled = disabled; });
  $('ask').disabled = disabled || !connected;
}
function fileSizeHTML(size) {
  const unit = size >= 1024 * 1024 * 1024 ? 'GB' : 'MB';
  const divisor = unit === 'GB' ? 1024 * 1024 * 1024 : 1024 * 1024;
  return mathHTML((size / divisor).toFixed(1) + '\\,\\mathrm{' + unit + '}');
}
function compareLibraryEntries(a, b) {
  return Number(Boolean(b.state.openedAt)) - Number(Boolean(a.state.openedAt)) ||
    (b.state.openedAt || b.record.addedAt) - (a.state.openedAt || a.record.addedAt);
}

function projectChats(state) {
  return studyLibrary.visibleConversations(state || {}).slice().sort((a, b) => b.updatedAt - a.updatedAt);
}
function setProjectState(projectId, state) {
  projectStates.set(projectId, state);
  const entry = libraryEntries.find(entry => entry.record.id === projectId);
  if (entry) entry.state = state;
}
async function ensureProjectState(projectId, fallback = {}) {
  if (studyLibrary.available) {
    const state = await studyLibrary.ensureConversations(projectId, fallback);
    setProjectState(projectId, state); return state;
  }
  let state = projectStates.get(projectId);
  if (!state) {
    const chats = fallback.messages?.length || fallback.draft || fallback.context ?
      [studyLibrary.makeConversation(projectId, fallback)] : [];
    state = { ...fallback, conversations: chats, activeConversationId: chats[0]?.id || null,
      deletedConversationIds: {}, conversationVersion: 1 };
    setProjectState(projectId, state);
  }
  return state;
}
async function mutateConversations(method, projectId, ...args) {
  let state;
  if (studyLibrary.available) state = await studyLibrary[method](projectId, ...args);
  else {
    state = JSON.parse(JSON.stringify(projectStates.get(projectId) || { conversations: [], deletedConversationIds: {} }));
    const chats = projectChats(state), id = typeof args[0] === 'string' ? args[0] : args[0]?.id;
    if (method === 'createConversation') {
      const chat = studyLibrary.makeConversation(projectId); chats.push(chat); state.activeConversationId = chat.id;
    } else if (method === 'saveConversation') {
      if (Object.hasOwn(state.deletedConversationIds, id)) throw new Error('这段对话已被删除。');
      const snapshot = args[0], existing = chats.find(chat => chat.id === id);
      const chat = { ...snapshot, title: existing?.title || snapshot.title, updatedAt: Date.now() };
      if (chat.titleMode !== 'manual') chat.title = snapshot.messages.find(message => message.role === 'user')?.text.trim().slice(0, 42) || '新对话';
      const index = chats.findIndex(chat => chat.id === id); if (index >= 0) chats[index] = chat; else chats.push(chat);
      state.activeConversationId = id;
    } else if (method === 'selectConversation') state.activeConversationId = id;
    else if (method === 'renameConversation') {
      const chat = chats.find(chat => chat.id === id);
      if (chat) { chat.title = args[1]; chat.titleMode = 'manual'; chat.updatedAt = Date.now(); }
    } else if (method === 'deleteConversation') {
      state.deletedConversationIds[id] = Date.now(); state.activeConversationId = chats.find(chat => chat.id !== id)?.id || null;
    } else if (method === 'restoreConversation') {
      delete state.deletedConversationIds[id]; chats.push(args[0]); state.activeConversationId = id;
    }
    state.conversations = chats.filter(chat => !Object.hasOwn(state.deletedConversationIds, chat.id));
    setProjectState(projectId, state);
  }
  setProjectState(projectId, state); return state;
}
function captureConversation() {
  if (!currentConversation) return null;
  return { ...currentConversation, projectId: videoId(), messages: messages.filter(message => message.role !== 'error'),
    draft: $('question').value, context: $('lesson-context').value };
}
function applyConversation(state, requestedId = null) {
  const chats = projectChats(state);
  currentConversation = chats.find(chat => chat.id === requestedId) ||
    chats.find(chat => chat.id === state.activeConversationId) || chats[0] || studyLibrary.makeConversation(videoId());
  messages = Array.isArray(currentConversation.messages) ? currentConversation.messages.slice() : [];
  $('question').value = currentConversation.draft || ''; $('lesson-context').value = currentConversation.context || '';
  frame = null; $('frame-preview').hidden = true; renderMessages(); renderLibrary();
}
async function persistConversation(snapshot = captureConversation()) {
  if (!snapshot) return;
  const state = await mutateConversations('saveConversation', snapshot.projectId, snapshot);
  if (snapshot.projectId === videoId() && currentConversation?.id === snapshot.id) {
    currentConversation = projectChats(state).find(chat => chat.id === snapshot.id) || currentConversation;
  }
  renderLibrary(); updateConversationHeading();
}
function updateConversationHeading() {
  $('chat-title').textContent = currentConversation?.title || '新对话';
  $('chat-title').title = currentConversation?.title || '新对话';
  $('chat-project').textContent = file?.name || '选择视频项目，开始一段对话';
}
function projectName(projectId) {
  return libraryEntries.find(entry => entry.record.id === projectId)?.record.name ||
    (projectId === videoId() ? file?.name : '') || '未关联视频';
}
function displayChatTime(timestamp) {
  const zone = 'Asia/Shanghai', dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = dayFormat.format(new Date()), day = dayFormat.format(new Date(timestamp || 0));
  const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false });
  if (day === today) return '今天 ' + clock.format(new Date(timestamp));
  return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: 'short', day: 'numeric' }).format(new Date(timestamp || 0));
}
function iconButton(label, drawing) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'sidebar-icon';
  button.setAttribute('aria-label', label); button.title = label;
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + drawing + '</svg>'; return button;
}
function renderLibrary() {
  if (!$('library-list')) return;
  const focusedChat = document.activeElement?.closest('.conversation-open')?.dataset.chatId;
  $('library-list').replaceChildren();
  const entries = libraryEntries.filter(entry => Boolean(entry.record.archivedAt) === showArchivedVideos);
  const archivedCount = libraryEntries.filter(entry => entry.record.archivedAt).length;
  $('library-count').innerHTML = mathHTML(entries.length) + ' 个视频项目';
  $('library-active').setAttribute('aria-pressed', String(!showArchivedVideos));
  $('library-archived').setAttribute('aria-pressed', String(showArchivedVideos));
  $('archived-count').textContent = archivedCount ? '（' + archivedCount + '）' : '';
  const query = $('history-search').value.trim().toLocaleLowerCase();
  const groups = entries.slice().sort(compareLibraryEntries).map(entry =>
    ({ projectId: entry.record.id, name: entry.record.name, record: entry.record, state: projectStates.get(entry.record.id) || entry.state }));
  if (!showArchivedVideos && file && !currentRecord) groups.unshift({ projectId: videoId(), name: file.name, record: null, state: projectStates.get(videoId()) });
  const general = projectStates.get('study-player:general');
  if (!showArchivedVideos && projectChats(general).length) groups.push({ projectId: 'study-player:general', name: '未关联视频', record: null, state: general });
  let shown = 0;
  for (const group of groups) {
    const allChats = projectChats(group.state);
    const matchesProject = group.name.toLocaleLowerCase().includes(query);
    const chats = !query || matchesProject ? allChats : allChats.filter(chat =>
      chat.title.toLocaleLowerCase().includes(query) || chat.messages.some(message => message.text.toLocaleLowerCase().includes(query)));
    if (query && !matchesProject && !chats.length) continue;
    shown++;
    const section = document.createElement('section'); section.className = 'sidebar-project'; section.dataset.projectId = group.projectId;
    const row = document.createElement('div'); row.className = 'project-row'; row.classList.toggle('current', videoId() === group.projectId);
    const expanded = query ? true : expandedProjects.has(group.projectId);
    const toggle = iconButton((expanded ? '收起 ' : '展开 ') + group.name, '<path class="stroke" d="m9 5 7 7-7 7"/>');
    toggle.classList.add('project-expand'); toggle.setAttribute('aria-expanded', String(expanded)); toggle.classList.toggle('expanded', expanded);
    toggle.addEventListener('click', () => { expandedProjects.has(group.projectId) ? expandedProjects.delete(group.projectId) : expandedProjects.add(group.projectId); renderLibrary(); });
    const open = document.createElement('button'); open.type = 'button'; open.className = 'project-open library-item';
    open.dataset.videoId = group.projectId; open.title = group.name; open.disabled = busy || importing || conversationSwitching;
    const name = document.createElement('strong'); name.textContent = group.name;
    const position = document.createElement('span'); position.textContent = group.record ? (group.record.archivedAt ? '已归档，上次看到 ' : '上次看到 ') + clock(group.state?.time || 0) : group.projectId === 'study-player:general' ? '独立的未关联对话' : '视频未保存';
    open.append(name, position);
    open.addEventListener('click', async () => {
      expandedProjects.add(group.projectId);
      if (group.projectId === videoId()) { renderLibrary(); return; }
      if (group.record) await openSavedVideo(group.record);
      else if (group.projectId === 'study-player:general') await openGeneralProject();
      closeSidebarOnMobile();
    });
    const add = iconButton('在 ' + group.name + ' 中新建对话', '<path class="stroke" d="M12 5v14M5 12h14"/>');
    add.classList.add('project-new-chat'); add.disabled = busy || importing || conversationSwitching;
    add.addEventListener('click', async () => {
      if (group.projectId !== videoId()) {
        if (group.record) await openSavedVideo(group.record); else await openGeneralProject();
      }
      await createNewConversation(); closeSidebarOnMobile();
    });
    row.append(toggle, open, add);
    if (group.record) {
      const more = iconButton('管理视频 ' + group.name, '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>');
      more.classList.add('project-more'); more.disabled = busy || importing || conversationSwitching;
      more.addEventListener('click', event => openProjectMenu(group.record, event.currentTarget)); row.append(more);
    }
    section.append(row);
    const children = document.createElement('div'); children.className = 'project-conversations'; children.hidden = !expanded;
    for (const chat of chats) {
      const chatRow = document.createElement('div'); chatRow.className = 'conversation-row';
      const current = group.projectId === videoId() && chat.id === currentConversation?.id;
      chatRow.classList.toggle('current', current); chatRow.dataset.chatId = chat.id;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'conversation-open';
      button.dataset.chatId = chat.id; button.title = chat.title; button.disabled = busy || importing || conversationSwitching;
      if (current) button.setAttribute('aria-current', 'page');
      const title = document.createElement('span'); title.className = 'conversation-name'; title.textContent = chat.title;
      const time = document.createElement('span'); time.className = 'conversation-date'; time.textContent = current && busy ? '正在回答…' : displayChatTime(chat.updatedAt);
      button.append(title, time); button.addEventListener('click', () => switchConversation(group.projectId, chat.id));
      const more = iconButton('管理对话 ' + chat.title, '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>');
      more.classList.add('conversation-more'); more.disabled = busy || importing || conversationSwitching;
      more.addEventListener('click', event => openConversationMenu(group.projectId, chat, event.currentTarget));
      chatRow.append(button, more); children.append(chatRow);
    }
    if (!chats.length) {
      const empty = document.createElement('p'); empty.className = 'project-empty'; empty.textContent = query ? '没有匹配的对话' : '点击加号，开始新对话'; children.append(empty);
    }
    section.append(children); $('library-list').append(section);
  }
  $('library-empty').hidden = shown > 0;
  $('library-empty').textContent = query ? '没有找到匹配的视频或对话。' : showArchivedVideos ? '还没有归档视频。归档后可以在这里恢复。' : '添加一个课程视频，作为你的学习项目。';
  if (focusedChat) document.querySelector('.conversation-open[data-chat-id="' + CSS.escape(focusedChat) + '"]')?.focus({ preventScroll: true });
  updateLibraryControls(); updateConversationHeading();
}
async function switchConversation(projectId, id) {
  if (busy || importing || conversationSwitching) return;
  if (projectId !== videoId()) {
    const record = libraryEntries.find(entry => entry.record.id === projectId)?.record;
    if (record) await openSavedVideo(record, id); else await openGeneralProject(id);
  } else {
    conversationSwitching = true; updateLibraryControls();
    try { await save(); const state = await mutateConversations('selectConversation', projectId, id); applyConversation(state, id); }
    catch (error) { notice(error.message || '未能打开对话。'); }
    finally { conversationSwitching = false; updateLibraryControls(); }
  }
  closeSidebarOnMobile();
}
async function createNewConversation() {
  if (busy || importing || conversationSwitching || libraryBooting) return;
  conversationSwitching = true; updateLibraryControls();
  try {
    await save(); const state = await mutateConversations('createConversation', videoId());
    expandedProjects.add(videoId()); applyConversation(state, state.activeConversationId); $('question').focus();
  } catch (error) { notice(error.message || '新对话未能保存。'); }
  finally { conversationSwitching = false; updateLibraryControls(); }
}
async function openGeneralProject(requestedId = null) {
  if (busy || importing || conversationSwitching) return;
  conversationSwitching = true; updateLibraryControls();
  try {
    await save(); video.pause(); restoring = true;
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = null; file = null; currentRecord = null; key = 'study-player:general';
    clearTimeout(durationTimer); detectingDuration = false; loaded = false; restoreTime = 0;
    video.removeAttribute('src'); video.load(); setEnabled(); shell.classList.remove('loaded'); $('drop-zone').hidden = false;
    $('video-name').textContent = '未关联视频的对话'; setSaveStatus('选择一个视频项目继续学习');
    const state = await ensureProjectState(key, storageRead(key) || {});
    expandedProjects.add(key); applyConversation(state, requestedId); restoring = false; updateTransport();
  } finally { restoring = false; conversationSwitching = false; updateLibraryControls(); }
}
function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  $('project-sidebar').inert = !open; $('sidebar-toggle').setAttribute('aria-expanded', String(open));
  $('sidebar-backdrop').hidden = !open || window.innerWidth > 1150;
}
function closeSidebarOnMobile() { if (window.innerWidth <= 1150) setSidebar(false); }
function closeConversationMenu() { $('conversation-menu').hidden = true; conversationMenuTarget = null; }
function closeProjectMenu() { $('project-menu').hidden = true; projectMenuTarget = null; }
function openProjectMenu(record, anchor) {
  if (busy || importing || conversationSwitching) return;
  closeConversationMenu(); projectMenuTarget = record;
  const menu = $('project-menu'), rect = anchor.getBoundingClientRect();
  $('archive-video').textContent = record.archivedAt ? '恢复到正在学习' : '归档视频';
  menu.hidden = false; menu.style.left = Math.max(8, Math.min(rect.right - 168, innerWidth - 176)) + 'px';
  menu.style.top = Math.max(8, Math.min(rect.bottom + 4, innerHeight - 106)) + 'px'; $('archive-video').focus();
}
async function clearCurrentVideoProject() {
  clearTimeout(draftSaveTimer); clearTimeout(durationTimer); detectingDuration = false;
  video.pause(); if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = null; file = null; currentRecord = null; key = 'study-player:general';
  loaded = false; restoreTime = 0; openedAt = 0; frame = null;
  video.removeAttribute('src'); video.load(); setEnabled(); shell.classList.remove('loaded'); $('drop-zone').hidden = false;
  $('video-name').textContent = '先放进一段课程视频'; $('video-name').title = '';
  $('player-hint').textContent = '拖入视频后，可以按空格播放，按 Q 暂停并提问。';
  setSaveStatus('视频和进度会保存在当前浏览器');
  const state = await ensureProjectState(key, storageRead(key) || {});
  applyConversation(state); updateTransport();
}
async function manageVideoProject(record, action) {
  if (busy || importing || conversationSwitching || libraryBooting) return false;
  conversationSwitching = true; updateLibraryControls();
  try {
    await save(); await studyLibrary.flushed();
    const current = currentRecord?.id === record.id;
    restoring = true;
    if (current) video.pause();
    let cleanupComplete = true;
    if (action === 'delete') {
      const result = await studyLibrary.deleteVideo(record.id); cleanupComplete = result.cleanupComplete;
      result.ids.forEach(id => { projectStates.delete(id); expandedProjects.delete(id); });
      if (undoDeletion && result.ids.includes(undoDeletion.projectId)) {
        clearTimeout(undoTimer); undoDeletion = null; $('undo-delete').hidden = true;
      }
    } else await studyLibrary.setVideoArchived(record.id, action === 'archive');
    if (current && action !== 'restore') await clearCurrentVideoProject();
    if (action === 'restore') { showArchivedVideos = false; expandedProjects.add(record.id); }
    await refreshLibrary();
    notice(action === 'delete' ? cleanupComplete ? '视频副本和关联记录已删除，原视频文件仍保留。' : '视频已删除，但旧关闭快照未能清理；请检查浏览器存储权限。' :
      action === 'archive' ? '视频已归档，可在“已归档”中恢复。' : '视频已恢复到“正在学习”。');
    return true;
  } finally { restoring = false; conversationSwitching = false; updateLibraryControls(); }
}
function openConversationMenu(projectId, chat, anchor) {
  if (busy || importing || conversationSwitching) return;
  closeProjectMenu();
  conversationMenuTarget = { projectId, chat }; const menu = $('conversation-menu'), rect = anchor.getBoundingClientRect();
  menu.hidden = false; menu.style.left = Math.max(8, Math.min(rect.right - 168, innerWidth - 176)) + 'px';
  menu.style.top = Math.min(rect.bottom + 4, innerHeight - 106) + 'px'; $('rename-conversation').focus();
}
function showDeleteUndo(projectId, chat) {
  undoDeletion = { projectId, chat }; $('undo-delete').hidden = false;
  clearTimeout(undoTimer); undoTimer = setTimeout(() => { $('undo-delete').hidden = true; undoDeletion = null; }, 15000);
}
async function reloadProjectAfterAction(projectId, state) {
  setProjectState(projectId, state);
  if (videoId() === projectId) {
    const selected = projectChats(state).find(chat => chat.id === currentConversation?.id);
    if (selected) currentConversation = { ...currentConversation, title: selected.title, titleMode: selected.titleMode };
    else applyConversation(state);
  }
  renderLibrary();
}
$('sidebar-toggle').addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));
$('sidebar-close').addEventListener('click', () => { setSidebar(false); $('sidebar-toggle').focus(); });
$('sidebar-backdrop').addEventListener('click', () => setSidebar(false));
$('sidebar-new-chat').addEventListener('click', createNewConversation);
$('sidebar-add-video').addEventListener('click', () => $('file-input').click());
$('history-search').addEventListener('input', renderLibrary);
for (const [id, archived] of [['library-active', false], ['library-archived', true]]) {
  $(id).addEventListener('click', () => { showArchivedVideos = archived; closeProjectMenu(); closeConversationMenu(); renderLibrary(); });
}
$('archive-video').addEventListener('click', async () => {
  if (!projectMenuTarget) return;
  const record = projectMenuTarget; closeProjectMenu();
  try { await manageVideoProject(record, record.archivedAt ? 'restore' : 'archive'); }
  catch (error) { notice(error.message || '未能修改视频归档状态。'); }
});
$('delete-video').addEventListener('click', () => {
  if (!projectMenuTarget) return;
  deleteVideoTarget = projectMenuTarget; closeProjectMenu();
  $('delete-video-name').textContent = deleteVideoTarget.name;
  const chats = projectChats(projectStates.get(deleteVideoTarget.id));
  $('delete-video-details').textContent = '将清除这个视频的浏览器副本、播放进度、倍速，以及所有关联对话、草稿、课堂补充和恢复快照。当前有 ' + chats.length + ' 段对话。';
  $('delete-video-error').textContent = ''; $('delete-video-dialog').showModal();
});
$('delete-video-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') { deleteVideoTarget = null; return; }
  event.preventDefault(); if (!deleteVideoTarget || conversationSwitching) return;
  $('confirm-delete-video').disabled = true;
  try {
    if (await manageVideoProject(deleteVideoTarget, 'delete')) { $('delete-video-dialog').close(); deleteVideoTarget = null; }
  } catch (error) { $('delete-video-error').textContent = error.message || '未能删除视频，请重试。'; }
  finally { $('confirm-delete-video').disabled = false; }
});
$('rename-conversation').addEventListener('click', () => {
  if (!conversationMenuTarget) return;
  dialogTarget = conversationMenuTarget; closeConversationMenu();
  $('conversation-name-input').value = dialogTarget.chat.title; $('rename-error').textContent = '';
  $('rename-dialog').showModal(); $('conversation-name-input').focus(); $('conversation-name-input').select();
});
$('rename-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault(); if (!dialogTarget) return;
  const title = $('conversation-name-input').value.trim(); if (!title) { $('rename-error').textContent = '请填写对话名称。'; return; }
  try {
    await save(); const state = await mutateConversations('renameConversation', dialogTarget.projectId, dialogTarget.chat.id, title);
    $('rename-dialog').close(); await reloadProjectAfterAction(dialogTarget.projectId, state); dialogTarget = null;
  } catch (error) { $('rename-error').textContent = error.message || '名称未能保存。'; }
});
$('delete-conversation').addEventListener('click', () => {
  if (!conversationMenuTarget) return;
  dialogTarget = conversationMenuTarget; closeConversationMenu();
  $('delete-chat-name').textContent = dialogTarget.chat.title; $('delete-error').textContent = '';
  $('delete-dialog').showModal();
});
$('delete-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault(); if (!dialogTarget) return;
  try {
    await save(); const { projectId, chat } = dialogTarget;
    const state = await mutateConversations('deleteConversation', projectId, chat.id);
    $('delete-dialog').close(); showDeleteUndo(projectId, chat); await reloadProjectAfterAction(projectId, state); dialogTarget = null;
  } catch (error) { $('delete-error').textContent = error.message || '对话未能删除。'; }
});
$('undo-delete-button').addEventListener('click', async () => {
  if (!undoDeletion) return;
  try {
    const { projectId, chat } = undoDeletion, state = await mutateConversations('restoreConversation', projectId, chat);
    clearTimeout(undoTimer); $('undo-delete').hidden = true; undoDeletion = null;
    await reloadProjectAfterAction(projectId, state);
  } catch (error) { notice(error.message || '对话未能恢复。'); }
});
document.addEventListener('pointerdown', event => { if (!event.target.closest('#conversation-menu,.conversation-more')) closeConversationMenu(); });
document.addEventListener('pointerdown', event => { if (!event.target.closest('#project-menu,.project-more')) closeProjectMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('project-menu').hidden) { event.preventDefault(); closeProjectMenu(); return; }
  if (!$('project-menu').hidden && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault(); const buttons = Array.from($('project-menu').querySelectorAll('button'));
    const index = buttons.indexOf(document.activeElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); return;
  }
  if (event.key === 'Escape' && !$('conversation-menu').hidden) { event.preventDefault(); closeConversationMenu(); return; }
  if (event.key === 'Escape' && innerWidth <= 1150 && document.body.classList.contains('sidebar-open') && !document.querySelector('dialog[open]')) { setSidebar(false); $('sidebar-toggle').focus(); }
  if (!$('conversation-menu').hidden && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault(); const buttons = Array.from($('conversation-menu').querySelectorAll('button'));
    const index = buttons.indexOf(document.activeElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
  }
});
let compactSidebar = innerWidth <= 1150;
window.addEventListener('resize', () => {
  const compact = innerWidth <= 1150;
  if (compact !== compactSidebar) { compactSidebar = compact; setSidebar(!compact); }
  else $('sidebar-backdrop').hidden = !document.body.classList.contains('sidebar-open') || !compact;
  closeConversationMenu(); closeProjectMenu();
});
setSidebar(innerWidth > 1150);

async function refreshLibrary() {
  libraryEntries = await studyLibrary.list();
  libraryEntries.forEach(entry => setProjectState(entry.record.id, entry.state)); renderLibrary();
}
async function openSavedVideo(record, requestedChatId = null) {
  if (busy || importing || libraryBooting || conversationSwitching) return;
  conversationSwitching = true; updateLibraryControls();
  try {
    await save(); await studyLibrary.flushed();
    const selected = await studyLibrary.getFile(record);
    const restored = await studyLibrary.getState(record.id, true);
    await loadVideo(selected, record, restored, requestedChatId);
  } catch (error) { notice(error.message || '未能打开保存的视频，请重新添加原文件。'); }
  finally { restoring = false; conversationSwitching = false; updateLibraryControls(); }
}
async function addVideos(selections) {
  if (busy || importing || libraryBooting) { notice('请等当前操作完成后再添加视频。'); return; }
  const candidates = selections.filter(selected => selected.type.startsWith('video/') ||
    /\.(mp4|webm|mkv|mov|m4v|avi|ogg|ogv)$/i.test(selected.name));
  if (!candidates.length) { notice('请选择视频文件。'); return; }
  importing = true; showArchivedVideos = false; updateLibraryControls(); $('import-status').hidden = false;
  let first = true, failures = 0, added = 0, duplicates = 0;
  studyLibrary.requestPersistence().then(persistent => {
    if (persistent) $('library-storage').textContent = '浏览器已允许持久保存。清除网站数据仍会删除视频和记录。';
  });
  try {
    for (const selected of candidates) {
      $('import-status').textContent = '正在保存 ' + selected.name + '…保存完成前请保留页面。';
      let record = null;
      try {
        const result = await studyLibrary.addVideo(selected); record = result.record;
        result.added ? added++ : duplicates++;
      } catch (error) { failures++; notice(storageFailure(error)); }
      if (first) { await loadVideo(selected, record); first = false; }
    }
    await studyLibrary.flushed();
    if (studyLibrary.available) await refreshLibrary();
    $('import-status').textContent = failures ? '部分视频未保存，请保留原文件并检查浏览器空间。' :
      added ? '视频项目已保存，可以在左侧切换课程和对话。' : '视频已在列表中，无需重复保存。';
    if (candidates.length > 1 && !failures) notice('已保存所选视频，当前打开第一段；可以在侧栏里切换项目。');
  } finally { importing = false; updateLibraryControls(); renderLibrary(); }
}
function saveCheckpoint() {
  if (!file && !messages.length && !$('question').value && !$('lesson-context').value) return;
  try { if (!restoring && !libraryBooting) studyLibrary.checkpoint(videoId(), videoState(), captureConversation()); }
  catch { if (!storageWarningShown) { storageWarningShown = true; notice('最后的进度快照未能保存，请检查浏览器空间。'); } }
}
async function initializeLibrary() {
  try {
    await studyLibrary.ready;
    const general = await ensureProjectState('study-player:general', storageRead('study-player:general') || {});
    applyConversation(general);
    await refreshLibrary();
    for (const entry of libraryEntries) {
      const state = await ensureProjectState(entry.record.id, entry.state);
      entry.state = state;
    }
    renderLibrary();
  } catch {
    await ensureProjectState(key, storageRead(key) || {}); applyConversation(projectStates.get(key));
    $('library-empty').textContent = '浏览器存储不可用。视频仍可播放，请保留原文件。';
    notice('浏览器存储不可用，暂时无法保存视频。');
  } finally { libraryBooting = false; updateLibraryControls(); }
  const active = libraryEntries.filter(entry => !entry.record.archivedAt).sort(compareLibraryEntries);
  if (active.length) await openSavedVideo(active[0].record);
}

$('open-file').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', () => { const files = Array.from($('file-input').files); $('file-input').value = ''; addVideos(files); });
document.addEventListener('dragenter', e => { if (!e.dataTransfer?.types.includes('Files')) return; e.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; });
document.addEventListener('dragover', e => { if (!e.dataTransfer?.types.includes('Files')) return; e.preventDefault(); e.dataTransfer.dropEffect = busy || importing || libraryBooting ? 'none' : 'copy'; });
document.addEventListener('dragleave', e => { if (!e.dataTransfer?.types.includes('Files')) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').hidden = true; });
document.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true; addVideos(Array.from(e.dataTransfer?.files || [])); });
video.addEventListener('loadedmetadata', () => {
  if (video.duration === Infinity) {
    detectingDuration = true; video.currentTime = 1e10;
    durationTimer = setTimeout(finishLoading, 5000);
  } else finishLoading();
});
video.addEventListener('durationchange', () => { if (detectingDuration && Number.isFinite(video.duration)) finishLoading(); else { setEnabled(); updateTransport(); } });
video.addEventListener('error', () => { loaded = false; setEnabled(); $('player-hint').textContent = '浏览器无法解码这个视频。可以换成 MP4（H.264）或 WebM。'; notice('无法播放这个视频，请换成浏览器支持的编码格式。'); });
video.addEventListener('timeupdate', () => { updateTransport(); if (Date.now() - lastSave > 5000) { save(); lastSave = Date.now(); } });
video.addEventListener('seeked', () => { updateTransport(); save(); });
video.addEventListener('play', playIcon); video.addEventListener('pause', () => { playIcon(); save(); }); video.addEventListener('ended', playIcon); video.addEventListener('volumechange', volumeIcon);
video.addEventListener('click', togglePlay); video.addEventListener('dblclick', fullscreen);
$('play').addEventListener('click', togglePlay); $('back').addEventListener('click', () => seek(-10)); $('forward').addEventListener('click', () => seek(10));
$('timeline').addEventListener('input', () => { if (loaded) video.currentTime = Number($('timeline').value) / 1000 * video.duration; updateTransport(); });
$('rate').addEventListener('input', () => setSpeed($('rate').value));
$('rate-label').addEventListener('click', toggleRatePopover);
$('rate-reset').addEventListener('click', () => setSpeed(1, true));
document.addEventListener('pointerdown', e => { if (!e.target.closest('.rate-control')) closeRatePopover(); });
document.addEventListener('focusin', e => { if (!e.target.closest('.rate-control')) closeRatePopover(); });
$('volume').addEventListener('input', () => { video.volume = Number($('volume').value); video.muted = false; });
$('mute').addEventListener('click', () => { video.muted = !video.muted; }); $('fullscreen').addEventListener('click', fullscreen);
$('pause-ask').addEventListener('click', pauseAsk); $('fullscreen-question').addEventListener('click', pauseAsk); $('retake').addEventListener('click', showFrame); $('attach-frame').addEventListener('change', showFrame);
$('question').addEventListener('focus', () => { if (loaded && !busy && !frame) { video.pause(); showFrame(); } });
function saveDraftSoon() { clearTimeout(draftSaveTimer); draftSaveTimer = setTimeout(save, 350); }
$('lesson-context').addEventListener('input', saveDraftSoon); $('question').addEventListener('input', saveDraftSoon); $('question-form').addEventListener('submit', sendQuestion);
$('cancel').addEventListener('click', () => { controller?.abort(); });
$('new-chat').addEventListener('click', createNewConversation);
$('help-open').addEventListener('click', () => $('help').showModal());
$('reconnect').addEventListener('click', async () => {
  if (!accessToken) { await configure(); return; }
  connectionStatus(false, '正在连接…');
  try { const response = await fetch('/api/reconnect', { method: 'POST', headers: { 'X-Study-Token': accessToken } }); const data = await response.json(); if (!response.ok) throw new Error(); connectionStatus(data.ready, data.message); }
  catch { await configure(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('rate-popover').hidden) { e.preventDefault(); closeRatePopover(true); return; }
  const editable = e.target.closest('input,textarea,select,[contenteditable="true"]');
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target === $('question')) { e.preventDefault(); sendQuestion(); return; }
  if (editable || document.querySelector('dialog[open]') || e.target.closest('#project-sidebar,#conversation-menu,#project-menu') || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(-10); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seek(10); }
  else if (e.key === '[') { e.preventDefault(); shiftSpeed(-1); }
  else if (e.key === ']') { e.preventDefault(); shiftSpeed(1); }
  else if (e.key.toLowerCase() === 'f') { e.preventDefault(); fullscreen(); }
  else if (e.key.toLowerCase() === 'm') { e.preventDefault(); video.muted = !video.muted; }
  else if (e.key.toLowerCase() === 'q') { e.preventDefault(); pauseAsk(); }
});
window.addEventListener('beforeunload', () => { saveCheckpoint(); save(); controller?.abort(); if (objectURL) URL.revokeObjectURL(objectURL); });
window.addEventListener('pagehide', saveCheckpoint);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { saveCheckpoint(); save(); } });
const initial = storageRead(key); if (Array.isArray(initial?.messages)) messages = initial.messages.filter(x => x && ['user', 'assistant'].includes(x.role) && typeof x.text === 'string');
$('lesson-context').value = String(initial?.context || ''); $('question').value = String(initial?.draft || ''); video.volume = 0.8; setSpeed(initial?.rate || 1); renderMessages(); configure(); initializeLibrary();
