const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { requestLang, normalizeLang, msg, pick } = require('./i18n.js');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3456;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.FREEAI_DATA_DIR || path.join(__dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

const NON_CHAT_RE = /whisper|tts|embed|rerank|moderat|guard|classifier|safety|punctuat|diariz|transcribe|scribe|voice|audio|music|image|video|flux|seedance|seedream|wan-\d|veo|lyria|kokoro|dreamshaper|recraft|ideogram|trellis|rodin|midijourney|realtime|glimmer|muse-|stem|asset-harvester|elevenlabs|eleven-|fish-audio|assemblyai|sesame|krea|prunaai|hyper3d|lykon|tongyi-mai|stability-ai|canopylabs|orpheus/i;

const PROVIDERS = {
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    note: { tr: 'Kalıcı ücretsiz katman, hız sınırı var.', en: 'Permanent free tier, rate limited.' },
    fallbackModels: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3-32b',
      'moonshotai/kimi-k2-instruct',
      'deepseek-r1-distill-llama-70b',
    ],
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyUrl: 'https://cloud.cerebras.ai/',
    note: { tr: 'Ücretsiz katman, çok hızlı; hız/dakika sınırı var.', en: 'Free tier, very fast; per-minute rate limits.' },
    fallbackModels: [
      'llama-3.3-70b',
      'llama3.1-8b',
      'qwen-3-32b',
      'gpt-oss-120b',
      'deepseek-r1-distill-llama-70b',
    ],
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    note: { tr: 'AI Studio anahtarıyla günlük ücretsiz kota.', en: 'Daily free quota with an AI Studio key.' },
    fallbackModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    note: { tr: 'API için "Free mode" (Experiment plan) aktivasyonu gerekir, kredi kartı istenmez.', en: 'Requires activating "Free mode" (Experiment plan) for the API; no credit card needed.' },
    fallbackModels: ['mistral-small-latest', 'open-mistral-nemo', 'codestral-latest'],
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    note: { tr: ':free ile biten modeller ücretsiz (günlük istek sınırı var).', en: 'Models ending in :free are free (daily request limit).' },
    fallbackModels: [
      'deepseek/deepseek-chat-v3-0324:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'google/gemma-3-27b-it:free',
      'qwen/qwen3-235b-a22b:free',
    ],
  },
  nvidia: {
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyUrl: 'https://build.nvidia.com/',
    note: { tr: 'Kayıt olunca deneme kredisi verilir (sınırlı süre).', en: 'Trial credits on sign-up (limited time).' },
    fallbackModels: [
      'meta/llama-3.3-70b-instruct',
      'deepseek-ai/deepseek-r1',
      'mistralai/mistral-large-2-instruct',
      'moonshotai/kimi-k2-instruct',
    ],
  },
  cohere: {
    label: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    note: { tr: 'Command/Aya modelleri ücretsiz katmanda (~1.000 istek/ay).', en: 'Command/Aya models on the free tier (~1,000 requests/month).' },
    fallbackModels: ['command-a-03-2025', 'command-r-plus', 'command-r', 'aya-expanse-32b', 'aya-expanse-8b'],
  },
  unorouter: {
    label: 'UnoRouter',
    baseUrl: 'https://api.unorouter.com/v1',
    keyUrl: 'https://unorouter.com/token',
    note: { tr: ':free modeller kalıcı ücretsiz; model başına ~1 RPM hız sınırı.', en: ':free models are permanently free; ~1 RPM rate limit per model.' },
    fallbackModels: [],
  },
  pollinations: {
    label: 'Pollinations',
    baseUrl: 'https://text.pollinations.ai/openai',
    keyUrl: 'https://enter.pollinations.ai',
    note: { tr: 'Anahtar gerekmez; IP başına saatlik limit.', en: 'No key needed; hourly limit per IP.' },
    noKey: true,
    fixedModels: ['openai', 'openai-fast', 'openai-large', 'openai-reasoning', 'gemini', 'gemini-large', 'mistral', 'llama'],
  },
  anyapi: {
    label: 'AnyAPI',
    baseUrl: 'https://api.anyapi.ai/v1',
    keyUrl: 'https://anyapi.ai',
    note: { tr: 'Ücretsiz katman hız sınırlı (20 RPM / 200 istek/gün).', en: 'Free tier is rate limited (20 RPM / 200 requests/day).' },
    fallbackModels: ['meta-llama/llama-3.3-70b-instruct', 'deepseek-chat', 'gpt-oss-120b'],
  },
};

