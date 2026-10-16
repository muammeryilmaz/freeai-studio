// pi-auth.js — Pi'nin OAuth/abonelik giriş akışlarını FreeAI Studio Settings'e bağlar.
// Pi'nin kendi sağlayıcı modülleri (vendor/pi/chunks) kullanılarak login/refresh yapılır,
// kimlik bilgileri FreeAI Studio'in pi yapılandırma klasörüne (data/pi-agent/auth.json) yazılır.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { PI_AGENT_DIR, findPiCli } = require('./pi-config.js');

const CHUNKS_DIR = path.join(__dirname, 'vendor', 'pi', 'chunks');
const AUTH_FILE = path.join(PI_AGENT_DIR, 'auth.json');
const DEFAULT_RADIUS_GATEWAY = 'https://radius.pi.dev';

const { pick, msg } = require('./i18n.js');

const chunkUrl = (name) => pathToFileURL(path.join(CHUNKS_DIR, name)).href;

// Desteklenen abonelik/OAuth sağlayıcıları. id'ler Pi'nin kendi sağlayıcı kimlikleridir.
const OAUTH_PROVIDERS = {
  'openai-codex': {
    label: 'OpenAI Codex (ChatGPT Plus/Pro)',
    description: {
      tr: 'Codex ajan modelleri (gpt-5.x-codex, gpt-6.x) — chatgpt.com backend. Pi\'deki eski Codex entegrasyonu; Codex CLI tarzı oturum.',
      en: 'Codex agent models (gpt-5.x-codex, gpt-6.x) — chatgpt.com backend. Pi\'s older Codex integration; Codex CLI-style session.',
    },
    load: async () => (await import(chunkUrl('openai-codex.js'))).openaiCodexOAuth,
  },
  openai: {
    label: { tr: 'OpenAI GPT (ChatGPT aboneliği)', en: 'OpenAI GPT (ChatGPT subscription)' },
    description: {
      tr: 'Standart GPT modelleri (gpt-5.x, gpt-4.1, gpt-4o) — api.openai.com. Pi\'nin güncel "Sign in with ChatGPT" girişi.',
      en: 'Standard GPT models (gpt-5.x, gpt-4.1, gpt-4o) — api.openai.com. Pi\'s current "Sign in with ChatGPT" login.',
    },
    load: async () => (await import(chunkUrl('openai-chatgpt.js'))).openaiChatGPTOAuth,
  },
  anthropic: {
    label: 'Anthropic (Claude Pro/Max)',
    description: { tr: 'Claude modelleri — Pi üzerinden Claude aboneliğiyle giriş', en: 'Claude models — sign in with your Claude subscription through Pi' },
    load: async () => (await import(chunkUrl('anthropic.js'))).anthropicOAuth,
  },
  'github-copilot': {
    label: 'GitHub Copilot',
    description: { tr: 'Copilot modelleri — Pi üzerinden GitHub Copilot aboneliğiyle giriş', en: 'Copilot models — sign in with your GitHub Copilot subscription through Pi' },
    load: async () => (await import(chunkUrl('github-copilot.js'))).githubCopilotOAuth,
  },
  'kimi-coding': {
    label: { tr: 'Kimi Code (abonelik)', en: 'Kimi Code (subscription)' },
    description: { tr: 'Kimi modelleri — Pi üzerinden Kimi Code aboneliğiyle giriş', en: 'Kimi models — sign in with your Kimi Code subscription through Pi' },
    load: async () => (await import(chunkUrl('kimi-coding.js'))).kimiCodingOAuth,
  },
  meta: {
    label: { tr: 'Meta (Muse aboneliği)', en: 'Meta (Muse subscription)' },
    description: { tr: 'Meta modelleri — Pi üzerinden Meta aboneliğiyle giriş', en: 'Meta models — sign in with your Meta subscription through Pi' },
    load: async () => (await import(chunkUrl('meta.js'))).metaOAuth,
  },
  xai: {
    label: 'xAI (SuperGrok / X Premium)',
    description: { tr: 'Grok modelleri — Pi üzerinden xAI aboneliğiyle giriş', en: 'Grok models — sign in with your xAI subscription through Pi' },
    load: async () => (await import(chunkUrl('xai.js'))).xaiOAuth,
  },
  openrouter: {
    label: 'OpenRouter (OAuth)',
    description: { tr: 'Pi üzerinden OpenRouter hesabıyla giriş', en: 'Sign in with your OpenRouter account through Pi' },
    load: async () => (await import(chunkUrl('openrouter.js'))).openRouterOAuth,
  },
  radius: {
    label: 'Radius',
    description: { tr: 'Pi üzerinden Radius gateway girişi', en: 'Radius gateway sign-in through Pi' },
    load: async () => (await import(chunkUrl('radius.js'))).createRadiusOAuth({ gateway: DEFAULT_RADIUS_GATEWAY, name: 'Radius' }),
  },
};

