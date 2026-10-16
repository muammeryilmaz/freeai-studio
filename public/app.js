const els = {
  providerSelect: document.getElementById('providerSelect'),
  modelSelect: document.getElementById('modelSelect'),
  thinkingSelect: document.getElementById('thinkingSelect'),
  testModelsBtn: document.getElementById('testModelsBtn'),
  testStatus: document.getElementById('testStatus'),
  providerNote: document.getElementById('providerNote'),
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  sendBtn: document.getElementById('sendBtn'),
  newChatBtn: document.getElementById('newChatBtn'),
  chatList: document.getElementById('chatList'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsModal: document.getElementById('settingsModal'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  settingsRows: document.getElementById('settingsRows'),
  attachBtn: document.getElementById('attachBtn'),
  fileInput: document.getElementById('fileInput'),
  attachments: document.getElementById('attachments'),
  composerHint: document.getElementById('composerHint'),
  composerWrap: document.getElementById('composerWrap'),
  chatModeBadge: document.getElementById('chatModeBadge'),
  projectBtn: document.getElementById('projectBtn'),
  projectChip: document.getElementById('projectChip'),
  projectChipPath: document.getElementById('projectChipPath'),
  clearProjectBtn: document.getElementById('clearProjectBtn'),
  modeHint: document.getElementById('modeHint'),
  folderBrowseModal: document.getElementById('folderBrowseModal'),
  closeFolderBrowseBtn: document.getElementById('closeFolderBrowseBtn'),
  browserCurrentPath: document.getElementById('browserCurrentPath'),
  browserFolderList: document.getElementById('browserFolderList'),
  browserUpBtn: document.getElementById('browserUpBtn'),
  selectCurrentFolderBtn: document.getElementById('selectCurrentFolderBtn'),
};

const state = {
  providers: [],
  chats: JSON.parse(localStorage.getItem('aiconv.chats') || '[]'),
  currentChatId: null,
  provider: localStorage.getItem('aiconv.provider') || '',
  modelsByProvider: JSON.parse(localStorage.getItem('aiconv.models') || '{}'),
  selectedByProvider: JSON.parse(localStorage.getItem('aiconv.selected') || '{}'),
  sending: false,
  abort: null,
  modelStatus: JSON.parse(localStorage.getItem('aiconv.status') || '{}'),
  // { [provider]: { [model]: false } } — görsel kabul etmediği öğrenilen modeller
  noVision: JSON.parse(localStorage.getItem('aiconv.novision') || '{}'),
  projectPath: localStorage.getItem('aiconv.projectPath') || '',
  thinkingByModel: JSON.parse(localStorage.getItem('aiconv.thinking') || '{}'),
  pending: [],
};

// Eski sürümler yeni sohbetlere sabit Türkçe başlık yazıyordu; boş başlık "henüz adlandırılmadı" demektir.
const LEGACY_UNTITLED = 'Yeni sohbet';
const isUntitled = (chat) => !chat.title || chat.title === LEGACY_UNTITLED;

let testGeneration = 0;

function persist() {
  localStorage.setItem('aiconv.models', JSON.stringify(state.modelsByProvider));
  localStorage.setItem('aiconv.selected', JSON.stringify(state.selectedByProvider));
  localStorage.setItem('aiconv.status', JSON.stringify(state.modelStatus));
  localStorage.setItem('aiconv.novision', JSON.stringify(state.noVision));
  localStorage.setItem('aiconv.provider', state.provider);
  localStorage.setItem('aiconv.projectPath', state.projectPath || '');
  localStorage.setItem('aiconv.thinking', JSON.stringify(state.thinkingByModel));
  // Görseller localStorage'ı doldurabilir; dolarsa en eski sohbetlerden başlayarak görsel verisini at.
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      localStorage.setItem('aiconv.chats', JSON.stringify(state.chats));
      return;
    } catch {
      if (!dropOldestImage()) return;
    }
  }
}

function dropOldestImage() {
  for (let i = state.chats.length - 1; i >= 0; i--) {
    for (const msg of state.chats[i].messages) {
      for (const att of msg.attachments || []) {
        if (att.type === 'image' && att.dataUrl) {
          delete att.dataUrl;
          att.dropped = true;
          return true;
        }
      }
    }
  }
  return false;
}

function currentChat() {
  return state.chats.find((c) => c.id === state.currentChatId) || null;
}