function loadKeys() {
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveKeys(keys) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
  try {
    refreshPiKeys(PROVIDERS, keys);
  } catch {}
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 30 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

const FREE_SUFFIX_PROVIDERS = new Set(['openrouter', 'unorouter']);
const FREE_ALL_PROVIDERS = new Set(['groq', 'cerebras', 'gemini', 'cohere', 'unorouter', 'pollinations']);

function isFreeModel(id, provider) {
  if (FREE_SUFFIX_PROVIDERS.has(provider)) return id.endsWith(':free');
  if (FREE_ALL_PROVIDERS.has(provider)) return true;
  return false;
}

async function listModels(providerId, apiKey) {
  const provider = PROVIDERS[providerId];
  if (provider.fixedModels) {
    return {
      models: provider.fixedModels.map((id) => ({ id, free: isFreeModel(id, providerId) })),
      source: 'fixed',
    };
  }
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  try {
    const resp = await fetch(`${provider.baseUrl}/models`, { headers });
    if (!resp.ok) throw new Error(String(resp.status));
    const data = await resp.json();
    const seen = new Set();
    let ids = [];
    for (const m of data.data || []) {
      const id = String(m.id).replace(/^models\//, '');
      if (!id || seen.has(id) || NON_CHAT_RE.test(id)) continue;
      if (id.startsWith('community/') || id.endsWith(':paid')) continue;
      seen.add(id);
      ids.push(id);
    }
    if (FREE_SUFFIX_PROVIDERS.has(providerId)) {
      const freeOnly = ids.filter((id) => id.endsWith(':free'));
      if (freeOnly.length) ids = freeOnly;
    }
    const models = ids.map((id) => ({ id, free: isFreeModel(id, providerId) }));
    models.sort((a, b) => a.id.localeCompare(b.id));
    return { models, source: 'live' };
  } catch {
    return {
      models: (provider.fallbackModels || []).map((id) => ({ id, free: isFreeModel(id, providerId) })),
      source: 'fallback',
    };
  }
}

function messagesHaveImages(messages) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
}

function stripImages(messages, lang) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const imageCount = m.content.filter((p) => p.type === 'image_url').length;
    const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const note = imageCount ? `\n\n${msg(lang, 'imagesDropped', imageCount)}` : '';
    return { ...m, content: (text + note).trim() };
  });
}

const { rolePresets, ALL_TOOLS, TeamStore, TeamOrchestrator } = require('./team.js');

