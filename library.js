'use strict';
window.studyLibrary = (() => {
  const db = new Dexie('study-player-library');
  db.version(1).stores({
    videos: 'id,&fingerprint,addedAt',
    files: 'id',
    events: 'id,videoId,[videoId+stamp]'
  });
  const cache = new Map();
  const journalPrefix = 'study-player:library-checkpoint:';
  const lastCheckpoint = new Map();
  const deletedVideos = new Set();
  let sequence = Date.now(), queue = Promise.resolve(), available = false;
  function stamp() { sequence = Math.max(Date.now(), sequence + 1); return sequence; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function ordered(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }
  function merge(events) {
    const result = {};
    for (const event of events.sort((a, b) => a.stamp - b.stamp || a.id.localeCompare(b.id))) {
      Object.assign(result, event.change);
      result.updatedAt = event.stamp;
    }
    return result;
  }
  async function getState(videoId, fresh = false) {
    if (!fresh && cache.has(videoId)) return clone(cache.get(videoId));
    const events = await db.events.where('videoId').equals(videoId).toArray();
    const state = merge(events);
    cache.set(videoId, state);
    return clone(state);
  }

  function visibleConversations(state) {
    const removed = state.deletedConversationIds || {};
    return (Array.isArray(state.conversations) ? state.conversations : [])
      .filter(chat => chat && typeof chat.id === 'string' && !Object.hasOwn(removed, chat.id));
  }
  function cleanMessages(messages) {
    return (Array.isArray(messages) ? messages : []).filter(message =>
      message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string');
  }
  function titleFromMessages(messages) {
    const first = cleanMessages(messages).find(message => message.role === 'user');
    return first ? Array.from(first.text.trim().replace(/\s+/g, ' ')).slice(0, 42).join('') || '新对话' : '新对话';
  }
  function makeConversation(projectId, fields = {}) {
    const now = stamp(), messages = cleanMessages(fields.messages);
    return {
      id: fields.id || crypto.randomUUID(), projectId,
      title: fields.title || titleFromMessages(messages), titleMode: fields.titleMode || 'auto',
      createdAt: fields.createdAt || now, updatedAt: fields.updatedAt || now,
      messages, draft: String(fields.draft || ''), context: String(fields.context || '')
    };
  }
  async function mutateProjectNow(projectId, producer) {
    return db.transaction('rw', db.events, async () => {
      const current = await getState(projectId, true);
      if (current.videoDeletedAt) {
        const error = new Error('这个视频项目已被删除，请重新添加视频。'); error.code = 'VIDEO_DELETED'; throw error;
      }
      const fields = producer(clone(current)) || {};
      const change = {};
      for (const [key, value] of Object.entries(fields)) {
        if (JSON.stringify(current[key]) !== JSON.stringify(value)) change[key] = value;
      }
      if (!Object.keys(change).length) return current;
      const event = { id: crypto.randomUUID(), videoId: projectId, stamp: stamp(), change };
      await db.events.add(event);
      const state = { ...current, ...change, updatedAt: event.stamp };
      cache.set(projectId, state);
      return clone(state);
    });
  }
  function mutateProject(projectId, producer) {
    return ordered(async () => { await ready; return mutateProjectNow(projectId, producer); });
  }
  function ensureConversations(projectId, fallback = {}) {
    return mutateProject(projectId, current => {
      if (current.conversationVersion === 1) return {};
      const legacy = { ...fallback, ...current };
      const messages = cleanMessages(legacy.messages), draft = String(legacy.draft || ''), context = String(legacy.context || '');
      const chats = visibleConversations(current);
      if (!chats.length && (messages.length || draft || context)) {
        chats.push(makeConversation(projectId, { messages, draft, context, updatedAt: legacy.updatedAt }));
      }
      return { conversations: chats, activeConversationId: chats[0]?.id || null,
        deletedConversationIds: current.deletedConversationIds || {}, conversationVersion: 1 };
    });
  }
  function createConversation(projectId) {
    const chat = makeConversation(projectId);
    return mutateProject(projectId, current => ({
      conversations: [...visibleConversations(current), chat], activeConversationId: chat.id, conversationVersion: 1
    }));
  }
  function selectConversation(projectId, id) {
    return mutateProject(projectId, current => {
      if (!visibleConversations(current).some(chat => chat.id === id)) throw new Error('这段对话已被删除。');
      return { activeConversationId: id };
    });
  }
  function saveConversation(projectId, value) {
    const snapshot = clone(value);
    return mutateProject(projectId, current => {
      if (snapshot.projectId !== projectId) throw new Error('对话与视频项目不匹配。');
      if (Object.hasOwn(current.deletedConversationIds || {}, snapshot.id)) {
        const error = new Error('这段对话已被删除，请打开其他对话。'); error.code = 'CHAT_DELETED'; throw error;
      }
      const chats = visibleConversations(current), index = chats.findIndex(chat => chat.id === snapshot.id);
      const existing = index >= 0 ? chats[index] : makeConversation(projectId, snapshot);
      const next = { ...existing, messages: cleanMessages(snapshot.messages),
        draft: String(snapshot.draft || ''), context: String(snapshot.context || '') };
      if (next.titleMode !== 'manual') next.title = titleFromMessages(next.messages);
      if (index >= 0 && JSON.stringify(next) === JSON.stringify(existing)) return {};
      next.updatedAt = stamp();
      if (index >= 0) chats[index] = next; else chats.push(next);
      return { conversations: chats, activeConversationId: snapshot.id, conversationVersion: 1 };
    });
  }
  function renameConversation(projectId, id, title) {
    const name = title.trim().slice(0, 80);
    if (!name) return Promise.reject(new Error('请填写对话名称。'));
    return mutateProject(projectId, current => {
      const chats = visibleConversations(current), chat = chats.find(chat => chat.id === id);
      if (!chat) throw new Error('这段对话已被删除。');
      chat.title = name; chat.titleMode = 'manual'; chat.updatedAt = stamp();
      return { conversations: chats };
    });
  }
  function deleteConversation(projectId, id) {
    return mutateProject(projectId, current => {
      const chats = visibleConversations(current);
      const remaining = chats.filter(chat => chat.id !== id).sort((a, b) => b.updatedAt - a.updatedAt);
      return { conversations: remaining, deletedConversationIds: { ...current.deletedConversationIds, [id]: stamp() },
        activeConversationId: current.activeConversationId === id ? remaining[0]?.id || null : current.activeConversationId,
        conversationVersion: 1 };
    });
  }
  function restoreConversation(projectId, value) {
    const restored = clone(value);
    return mutateProject(projectId, current => {
      if (restored.projectId !== projectId) throw new Error('对话与视频项目不匹配。');
      const deleted = { ...current.deletedConversationIds }; delete deleted[restored.id];
      const chats = visibleConversations(current).filter(chat => chat.id !== restored.id);
      restored.updatedAt = stamp(); chats.push(restored);
      return { conversations: chats, deletedConversationIds: deleted, activeConversationId: restored.id };
    });
  }
  async function recoverCheckpoints() {
    let keys;
    try { keys = Object.keys(localStorage).filter(key => key.startsWith(journalPrefix)); }
    catch { return; }
    const entries = [];
    for (const key of keys) {
      try {
        const event = JSON.parse(localStorage.getItem(key));
        if (event && typeof event.id === 'string' && typeof event.videoId === 'string' &&
          Number.isFinite(event.stamp) && event.change && typeof event.change === 'object') entries.push(event);
      } catch {}
    }
    for (const event of entries.sort((a, b) => a.stamp - b.stamp)) {
      if (await db.events.get(event.id)) continue;
      await db.transaction('rw', db.events, async () => {
        const current = await getState(event.videoId, true), snapshot = event.conversationSnapshot;
        if (current.videoDeletedAt) {
          deletedVideos.add(event.videoId);
          localStorage.removeItem(journalPrefix + event.id);
          return;
        }
        const change = { ...event.change };
        if (snapshot && snapshot.projectId === event.videoId && typeof snapshot.id === 'string' &&
            !Object.hasOwn(current.deletedConversationIds || {}, snapshot.id)) {
          const chats = visibleConversations(current), existing = chats.find(chat => chat.id === snapshot.id);
          if (!existing || (snapshot.updatedAt || event.stamp) > existing.updatedAt) {
            const restored = makeConversation(event.videoId, snapshot);
            change.conversations = [...chats.filter(chat => chat.id !== restored.id), restored];
            change.conversationVersion = 1;
            if (event.stamp >= (current.updatedAt || 0)) change.activeConversationId = restored.id;
          }
        }
        await db.events.add({ ...event, change });
        cache.delete(event.videoId);
      });
    }
  }

  const ready = db.open().then(async () => {
    await recoverCheckpoints();
    available = true;
    return true;
  });
  // The app handles unavailable browser storage without preventing playback.
  ready.catch(() => {});
  async function fingerprint(file) {
    const edge = 1024 * 1024;
    const sample = new Blob([
      JSON.stringify([file.name, file.size, file.lastModified]),
      file.slice(0, edge),
      file.size > edge ? file.slice(Math.max(edge, file.size - edge)) : ''
    ]);
    const hash = await crypto.subtle.digest('SHA-256', await sample.arrayBuffer());
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function addVideo(file) {
    await ready;
    const signature = await fingerprint(file);
    const previous = await db.videos.where('fingerprint').equals(signature).first();
    if (previous) return { record: previous.archivedAt ? await setVideoArchived(previous.id, false) : previous, added: false };
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    if (estimate?.quota && file.size > Math.max(0, estimate.quota - (estimate.usage || 0))) {
      const error = new Error('浏览器剩余存储空间不足，视频没有保存；可以继续观看，关闭后需重新选择文件。');
      error.name = 'QuotaExceededError'; throw error;
    }
    const record = {
      id: crypto.randomUUID(), fingerprint: signature, name: file.name,
      size: file.size, type: file.type, lastModified: file.lastModified,
      legacyKey: 'study-player:video:' + file.name + ':' + file.size + ':' + file.lastModified,
      addedAt: stamp()
    };
    try {
      await db.transaction('rw', db.videos, db.files, async () => {
        await db.files.add({ id: record.id, blob: file });
        await db.videos.add(record);
      });
    } catch (error) {
      if (error.name === 'ConstraintError') {
        const duplicate = await db.videos.where('fingerprint').equals(signature).first();
        if (duplicate) return { record: duplicate, added: false };
      }
      throw error;
    }
    return { record, added: true };
  }
  async function getFile(record) {
    await ready;
    const data = await db.files.get(record.id);
    if (!data?.blob) throw new Error('未找到保存的视频，请重新添加原文件。');
    return new File([data.blob], record.name, { type: record.type, lastModified: record.lastModified });
  }
  async function list() {
    await ready;
    const records = await db.videos.toArray();
    return Promise.all(records.map(async record => ({ record, state: await getState(record.id, true) })));
  }
  function setVideoArchived(id, archived) {
    return ordered(async () => {
      await ready;
      return db.transaction('rw', db.videos, async () => {
        const record = await db.videos.get(id);
        if (!record) throw new Error('这个视频已被删除，请刷新列表。');
        record.archivedAt = archived ? stamp() : null;
        await db.videos.put(record);
        return record;
      });
    });
  }
  function removeVideoCheckpoints(ids) {
    const targets = new Set(ids);
    for (const key of Object.keys(localStorage)) {
      if (targets.has(key)) { localStorage.removeItem(key); continue; }
      if (!key.startsWith(journalPrefix)) continue;
      try {
        const event = JSON.parse(localStorage.getItem(key));
        if (targets.has(event?.videoId) || targets.has(event?.conversationSnapshot?.projectId)) localStorage.removeItem(key);
      } catch (error) { if (error.name !== 'SyntaxError') throw error; }
    }
  }
  function deleteVideo(id) {
    return ordered(async () => {
      await ready;
      const ids = await db.transaction('rw', db.videos, db.files, db.events, async () => {
        const record = await db.videos.get(id);
        if (!record) throw new Error('这个视频已被删除，请刷新列表。');
        const targets = [...new Set([id, record.legacyKey].filter(Boolean))];
        await db.files.delete(id);
        await db.videos.delete(id);
        await db.events.where('videoId').anyOf(targets).delete();
        for (const target of targets) {
          await db.events.add({ id: crypto.randomUUID(), videoId: target, stamp: stamp(),
            change: { videoDeletedAt: stamp(), conversationVersion: 1 } });
        }
        return targets;
      });
      for (const target of ids) { deletedVideos.add(target); cache.delete(target); lastCheckpoint.delete(target); }
      let cleanupComplete = true;
      try { removeVideoCheckpoints(ids); } catch { cleanupComplete = false; }
      return { ids, cleanupComplete };
    });
  }
  function saveState(videoId, value) {
    const snapshot = clone(value);
    return mutateProject(videoId, () => snapshot);
  }
  function checkpoint(videoId, value, conversation = null) {
    if (deletedVideos.has(videoId)) return;
    const signature = JSON.stringify([value, conversation]);
    if (lastCheckpoint.get(videoId) === signature) return;
    const event = { id: crypto.randomUUID(), videoId, stamp: stamp(), change: clone(value) };
    if (conversation) event.conversationSnapshot = { ...clone(conversation), updatedAt: event.stamp };
    // A unique entry preserves the last instant on page close without overwriting old data.
    localStorage.setItem(journalPrefix + event.id, JSON.stringify(event));
    lastCheckpoint.set(videoId, signature);
  }
  async function requestPersistence() {
    try { return await navigator.storage?.persist?.() || false; } catch { return false; }
  }
  return { ready, addVideo, getFile, getState, list, saveState, checkpoint, requestPersistence,
    setVideoArchived, deleteVideo,
    visibleConversations, makeConversation, ensureConversations, createConversation, selectConversation,
    saveConversation, renameConversation, deleteConversation, restoreConversation,
    flushed: () => queue, get available() { return available; } };
})();