function renderChatList() {
  els.chatList.innerHTML = '';
  for (const chat of state.chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === state.currentChatId ? ' active' : '');
    item.innerHTML = `<span class="title"></span><button class="delete" title="${t('common.delete')}">✕</button>`;
    item.querySelector('.title').textContent = isUntitled(chat) ? t('chat.untitled') : chat.title;
    item.addEventListener('click', () => {
      state.currentChatId = chat.id;
      renderAll();
    });
    item.querySelector('.delete').addEventListener('click', (e) => {
      e.stopPropagation();
      state.chats = state.chats.filter((c) => c.id !== chat.id);
      if (state.currentChatId === chat.id) state.currentChatId = null;
      persist();
      renderAll();
    });
    els.chatList.appendChild(item);
  }
}

function renderMessages() {
  const chat = currentChat();
  els.messages.innerHTML = '';
  if (!chat || chat.messages.length === 0) {
    els.messages.innerHTML = `
      <div class="empty-state">
        <h1>FreeAI Studio</h1>
        <p>${escapeHtml(t('chat.emptyHint'))}</p>
      </div>`;
    return;
  }
  for (const msg of chat.messages) {
    appendMessageEl(msg.notice ? 'notice' : msg.role, msg.content, msg.error, msg.attachments, msg.tools);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function describeToolCall(tool) {
  if (!tool) return t('tool.generic');
  const arg = tool.args?.path || tool.args?.command || tool.args?.pattern || '';
  return `${tool.name || t('tool.generic')}${arg ? ' · ' + String(arg).slice(0, 90) : ''}`;
}

function createToolChip(tool) {
  const details = document.createElement('details');
  details.className = 'tool-chip' + (tool.isError ? ' error' : tool.output !== undefined ? ' done' : ' running');
  const summary = document.createElement('summary');
  summary.textContent = `🔧 ${describeToolCall(tool)}${tool.isError ? t('tool.errorSuffix') : ''}`;
  details.appendChild(summary);
  if (tool.output) {
    const pre = document.createElement('pre');
    pre.textContent = String(tool.output).slice(0, 4000);
    details.appendChild(pre);
  }
  return details;
}

function appendMessageEl(role, content, isError, attachments, tools) {
  const row = document.createElement('div');
  row.className = 'msg-row ' + (isError ? 'error' : role);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (tools?.length) {
    const box = document.createElement('div');
    box.className = 'msg-tools';
    for (const tool of tools) box.appendChild(createToolChip(tool));
    bubble.appendChild(box);
  }
  if (attachments?.length) {
    const box = document.createElement('div');
    box.className = 'msg-atts';
    for (const att of attachments) {
      if (att.type === 'image' && att.dataUrl) {
        const img = document.createElement('img');
        img.src = att.dataUrl;
        img.title = att.name;
        img.addEventListener('click', () => window.open().document.write(`<img src="${att.dataUrl}" style="max-width:100%">`));
        box.appendChild(img);
      } else {
        const tag = document.createElement('span');
        tag.className = 'file-tag';
        tag.textContent = (att.type === 'image' ? '🖼 ' : '📄 ') + att.name + (att.dropped ? t('chat.imageDropped') : '');
        box.appendChild(tag);
      }
    }
    bubble.appendChild(box);
  }
  const body = document.createElement('div');
  if (role === 'user' || role === 'notice') body.textContent = content;
  else body.innerHTML = renderMarkdown(content);
  bubble.appendChild(body);
  row.appendChild(bubble);
  els.messages.appendChild(row);
  return body;
}

function renderAll() {
  renderChatList();
  renderMessages();
}

async function loadProviders() {
  const resp = await fetch('/api/providers');
  const data = await resp.json();
  state.providers = data.providers;
  els.providerSelect.innerHTML = '';
  for (const p of state.providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    els.providerSelect.appendChild(opt);
  }
  if (!state.providers.some((p) => p.id === state.provider)) {
    state.provider = state.providers[0]?.id || '';
  }
  els.providerSelect.value = state.provider;
  updateProviderNote();
  updateModeUi();
}

function updateProviderNote() {
  const p = state.providers.find((x) => x.id === state.provider);
  els.providerNote.textContent = p ? p.note || '' : '';
}

async function loadModels() {
  const providerId = state.provider;
  els.modelSelect.disabled = true;
  try {
    const resp = await fetch(`/api/models?provider=${encodeURIComponent(providerId)}`);
    const data = await resp.json();
    state.modelsByProvider[providerId] = data.models;
    persist();
    fillModelSelect(providerId);
  } catch {
    fillModelSelect(providerId);
  }
  els.modelSelect.disabled = false;
  await loadThinkingLevels();
}

function fillModelSelect(providerId) {
  const models = state.modelsByProvider[providerId] || [];
  els.modelSelect.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.id + (m.free ? t('model.free') : '');
    els.modelSelect.appendChild(opt);
  }
  const selected = state.selectedByProvider[providerId];
  if (selected && models.some((m) => m.id === selected)) {
    els.modelSelect.value = selected;
  } else if (models.length) {
    state.selectedByProvider[providerId] = models[0].id;
    els.modelSelect.value = models[0].id;
    persist();
  }
  applyModelColors(providerId);
}

function applyModelColors(providerId) {
  window.AiCommon.applyModelColorsToSelect(providerId, els.modelSelect, state.modelStatus[providerId] || {});
}

// --- THINKING (düşünme seviyesi) ---
const THINKING_LEVEL_IDS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const thinkingLabel = (level) => t(`thinking.${level}`);

function thinkingKey(provider, model) {
  return `${provider}|${model}`;
}

function hideThinkingSelect() {
  els.thinkingSelect.innerHTML = '';
  els.thinkingSelect.classList.add('hidden');
}

async function loadThinkingLevels() {
  const provider = state.provider;
  const model = els.modelSelect.value;
  if (!provider || !model) {
    hideThinkingSelect();
    return;
  }
  try {
    const resp = await fetch(`/api/thinking-levels?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`);
    const data = await resp.json();
    // Bu sırada model değiştiyse sonucu uygulama.
    if (provider !== state.provider || model !== els.modelSelect.value) return;
    const levels = (Array.isArray(data.levels) ? data.levels : []).filter((l) => THINKING_LEVEL_IDS.includes(l));
    if (!levels.length || (levels.length === 1 && levels[0] === 'off')) {
      hideThinkingSelect();
      return;
    }
    els.thinkingSelect.innerHTML = '';
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = t('thinking.default');
    els.thinkingSelect.appendChild(defOpt);
    for (const lv of levels) {
      const o = document.createElement('option');
      o.value = lv;
      o.textContent = t('thinking.option', { label: thinkingLabel(lv) });
      els.thinkingSelect.appendChild(o);
    }
    const stored = state.thinkingByModel[thinkingKey(provider, model)];
    els.thinkingSelect.value = levels.includes(stored) ? stored : '';
    els.thinkingSelect.title = t('thinking.title', { levels: levels.join(', ') });
    els.thinkingSelect.classList.remove('hidden');
  } catch {
    hideThinkingSelect();
  }
}

async function testOneModel(providerId, model) {
  try {
    const resp = await fetch('/api/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId, model }),
    });
    const data = await resp.json().catch(() => ({}));
    return data.ok ? { ok: true } : { ok: false, error: data.error || `HTTP ${resp.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function refreshModelList(providerId) {
  const oldIds = (state.modelsByProvider[providerId] || []).map((m) => m.id);
  const resp = await fetch(`/api/models?provider=${encodeURIComponent(providerId)}`);
  const data = await resp.json();
  state.modelsByProvider[providerId] = data.models;
  const newIds = data.models.map((m) => m.id);
  let note = '';
  if (oldIds.length) {
    const added = newIds.filter((id) => !oldIds.includes(id)).length;
    const removed = oldIds.filter((id) => !newIds.includes(id)).length;
    note = added || removed ? t('test.listDiff', { added, removed }) : t('test.listCurrent');
  }
  if (!state.modelStatus[providerId]) state.modelStatus[providerId] = {};
  for (const mid of Object.keys(state.modelStatus[providerId])) {
    if (!newIds.includes(mid)) delete state.modelStatus[providerId][mid];
  }
  fillModelSelect(providerId);
  await loadThinkingLevels();
  persist();
  return note;
}

async function testModels() {
  const providerId = state.provider;
  const gen = ++testGeneration;
  els.testModelsBtn.disabled = true;
  els.testStatus.textContent = t('test.refreshing');

  let listNote = '';
  try {
    listNote = await refreshModelList(providerId);
  } catch {}
  if (gen !== testGeneration) return;

  const models = (state.modelsByProvider[providerId] || []).map((m) => m.id);
  if (!models.length) {
    els.testModelsBtn.textContent = t('chat.testModels');
    els.testModelsBtn.disabled = false;
    els.testStatus.textContent = t('test.empty');
    return;
  }

  state.modelStatus[providerId] = {};
  applyModelColors(providerId);
  els.testStatus.textContent = listNote;
  const queue = [...models];
  let done = 0;

  const worker = async () => {
    while (queue.length) {
      if (gen !== testGeneration) return;
      const model = queue.shift();
      const st = await testOneModel(providerId, model);
      if (gen !== testGeneration) return;
      state.modelStatus[providerId][model] = st;
      done++;
      els.testModelsBtn.textContent = t('test.progress', { done, total: models.length });
      applyModelColors(providerId);
      persist();
    }
  };

  await Promise.all(Array.from({ length: 4 }, worker));
  if (gen !== testGeneration) return;

  const fails = models.filter((m) => state.modelStatus[providerId][m] && !state.modelStatus[providerId][m].ok).length;
  els.testModelsBtn.textContent = t('chat.testModels');
  els.testModelsBtn.disabled = false;
  const summary = fails ? t('test.summaryFail', { ok: models.length - fails, fail: fails }) : t('test.summaryOk', { n: models.length });
  els.testStatus.textContent = [listNote, summary].filter(Boolean).join(' · ');
  persist();
}

function newChat() {
  const chat = {
    id: String(Date.now()),
    title: '',
    provider: state.provider,
    model: state.selectedByProvider[state.provider] || '',
    messages: [],
  };
  state.chats.unshift(chat);
  state.currentChatId = chat.id;
  persist();
  renderAll();
  els.input.focus();
}

function toApiMessages(messages, allowImages) {
  return messages
    .filter((m) => !m.error && !m.notice)
    .map((m) => {
      const atts = m.attachments || [];
      if (!atts.length) return { role: m.role, content: m.content };
      let text = m.content || '';
      for (const att of atts.filter((a) => a.type === 'file')) {
        text += `\n\n${t('chat.attachedFile', { name: att.name })}\n\`\`\`\n${att.text}\n\`\`\``;
      }
      const images = atts.filter((a) => a.type === 'image' && a.dataUrl);
      if (!images.length) return { role: m.role, content: text.trim() };
      if (!allowImages) {
        text += `\n\n${t('chat.imagesNotSent', { n: images.length })}`;
        return { role: m.role, content: text.trim() };
      }
      return {
        role: m.role,
        content: [
          { type: 'text', text: text.trim() || t('chat.lookAtImages') },
          ...images.map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } })),
        ],
      };
    });
}