// Prefix 'pi:' — FreeAI Studio içinde Pi destekli sağlayıcıları normal API-anahtarlı sağlayıcılardan ayırır.
const PI_PREFIX = 'pi:';
const isPiProviderId = (id) => typeof id === 'string' && id.startsWith(PI_PREFIX);
const realPiProviderId = (id) => (isPiProviderId(id) ? id.slice(PI_PREFIX.length) : id);

function readAuth() {
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeAuth(auth) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf8');
  modelCache = null;
  modelCacheAt = 0;
}

/** Settings listesi için: her sağlayıcının bağlantı durumu. */
function listPiAuthProviders(lang) {
  const auth = readAuth();
  return Object.entries(OAUTH_PROVIDERS).map(([id, p]) => {
    const cred = auth[id];
    return {
      id,
      label: pick(p.label, lang),
      description: pick(p.description, lang),
      connected: Boolean(cred),
      expires: cred?.expires || null,
      authType: cred?.type || null,
    };
  });
}

/** Yalnızca bağlı sağlayıcılar (provider listesine eklemek için). */
function listConnectedPiProviders(lang) {
  return listPiAuthProviders(lang).filter((p) => p.connected);
}

function logoutPiProvider(providerId) {
  const auth = readAuth();
  if (!auth[providerId]) return false;
  delete auth[providerId];
  writeAuth(auth);
  return true;
}

// --- MODEL LİSTESİ (pi --list-models çıktısını ayrıştırır) ---
let modelCache = null;
let modelCacheAt = 0;
const MODEL_CACHE_MS = 60 * 1000;

function parseModelsOutput(text) {
  const models = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed || /^provider\s+model/i.test(trimmed)) continue;
    // Sütunlar: provider model context max-out thinking images
    const parts = trimmed.split(/\s{2,}/).filter(Boolean);
    if (parts.length < 4) continue;
    models.push({ provider: parts[0], id: parts[1] });
  }
  return models;
}

function listPiModels() {
  if (modelCache && Date.now() - modelCacheAt < MODEL_CACHE_MS) return modelCache;
  return new Promise((resolve) => {
    const cli = findPiCli();
    if (!cli) {
      modelCache = [];
      modelCacheAt = Date.now();
      return resolve(modelCache);
    }
    execFile(
      process.execPath,
      [cli, '--list-models'],
      {
        env: { ...process.env, PI_CODING_AGENT_DIR: PI_AGENT_DIR, NO_COLOR: '1' },
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout) => {
        modelCache = err && !stdout ? [] : parseModelsOutput(stdout || '');
        modelCacheAt = Date.now();
        resolve(modelCache);
      },
    );
  });
}

async function listPiModelsForProvider(providerId) {
  const models = await listPiModels();
  return models
    .filter((m) => m.provider === providerId)
    .map((m) => ({ id: m.id, free: false, pi: true }));
}