async function callChatCompletion({ provider: providerId, model, fallback, messages, signal, onDelta, lang }) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(msg(lang, 'invalidProviderId', providerId));
  const keys = loadKeys();
  const apiKey = keys[providerId];
  if (!apiKey && !provider.noKey) {
    throw new Error(msg(lang, 'noApiKey', provider.label));
  }

  const callUpstream = (targetModel, msgs) =>
    fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(providerId === 'openrouter' ? { 'HTTP-Referer': 'http://localhost', 'X-Title': 'FreeAI Studio' } : {}),
      },
      body: JSON.stringify({
        model: targetModel,
        messages: msgs,
        stream: true,
      }),
      signal,
    });

  const readError = async (resp) => {
    const text = await resp.text();
    try {
      return JSON.parse(text)?.error?.message || text;
    } catch {
      return text;
    }
  };

  let currentModel = model;
  let currentMessages = messages;
  let upstream;

  try {
    upstream = await callUpstream(currentModel, currentMessages);
    // Vision fallback
    if (!upstream.ok && messagesHaveImages(currentMessages) && upstream.status >= 400 && upstream.status < 500 && upstream.status !== 401 && upstream.status !== 429) {
      currentMessages = stripImages(currentMessages, lang);
      upstream = await callUpstream(currentModel, currentMessages);
    }

    // Model fallback if failed and fallback specified
    if (!upstream.ok && fallback && fallback.model) {
      const fbProvider = PROVIDERS[fallback.provider || providerId];
      const fbKey = keys[fallback.provider || providerId];
      if (fbProvider && (fbKey || fbProvider.noKey)) {
        upstream = await fetch(`${fbProvider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(fbKey ? { Authorization: `Bearer ${fbKey}` } : {}),
          },
          body: JSON.stringify({
            model: fallback.model,
            messages: stripImages(currentMessages, lang),
            stream: true,
          }),
          signal,
        });
      }
    }
  } catch (err) {
    throw new Error(msg(lang, 'unreachable', err.message));
  }

  if (!upstream.ok) {
    const message = await readError(upstream);
    throw new Error(`${provider.label}: ${message}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

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
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) {
          fullText += delta;
          if (onDelta) onDelta(delta);
        }
      } catch {}
    }
  }

  return fullText;
}

const { PiAgent } = require('./pi-agent.js');
const { TextAgent } = require('./text-agent.js');
const { ensurePiModels, refreshPiKeys, piProviderName, getBuiltinModelInfo, resolveDirectReasoning } = require('./pi-config.js');
const { getThinkingLevels, THINKING_LEVELS } = require('./pi-thinking.js');
const {
  PI_PREFIX,
  OAUTH_PROVIDERS,
  isPiProviderId,
  realPiProviderId,
  listPiAuthProviders,
  listConnectedPiProviders,
  logoutPiProvider,
  listPiModelsForProvider,
  invalidatePiModelCache,
  startPiLogin,
  getPiLoginSession,
  submitPiLoginInput,
  cancelPiLogin,
} = require('./pi-auth.js');

// --- NORMAL SOHBET İÇİN PI AJAN OTURUMLARI ---
const piChatAgents = new Map(); // chatId -> PiAgent
const PI_CHAT_IDLE_MS = 10 * 60 * 1000;

setInterval(() => {
  for (const [chatId, agent] of piChatAgents) {
    if (!agent.busy && Date.now() - (agent.lastUsed || 0) > PI_CHAT_IDLE_MS) {
      agent.dispose();
      piChatAgents.delete(chatId);
    }
  }
}, 60000).unref();

function piChatScratchDir(chatId) {
  return path.join(DATA_DIR, 'pi-chat-scratch', String(chatId).replace(/[^\w.-]/g, '_'));
}

function getPiChatAgent({ chatId, cwd, provider, model, tools, systemPromptFile, sessionDir, rawProvider, thinkingLevel, lang }) {
  const sig = [cwd, provider, model, tools.join(','), systemPromptFile, rawProvider ? 'raw' : '', thinkingLevel || ''].join('|');
  let agent = piChatAgents.get(chatId);
  if (agent && agent.sig !== sig) {
    agent.dispose();
    agent = null;
  }
  if (!agent) {
    agent = new PiAgent({ cwd, provider, model, tools, systemPromptFile, sessionDir, rawProvider, thinkingLevel, lang });
    agent.sig = sig;
    piChatAgents.set(chatId, agent);
  }
  agent.lastUsed = Date.now();
  return agent;
}

function dataUrlToPiImage(att) {
  const m = String(att.dataUrl || '').match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return null;
  return { type: 'image', mimeType: m[1], data: m[2] };
}