function isNoVision(provider, model) {
  return Boolean(state.noVision[provider]?.[model]);
}

function addNotice(chat, text, beforeEl) {
  chat.messages.push({ role: 'assistant', content: text, notice: true });
  const row = document.createElement('div');
  row.className = 'msg-row notice';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.appendChild(bubble);
  els.messages.insertBefore(row, beforeEl || null);
}

async function send() {
  if (state.sending) {
    state.abort?.abort();
    return;
  }
  const text = els.input.value.trim();
  if (!text && !state.pending.length) return;

  let chat = currentChat();
  if (!chat) {
    newChat();
    chat = currentChat();
  }

  const provider = state.provider;
  const model = els.modelSelect.value;
  if (!model) {
    appendMessageEl('assistant', t('chat.pickModelFirst'), true);
    return;
  }

  chat.provider = provider;
  chat.model = model;
  const attachments = state.pending;
  state.pending = [];
  renderPending();
  chat.messages.push({ role: 'user', content: text, ...(attachments.length ? { attachments } : {}) });
  if (isUntitled(chat)) chat.title = (text || attachments.map((a) => a.name).join(', ')).slice(0, 40);
  els.input.value = '';
  autoGrow();
  persist();
  renderAll();

  state.sending = true;
  els.sendBtn.textContent = t('chat.stop');
  els.sendBtn.classList.add('stop');

  const bubble = appendMessageEl('assistant', '');
  const bubbleRow = bubble.closest('.msg-row');
  let acc = '';
  state.abort = new AbortController();

  const piMode = isPiMode();
  const knownNoVision = !piMode && isNoVision(provider, model);
  if (knownNoVision && attachments.some((a) => a.type === 'image')) {
    addNotice(chat, t('chat.noVisionKnown', { model }), bubbleRow);
  }

  // Pi modu: araç çağrıları balonun üstünde çip olarak gösterilir.
  const toolCalls = [];
  let toolsBox = null;
  let currentToolChip = null;
  if (piMode) {
    toolsBox = document.createElement('div');
    toolsBox.className = 'msg-tools';
    bubble.prepend(toolsBox);
  }

  try {
    const resp = await fetch(piMode ? '/api/pi/chat' : '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        piMode
          ? { chatId: chat.id, message: text, projectPath: state.projectPath || null, provider, model, attachments, thinking: els.thinkingSelect.value || undefined }
          : { provider, model, messages: toApiMessages(chat.messages, !knownNoVision), thinking: els.thinkingSelect.value || undefined },
      ),
      signal: state.abort.signal,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || t('common.errorStatus', { status: resp.status }));
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (piMode) {
          if (chunk.type === 'delta') {
            acc += chunk.delta || '';
            bubble.innerHTML = renderMarkdown(acc);
            if (toolsBox) bubble.prepend(toolsBox);
            els.messages.scrollTop = els.messages.scrollHeight;
          } else if (chunk.type === 'tool_start') {
            const call = { name: chunk.tool?.name, args: chunk.tool?.args || {}, output: undefined, isError: false };
            toolCalls.push(call);
            currentToolChip = createToolChip(call);
            toolsBox.appendChild(currentToolChip);
            els.messages.scrollTop = els.messages.scrollHeight;
          } else if (chunk.type === 'tool_end') {
            const last = toolCalls[toolCalls.length - 1];
            if (last) {
              last.isError = Boolean(chunk.tool?.isError);
              last.output = chunk.tool?.output || '';
              const fresh = createToolChip(last);
              if (currentToolChip) {
                currentToolChip.replaceWith(fresh);
                currentToolChip = fresh;
              }
            }
          } else if (chunk.type === 'done') {
            acc = chunk.text || acc;
            bubble.innerHTML = renderMarkdown(acc || t('chat.emptyReply'));
            if (toolsBox) bubble.prepend(toolsBox);
          } else if (chunk.type === 'error') {
            throw new Error(chunk.message || t('chat.piError'));
          }
          continue;
        }
        if (chunk.notice) {
          if (chunk.notice.type === 'vision_unsupported') {
            (state.noVision[provider] ||= {})[model] = true;
            updateComposerHint();
          }
          addNotice(chat, chunk.notice.message, bubbleRow);
          continue;
        }
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) {
          acc += delta;
          bubble.innerHTML = renderMarkdown(acc);
          els.messages.scrollTop = els.messages.scrollHeight;
        }
      }
    }

    if (acc) chat.messages.push({ role: 'assistant', content: acc, ...(toolCalls.length ? { tools: toolCalls.map(serializeTool) } : {}) });
    else bubble.innerHTML = renderMarkdown(t('chat.emptyReply'));
  } catch (err) {
    const msg = err.name === 'AbortError' ? t('chat.stopped') : err.message;
    if (acc) chat.messages.push({ role: 'assistant', content: acc, ...(toolCalls.length ? { tools: toolCalls.map(serializeTool) } : {}) });
    chat.messages.push({ role: 'assistant', content: msg, error: true });
    renderMessages();
  } finally {
    state.sending = false;
    state.abort = null;
    els.sendBtn.textContent = t('common.send');
    els.sendBtn.classList.remove('stop');
    persist();
  }
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 180) + 'px';
}