// --- TARAYICI AÇMA ---
function openInBrowser(url) {
  if (process.env.PI_AUTH_NO_BROWSER) return;
  try {
    if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

// --- GİRİŞ OTURUMLARI ---
let sessionSeq = 0;
const sessions = new Map();

class LoginSession extends EventEmitter {
  constructor(providerId) {
    super();
    this.id = `piauth_${Date.now()}_${++sessionSeq}`;
    this.providerId = providerId;
    this.controller = new AbortController();
    this.history = [];
    this.pendingPrompt = null;
    this.status = 'running';
  }

  _emit(event) {
    this.history.push(event);
    this.emit('event', event);
  }

  notify(evt) {
    const { type, ...rest } = evt;
    this._emit({ type: 'notify', notifyType: type, ...rest });
    const url = type === 'auth_url' ? evt.url : type === 'device_code' ? evt.verificationUri : null;
    if (url) openInBrowser(url);
  }

  prompt(req) {
    // req.signal: pi tarafı bazı akışlarda iptal sinyali gönderir (ör. tarayıcı yönlendirmesi tamamlanınca).
    const { signal, ...clean } = req || {};
    const promptId = `p${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const promise = new Promise((resolve, reject) => {
      this.pendingPrompt = { promptId, resolve, reject };
      const onAbort = () => {
        if (this.pendingPrompt?.promptId === promptId) this.pendingPrompt = null;
        const err = new Error('Login cancelled');
        err.name = 'AbortError';
        reject(err);
      };
      for (const s of [signal, this.controller.signal]) {
        if (!s) continue;
        if (s.aborted) return onAbort();
        s.addEventListener('abort', onAbort, { once: true });
      }
    });
    promise.catch(() => {});
    this._emit({ type: 'prompt', promptId, prompt: clean });
    return promise;
  }

  submitInput(promptId, value) {
    if (!this.pendingPrompt || this.pendingPrompt.promptId !== promptId) return false;
    const p = this.pendingPrompt;
    this.pendingPrompt = null;
    p.resolve(value);
    return true;
  }

  cancel() {
    this.controller.abort();
  }
}

/**
 * Giriş akışını başlatır. Dönen oturum: SSE ile olay akışı sunar; input() ile prompt yanıtlanır.
 * @param {string} providerId OAUTH_PROVIDERS anahtarı
 */
async function startPiLogin(providerId, lang) {
  const provider = OAUTH_PROVIDERS[providerId];
  if (!provider) throw new Error(msg(lang, 'unsupportedProvider', providerId));
  const session = new LoginSession(providerId);
  sessions.set(session.id, session);

  (async () => {
    try {
      const oauth = await provider.load();
      const credential = await oauth.login({
        signal: session.controller.signal,
        notify: (evt) => session.notify(evt),
        prompt: (req) => session.prompt(req),
      });
      if (!credential || typeof credential !== 'object') throw new Error(msg(lang, 'loginIncomplete'));
      const auth = readAuth();
      auth[providerId] = credential;
      writeAuth(auth);
      session.status = 'done';
      session._emit({ type: 'done', provider: providerId, label: pick(provider.label, lang) });
    } catch (err) {
      session.status = 'error';
      session._emit({ type: 'error', message: err?.message || String(err) });
    } finally {
      setTimeout(() => sessions.delete(session.id), 10 * 60 * 1000).unref?.();
    }
  })();

  return session;
}

function getPiLoginSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function submitPiLoginInput(sessionId, promptId, value) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  return session.submitInput(promptId, value);
}

function cancelPiLogin(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.cancel();
  return true;
}

// Model önbelleğini dışarıdan geçersiz kılmak için (giriş/çıkış sonrası).
function invalidatePiModelCache() {
  modelCache = null;
  modelCacheAt = 0;
}

// Testler için: bir sağlayıcının OAuth yükleyicisini değiştirir.
function setOAuthLoaderOverride(providerId, loader) {
  if (OAUTH_PROVIDERS[providerId]) OAUTH_PROVIDERS[providerId].load = loader;
}

module.exports = {
  OAUTH_PROVIDERS,
  PI_PREFIX,
  isPiProviderId,
  realPiProviderId,
  listPiAuthProviders,
  listConnectedPiProviders,
  logoutPiProvider,
  listPiModels,
  listPiModelsForProvider,
  invalidatePiModelCache,
  startPiLogin,
  getPiLoginSession,
  submitPiLoginInput,
  cancelPiLogin,
  setOAuthLoaderOverride,
  AUTH_FILE,
};