async function handlePiChat(req, res) {
  const lang = requestLang(req);
  const body = JSON.parse(await readBody(req));
  const { chatId, message, projectPath, provider, model, tools, attachments } = body || {};
  const thinking = typeof body?.thinking === 'string' && THINKING_LEVELS.includes(body.thinking) ? body.thinking : '';
  if (!chatId || (!message && !(attachments || []).length)) {
    return json(res, 400, { error: msg(lang, 'chatIdRequired') });
  }
  if (!model) return json(res, 400, { error: msg(lang, 'modelRequired') });

  const piNative = isPiProviderId(provider);
  let piProvider;
  if (piNative) {
    const realId = realPiProviderId(provider);
    const connected = listConnectedPiProviders().some((p) => p.id === realId);
    if (!connected) return json(res, 400, { error: msg(lang, 'piNotConnected', realId) });
    piProvider = realId;
  } else {
    const providerCfg = PROVIDERS[provider];
    if (!providerCfg) return json(res, 400, { error: msg(lang, 'invalidProvider') });
    const keys = loadKeys();
    if (!keys[provider] && !providerCfg.noKey) {
      return json(res, 400, { error: msg(lang, 'noApiKey', providerCfg.label) });
    }
    ensurePiModels([{ provider, model }], PROVIDERS, keys);
    piProvider = provider;
  }

  const hasProject = Boolean(projectPath && fs.existsSync(path.resolve(projectPath)));
  const cwd = hasProject ? path.resolve(projectPath) : piChatScratchDir(chatId);
  fs.mkdirSync(cwd, { recursive: true });

  const sessionDir = path.join(DATA_DIR, 'pi-chats', String(chatId).replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(sessionDir, { recursive: true });
  // İstem dile ve klasöre göre her istekte yazılır; dosya adı dile göre ayrıldığı için dil değişince ajan yeniden başlar.
  const systemPromptFile = path.join(sessionDir, `system-${lang}.md`);
  fs.writeFileSync(
    systemPromptFile,
    [msg(lang, 'piChatIntro'), hasProject ? msg(lang, 'piChatProject', cwd) : msg(lang, 'piChatScratch'), msg(lang, 'piChatStyle')].join('\n'),
    'utf8',
  );

  const toolList = Array.isArray(tools) && tools.length ? tools.filter((t) => ALL_TOOLS.includes(t)) : [...ALL_TOOLS];
  const agent = getPiChatAgent({ chatId, cwd, provider: piProvider, model, tools: toolList, systemPromptFile, sessionDir, rawProvider: piNative, thinkingLevel: thinking || undefined, lang });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {}
  };

  let finished = false;
  const onDelta = (d) => send({ type: 'delta', delta: d });
  const onToolStart = (t) => send({ type: 'tool_start', tool: t });
  const onToolEnd = (t) => send({ type: 'tool_end', tool: t });
  agent.on('delta', onDelta);
  agent.on('tool_start', onToolStart);
  agent.on('tool_end', onToolEnd);
  req.on('close', () => {
    if (!finished) agent.abort();
  });

  try {
    const atts = Array.isArray(attachments) ? attachments : [];
    let text = message || '';
    for (const att of atts.filter((a) => a.type === 'file' && a.text)) {
      text += `\n\n${msg(lang, 'attachedFile', att.name)}\n\`\`\`\n${att.text}\n\`\`\``;
    }
    const images = atts.filter((a) => a.type === 'image' && a.dataUrl).map(dataUrlToPiImage).filter(Boolean);
    const finalText = await agent.prompt(text.trim() || msg(lang, 'lookAtImages'), images);
    finished = true;
    send({ type: 'done', text: finalText || '' });
  } catch (err) {
    finished = true;
    send({ type: 'error', message: err.message });
  } finally {
    agent.off('delta', onDelta);
    agent.off('tool_start', onToolStart);
    agent.off('tool_end', onToolEnd);
    res.end();
  }
}