// --- PI MODU / PROJE KLASÖRÜ ---
function isPiMode() {
  return Boolean(state.projectPath) || String(state.provider).startsWith('pi:');
}

function serializeTool(tool) {
  return { name: tool.name, args: tool.args, output: String(tool.output || '').slice(0, 600), isError: Boolean(tool.isError) };
}

function updateModeUi() {
  const pi = isPiMode();
  const piProvider = String(state.provider).startsWith('pi:');
  els.chatModeBadge.textContent = pi ? t('chat.modePi') : t('chat.modeNormal');
  els.chatModeBadge.className = 'mode-badge ' + (pi ? 'pi' : 'normal');
  els.chatModeBadge.title = pi ? t('chat.modePiTitle') : t('chat.modeNormalTitle');
  els.projectChip.classList.toggle('hidden', !state.projectPath);
  els.projectChipPath.textContent = state.projectPath;
  els.projectChip.title = state.projectPath;
  els.projectBtn.classList.toggle('hidden', Boolean(state.projectPath));
  els.testModelsBtn.disabled = piProvider;
  els.testModelsBtn.title = piProvider ? t('chat.piNoTest') : '';
  if (pi) {
    els.modeHint.textContent = state.projectPath ? t('chat.hintProject') : t('chat.hintPiNoProject');
  } else {
    els.modeHint.textContent = '';
  }
  updateComposerHint();
}

// Klasör gezgini (ekip sayfasındakiyle aynı mantık)
let browserPath = '';
function openFolderBrowser(targetPath) {
  fetch(`/api/fs/browse?path=${encodeURIComponent(targetPath || '')}`)
    .then((r) => r.json())
    .then((data) => {
      if (!data.ok) throw new Error(data.error);
      browserPath = data.current;
      els.browserCurrentPath.textContent = data.current;
      els.browserFolderList.innerHTML = '';
      if (!data.dirs.length) {
        els.browserFolderList.innerHTML = `<span style="font-size:12px; color:var(--text-dim); padding:6px;">${escapeHtml(t('folder.empty'))}</span>`;
      } else {
        for (const dir of data.dirs) {
          const item = document.createElement('div');
          item.className = 'folder-item';
          item.innerHTML = `<span>📁</span> <span>${escapeHtml(dir)}</span>`;
          item.addEventListener('dblclick', () => {
            const next = browserPath.endsWith('\\') || browserPath.endsWith('/') ? `${browserPath}${dir}` : `${browserPath}\\${dir}`;
            openFolderBrowser(next);
          });
          item.addEventListener('click', () => {
            document.querySelectorAll('.folder-item').forEach((e) => (e.style.background = ''));
            item.style.background = 'var(--bg-input)';
          });
          els.browserFolderList.appendChild(item);
        }
      }
      els.folderBrowseModal.classList.remove('hidden');
    })
    .catch((e) => alert(t('folder.error', { error: e.message })));
}