const teamOrchestrator = new TeamOrchestrator({
  createAgent: ({ team, role, promptFile, promptText, sessionDir }) => {
    const piNative = isPiProviderId(role.provider);
    if (role.mode === 'text' && !piNative) {
      return new TextAgent({
        cwd: team.projectPath,
        provider: role.provider,
        model: role.model,
        tools: role.tools,
        systemPrompt: promptText,
        sessionFile: path.join(sessionDir, 'history.json'),
        callChat: callChatCompletion,
        lang: normalizeLang(team.lang || 'tr'),
      });
    }
    // Pi coding-agent modu (Pi üzerinden bağlı abonelikler dahil)
    if (piNative) {
      const realId = realPiProviderId(role.provider);
      if (!listConnectedPiProviders().some((p) => p.id === realId)) {
        throw new Error(msg(team.lang || 'tr', 'piNotConnected', role.provider));
      }
    } else {
      ensurePiModels([{ provider: role.provider, model: role.model }], PROVIDERS, loadKeys());
    }
    return new PiAgent({
      cwd: team.projectPath,
      provider: piNative ? realPiProviderId(role.provider) : role.provider,
      model: role.model,
      tools: role.tools,
      systemPromptFile: promptFile,
      sessionDir,
      rawProvider: piNative,
      thinkingLevel: THINKING_LEVELS.includes(role.thinking) ? role.thinking : undefined,
      lang: normalizeLang(team.lang || 'tr'),
    });
  },
});

// Doğrudan (Pi'siz) sohbetlerde thinking seviyesi Pi'nin yerleşik kataloğuna göre
// reasoning_effort'a eşlenir (pi-config.resolveDirectReasoning).