async function selectProjectFolder(p) {
  if (!p) return;
  const resp = await fetch('/api/fs/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p }),
  });
  const d = await resp.json();
  if (!d.ok) {
    alert(t('folder.invalid', { error: d.error }));
    return;
  }
  state.projectPath = d.path;
  persist();
  updateModeUi();
}

async function openSettings() {
  const resp = await fetch('/api/settings');
  const data = await resp.json();
  els.settingsRows.innerHTML = '';
  for (const p of state.providers) {
    if (p.pi) continue; // Pi üyelikleri aşağıdaki özel bölümde gösterilir
    const row = document.createElement('div');
    row.className = 'setting-row';
    const keyUrl = p.keyUrl || '';
    const keyDisplay = keyUrl ? keyUrl.replace(/^https?:\/\//, '') : '';
    const keyLink = keyUrl
      ? `<span class="key-src">${t('settings.keyLabel')} <a href="${escapeHtml(keyUrl)}" target="_blank" rel="noopener">${escapeHtml(keyDisplay)}</a></span>`
      : '';
    row.innerHTML = `
      <div class="row-head">
        <label>${escapeHtml(p.label)}</label>
        ${keyLink}
      </div>
      <div class="row-input">
        <input type="password" placeholder="${data.keys[p.id] ? t('settings.savedPlaceholder') : p.noKey ? t('settings.noKeyPlaceholder') : t('settings.keyPlaceholder')}" />
        <button class="mini-btn save">${t('common.save')}</button>
        <button class="mini-btn clear">${t('common.delete')}</button>
      </div>
      <span class="key-status">${data.keys[p.id] ? t('settings.saved') : p.noKey ? t('settings.noKeyNeeded') : ''}</span>`;
    const input = row.querySelector('input');
    row.querySelector('.save').addEventListener('click', () => saveKey(p.id, input, row));
    row.querySelector('.clear').addEventListener('click', () => saveKey(p.id, { value: '' }, row));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveKey(p.id, input, row);
    });
    els.settingsRows.appendChild(row);
  }
  await window.AiCommon.renderPiSettings(els.settingsRows, {
    onChange: async () => {
      await loadProviders();
      updateModeUi();
    },
  });
  els.settingsModal.classList.remove('hidden');
}

async function saveKey(provider, input, row) {
  const resp = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key: input.value }),
  });
  const data = await resp.json();
  input.value = '';
  row.querySelector('.key-status').textContent = data.keySet ? t('settings.saved') : t('settings.deleted');
  if (data.keySet) loadModels();
}

async function addFiles(files) {
  const errors = [];
  for (const file of files) {
    try {
      state.pending.push(await window.AiCommon.fileToAttachment(file));
    } catch (err) {
      errors.push(err.message);
    }
  }
  renderPending();
  if (errors.length) els.composerHint.textContent = errors.join(' · ');
}

function renderPending() {
  els.attachments.innerHTML = '';
  state.pending.forEach((att, i) => {
    const chip = document.createElement('div');
    chip.className = 'att-chip';
    chip.innerHTML = att.type === 'image' ? '<img alt="" />' : '<span class="file-icon">📄</span>';
    if (att.type === 'image') chip.querySelector('img').src = att.dataUrl;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = att.name;
    name.title = att.name;
    chip.appendChild(name);
    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '✕';
    rm.title = t('common.remove');
    rm.addEventListener('click', () => {
      state.pending.splice(i, 1);
      renderPending();
    });
    chip.appendChild(rm);
    els.attachments.appendChild(chip);
  });
  updateComposerHint();
}

function updateComposerHint() {
  const hasImage = state.pending.some((a) => a.type === 'image');
  const model = els.modelSelect.value;
  els.composerHint.textContent = hasImage && isNoVision(state.provider, model) ? t('chat.noVisionHint', { model }) : '';
}

els.attachBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  addFiles([...els.fileInput.files]);
  els.fileInput.value = '';
});
els.input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});
['dragenter', 'dragover'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    els.composerWrap.classList.add('dragover');
  }),
);
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) els.composerWrap.classList.remove('dragover');
});
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  els.composerWrap.classList.remove('dragover');
  addFiles([...e.dataTransfer.files]);
});

els.sendBtn.addEventListener('click', send);
els.testModelsBtn.addEventListener('click', testModels);
els.newChatBtn.addEventListener('click', newChat);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
els.input.addEventListener('input', autoGrow);
els.providerSelect.addEventListener('change', () => {
  testGeneration++;
  els.testModelsBtn.disabled = false;
  els.testModelsBtn.textContent = t('chat.testModels');
  els.testStatus.textContent = '';
  state.provider = els.providerSelect.value;
  persist();
  updateProviderNote();
  loadModels();
  updateModeUi();
});
els.modelSelect.addEventListener('change', () => {
  state.selectedByProvider[state.provider] = els.modelSelect.value;
  persist();
  updateComposerHint();
  loadThinkingLevels();
});
els.thinkingSelect.addEventListener('change', () => {
  const key = thinkingKey(state.provider, els.modelSelect.value);
  const value = els.thinkingSelect.value;
  if (value) state.thinkingByModel[key] = value;
  else delete state.thinkingByModel[key];
  persist();
});
els.settingsBtn.addEventListener('click', openSettings);
els.closeSettingsBtn.addEventListener('click', () => els.settingsModal.classList.add('hidden'));
els.settingsModal.addEventListener('click', (e) => {
  if (e.target === els.settingsModal) els.settingsModal.classList.add('hidden');
});

// Proje klasörü seçimi
els.projectBtn.addEventListener('click', () => openFolderBrowser(state.projectPath || ''));
els.clearProjectBtn.addEventListener('click', () => {
  state.projectPath = '';
  persist();
  updateModeUi();
});
els.closeFolderBrowseBtn.addEventListener('click', () => els.folderBrowseModal.classList.add('hidden'));
els.folderBrowseModal.addEventListener('click', (e) => {
  if (e.target === els.folderBrowseModal) els.folderBrowseModal.classList.add('hidden');
});
els.browserUpBtn.addEventListener('click', () => {
  if (!browserPath) return;
  const parts = browserPath.split(/[\\/]/);
  if (parts.length > 1) {
    parts.pop();
    openFolderBrowser(parts.join('\\') || parts.join('/'));
  }
});
els.selectCurrentFolderBtn.addEventListener('click', async () => {
  await selectProjectFolder(browserPath);
  els.folderBrowseModal.classList.add('hidden');
});

renderMessages();
(async function init() {
  await loadProviders();
  await loadModels();
  renderAll();
  updateModeUi();
})();

window.aiConv = {
  state,
  renderMarkdown,
  fileToAttachment: window.AiCommon.fileToAttachment,
  applyModelColors,
  persist,
  loadModels,
};