async function handleChat(req, res) {
  const lang = requestLang(req);
  const body = JSON.parse(await readBody(req));
  const provider = PROVIDERS[body.provider];
  if (!provider) return json(res, 400, { error: msg(lang, 'invalidProvider') });
  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
    return json(res, 400, { error: msg(lang, 'modelAndMessagesRequired') });
  }
  const keys = loadKeys();
  const apiKey = keys[body.provider];
  if (!apiKey && !provider.noKey) return json(res, 400, { error: msg(lang, 'noApiKey', provider.label) });

  const reasoning = resolveDirectReasoning(body.provider, body.model, body.thinking);

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const callUpstream = (messages) =>
    fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(body.provider === 'openrouter' ? { 'HTTP-Referer': 'http://localhost', 'X-Title': 'FreeAI Studio' } : {}),
      },
      body: JSON.stringify({
        model: body.model,
        messages,
        stream: true,
        ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
        ...(reasoning ? { reasoning_effort: reasoning } : {}),
      }),
      signal: controller.signal,
    });

  const readError = async (resp) => {
    const text = await resp.text();
    try {
      return JSON.parse(text)?.error?.message || text;
    } catch {
      return text;
    }
  };

  const hasImages = messagesHaveImages(body.messages);
  let notice = null;
  let upstream;
  try {
    upstream = await callUpstream(body.messages);
    // Model görsel desteklemiyorsa (4xx), görselleri metin notuyla değiştirip bir kez daha dene.
    if (!upstream.ok && hasImages && upstream.status >= 400 && upstream.status < 500 && upstream.status !== 401 && upstream.status !== 429) {
      const firstError = await readError(upstream);
      upstream = await callUpstream(stripImages(body.messages, lang));
      notice = {
        type: 'vision_unsupported',
        message: msg(lang, 'visionStripped', String(firstError).slice(0, 200)),
      };
    }
  } catch (err) {
    return json(res, 502, { error: msg(lang, 'unreachable', err.message) });
  }

  if (!upstream.ok) {
    const message = await readError(upstream);
    return json(res, 502, { error: `${provider.label}: ${message}` });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  if (notice) res.write(`data: ${JSON.stringify({ notice })}\n\n`);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('data:')) res.write(`${line}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
  } catch {
    // client disconnected or upstream dropped; nothing to do
  }
  res.end();
}

async function handleTestModel(req, res) {
  const lang = requestLang(req);
  const body = JSON.parse(await readBody(req));
  if (isPiProviderId(body.provider)) {
    return json(res, 200, { ok: false, error: msg(lang, 'piTestDisabled') });
  }
  const provider = PROVIDERS[body.provider];
  if (!provider) return json(res, 400, { ok: false, error: msg(lang, 'invalidProvider') });
  if (!body.model) return json(res, 400, { ok: false, error: msg(lang, 'modelRequired') });
  const keys = loadKeys();
  const apiKey = keys[body.provider];
  if (!apiKey && !provider.noKey) return json(res, 200, { ok: false, error: msg(lang, 'noApiKeyShort', provider.label) });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: body.model, messages: [{ role: 'user', content: 'selam' }] }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      let message = text;
      try {
        message = JSON.parse(text)?.error?.message || text;
      } catch {}
      return json(res, 200, { ok: false, error: String(message).slice(0, 300) });
    }
    await resp.json();
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 200, { ok: false, error: err.name === 'AbortError' ? msg(lang, 'timeout20') : err.message });
  } finally {
    clearTimeout(timer);
  }
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Yalnızca bu makinedeki arayüzden gelen istekler kabul edilir:
// - Host denetimi DNS rebinding saldırılarını,
// - Origin denetimi başka sitelerin tarayıcı üzerinden API'ye (ör. Pi ajanına komut) istek atmasını engeller.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function isTrustedRequest(req) {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.toLowerCase().replace(/^https?:\/\//, ''))) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  const lang = requestLang(req);
  if (!isTrustedRequest(req)) return json(res, 403, { error: msg(lang, 'forbiddenOrigin') });
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/providers' && req.method === 'GET') {
      const keys = loadKeys();
      const baseProviders = Object.entries(PROVIDERS).map(([id, p]) => ({
        id,
        label: p.label,
        keyUrl: p.keyUrl,
        note: p.note,
        noKey: Boolean(p.noKey),
        keySet: Boolean(keys[id]) || Boolean(p.noKey),
      })).map((p) => ({ ...p, note: pick(p.note, lang) }));
      const piProviders = listConnectedPiProviders(lang).map((p) => ({
        id: `${PI_PREFIX}${p.id}`,
        label: `${p.label} (Pi)`,
        keyUrl: '',
        note: msg(lang, 'piProviderNote'),
        noKey: true,
        keySet: true,
        pi: true,
      }));
      return json(res, 200, { providers: [...baseProviders, ...piProviders] });
    }

    if (url.pathname === '/api/models' && req.method === 'GET') {
      const providerId = url.searchParams.get('provider');
      if (isPiProviderId(providerId)) {
        const models = await listPiModelsForProvider(realPiProviderId(providerId));
        return json(res, 200, { models, source: 'pi', note: msg(lang, 'piModelsNote') });
      }
      if (!PROVIDERS[providerId]) return json(res, 400, { error: msg(lang, 'invalidProvider') });
      const keys = loadKeys();
      const result = await listModels(providerId, keys[providerId]);
      return json(res, 200, { ...result, note: pick(PROVIDERS[providerId].note, lang) });
    }

    if (url.pathname === '/api/thinking-levels' && req.method === 'GET') {
      const providerId = url.searchParams.get('provider');
      const model = url.searchParams.get('model');
      if (!providerId || !model) return json(res, 400, { error: msg(lang, 'providerAndModelRequired') });
      let piProvider;
      if (isPiProviderId(providerId)) {
        const realId = realPiProviderId(providerId);
        if (!listConnectedPiProviders().some((p) => p.id === realId)) {
          return json(res, 200, { levels: [], default: null, error: msg(lang, 'piNotConnectedShort') });
        }
        piProvider = realId;
      } else {
        if (!PROVIDERS[providerId]) return json(res, 400, { error: msg(lang, 'invalidProvider') });
        ensurePiModels([{ provider: providerId, model }], PROVIDERS, loadKeys());
        piProvider = piProviderName(providerId);
      }
      const result = await getThinkingLevels(piProvider, model);
      return json(res, 200, { levels: result.levels, default: result.default, error: result.error });
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      return await handleChat(req, res);
    }

    if (url.pathname === '/api/pi/chat' && req.method === 'POST') {
      return await handlePiChat(req, res);
    }

    if (url.pathname === '/api/test-model' && req.method === 'POST') {
      return await handleTestModel(req, res);
    }

    if (url.pathname === '/api/settings' && req.method === 'GET') {
      const keys = loadKeys();
      return json(res, 200, {
        keys: Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, keys[id] ? '••••••••' : ''])),
      });
    }

    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { provider, key } = body || {};
      if (!PROVIDERS[provider]) return json(res, 400, { error: msg(lang, 'invalidProvider') });
      const keys = loadKeys();
      if (typeof key === 'string' && key.trim()) keys[provider] = key.trim();
      else delete keys[provider];
      saveKeys(keys);
      return json(res, 200, { ok: true, keySet: Boolean(keys[provider]) });
    }

    // --- PI ÜYELİK / OAUTH ENDPOINTLERİ ---
    if (url.pathname === '/api/pi-auth/providers' && req.method === 'GET') {
      return json(res, 200, { providers: listPiAuthProviders(lang) });
    }

    if (url.pathname === '/api/pi-auth/login' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      try {
        const session = await startPiLogin(body.provider, lang);
        return json(res, 200, { ok: true, sessionId: session.id });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    const piLoginMatch = url.pathname.match(/^\/api\/pi-auth\/login\/([^/]+)\/(events|input|cancel)$/);
    if (piLoginMatch) {
      const sessionId = piLoginMatch[1];
      const action = piLoginMatch[2];
      const session = getPiLoginSession(sessionId);
      if (!session) return json(res, 404, { error: msg(lang, 'loginNotFound') });

      if (action === 'events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        for (const evt of session.history) res.write(`data: ${JSON.stringify(evt)}\n\n`);
        if (session.status === 'running') {
          const listener = (evt) => {
            try {
              res.write(`data: ${JSON.stringify(evt)}\n\n`);
            } catch {}
          };
          session.on('event', listener);
          req.on('close', () => session.off('event', listener));
        } else {
          res.end();
        }
        return;
      }

      if (action === 'input' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const ok = submitPiLoginInput(sessionId, body.promptId, body.value);
        return json(res, 200, { ok });
      }

      if (action === 'cancel' && req.method === 'POST') {
        cancelPiLogin(sessionId);
        return json(res, 200, { ok: true });
      }
    }

    if (url.pathname === '/api/pi-auth/logout' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!OAUTH_PROVIDERS[body.provider]) return json(res, 400, { error: msg(lang, 'invalidProvider') });
      const ok = logoutPiProvider(body.provider);
      invalidatePiModelCache();
      return json(res, 200, { ok });
    }

    // --- DOSYA SİSTEMİ (PROJE KONUMU) ENDPOINTLERİ ---
    if (url.pathname === '/api/fs/validate' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const targetPath = (body?.path || '').trim();
      if (!targetPath) return json(res, 200, { ok: false, error: msg(lang, 'pathEmpty') });
      try {
        const resolved = path.resolve(targetPath);
        if (!fs.existsSync(resolved)) return json(res, 200, { ok: false, error: msg(lang, 'pathNotFound') });
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) return json(res, 200, { ok: false, error: msg(lang, 'pathNotDir') });
        const hasGit = fs.existsSync(path.join(resolved, '.git'));
        return json(res, 200, { ok: true, path: resolved, hasGit });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/fs/browse' && req.method === 'GET') {
      let reqPath = url.searchParams.get('path') || process.cwd();
      try {
        reqPath = path.resolve(reqPath);
        if (!fs.existsSync(reqPath)) reqPath = process.cwd();
        const entries = fs.readdirSync(reqPath, { withFileTypes: true });
        const dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
          .map((e) => e.name)
          .sort();
        const parent = path.dirname(reqPath);
        return json(res, 200, { ok: true, current: reqPath, parent: parent !== reqPath ? parent : null, dirs });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- AGİLE EKİP ENDPOINTLERİ ---
    if (url.pathname === '/api/team-presets' && req.method === 'GET') {
      return json(res, 200, { presets: rolePresets(lang), allTools: ALL_TOOLS });
    }

    if (url.pathname === '/api/teams' && req.method === 'GET') {
      return json(res, 200, { teams: TeamStore.list() });
    }

    if (url.pathname === '/api/teams' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.name || !Array.isArray(body.roles) || body.roles.length === 0) {
        return json(res, 400, { error: msg(lang, 'nameAndRolesRequired') });
      }
      if (!body.projectPath || !fs.existsSync(path.resolve(body.projectPath))) {
        return json(res, 400, { error: msg(lang, 'projectPathRequired') });
      }
      const piPairs = body.roles
        .filter((r) => r.mode !== 'text' && !isPiProviderId(r.provider))
        .map((r) => ({ provider: r.provider, model: r.model }));
      // Pi üzerinden bağlı sağlayıcıların bağlantısını doğrula
      const missingPi = body.roles
        .filter((r) => isPiProviderId(r.provider))
        .map((r) => realPiProviderId(r.provider))
        .filter((p, i, arr) => arr.indexOf(p) === i)
        .filter((p) => !listConnectedPiProviders().some((c) => c.id === p));
      if (missingPi.length) {
        return json(res, 400, { error: msg(lang, 'piNotConnectedList', missingPi.join(', ')) });
      }
      if (piPairs.length) {
        ensurePiModels(piPairs, PROVIDERS, loadKeys());
      }
      const team = teamOrchestrator.createTeam({ ...body, lang: normalizeLang(body.lang || lang) });
      return json(res, 200, { team });
    }

    const teamMatch = url.pathname.match(/^\/api\/teams\/([^/]+)(?:\/(.*))?$/);
    if (teamMatch) {
      const teamId = teamMatch[1];
      const subPath = teamMatch[2] || '';

      if (!subPath && req.method === 'GET') {
        const team = TeamStore.get(teamId);
        if (!team) return json(res, 404, { error: msg(lang, 'teamNotFound') });
        return json(res, 200, { team });
      }

      if (!subPath && req.method === 'DELETE') {
        teamOrchestrator.disposeTeamAgents(teamId);
        const ok = TeamStore.delete(teamId);
        return json(res, 200, { ok });
      }

      if (subPath === 'message' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (!body.text && (!body.attachments || body.attachments.length === 0)) {
          return json(res, 400, { error: msg(lang, 'textOrAttachments') });
        }
        try {
          const userMsg = await teamOrchestrator.handleUserMessage(teamId, body.text || '', body.attachments || []);
          return json(res, 200, { ok: true, message: userMsg });
        } catch (err) {
          return json(res, 500, { error: err.message });
        }
      }

      if (subPath === 'control' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        try {
          const updated = await teamOrchestrator.control(teamId, body.action);
          return json(res, 200, { ok: true, team: updated });
        } catch (err) {
          return json(res, 500, { error: err.message });
        }
      }

      if (subPath === 'docs' && req.method === 'GET') {
        const team = TeamStore.get(teamId);
        if (!team) return json(res, 404, { error: msg(lang, 'teamNotFound') });
        return json(res, 200, { docs: teamOrchestrator.listDocs(team) });
      }

      if (subPath === 'roles' && req.method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        try {
          const updated = teamOrchestrator.updateRoles(teamId, body.roles || []);
          return json(res, 200, { ok: true, team: updated });
        } catch (err) {
          return json(res, 500, { error: err.message });
        }
      }

      if (subPath === 'events' && req.method === 'GET') {
        const team = TeamStore.get(teamId);
        if (!team) return json(res, 404, { error: msg(lang, 'teamNotFound') });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'connected', teamId })}\n\n`);

        const listener = (event) => {
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {}
        };

        const eventName = `event:${teamId}`;
        teamOrchestrator.on(eventName, listener);

        req.on('close', () => {
          teamOrchestrator.off(eventName, listener);
        });
        return;
      }
    }

    if (req.method === 'GET') return serveStatic(res, url.pathname);
    return json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(msg(process.env.FREEAI_LANG || 'tr', 'listening', `http://${HOST}:${PORT}`));
});
