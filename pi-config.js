// Pi coding-agent için yapılandırma: FreeAI Studio sağlayıcılarını pi'nin models.json'una yazar.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PI_AGENT_DIR = path.join(process.env.FREEAI_DATA_DIR || path.join(ROOT, 'data'), 'pi-agent');

// Pi, tanımadığı OpenAI uyumlu uç noktalara OpenAI'ye özgü alanlar (store, "developer" rolü) gönderir.
// Gemini gibi sağlayıcılar bunları 400 ile reddettiği için kendi sağlayıcılarımızda kapatılır.
const COMPAT_DEFAULTS = { supportsStore: false, supportsDeveloperRole: false };

// Pi'nin yerel istemcisiyle çalıştırılan sağlayıcılar. Gemini 3.x araç çağrılarında thought_signature alanının
// geri gönderilmesini ister; Pi bunu OpenAI uyumlu istemcide değil, yalnızca yerel Google istemcisinde yapar.
const NATIVE_APIS = {
  gemini: { api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', catalogProvider: 'google' },
};
const MODELS_FILE = path.join(PI_AGENT_DIR, 'models.json');

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Pi'nin yerleşik model kataloğu (reasoning/thinkingLevelMap/compat/context bilgileri için).
let builtinExports = null;
function loadBuiltinCatalog() {
  if (builtinExports) return builtinExports;
  try {
    builtinExports = require('./vendor/pi/chunks/chunk-ZEDTKAPW.js').all_exports || null;
  } catch {
    builtinExports = null;
  }
  return builtinExports;
}

/**
 * Pi'nin yerleşik kataloğundan model meta verisini döndürür.
 * Katalog bilgisi yalnızca aynı API'yi kullanan models.json girdilerine uygulanır;
 * API'ler (openai-completions, google-generative-ai vb.) farklı istek formatı kullanır.
 */
function getBuiltinModelInfo(providerId, modelId) {
  const catalog = loadBuiltinCatalog();
  if (!catalog?.getBuiltinModel) return null;
  try {
    return catalog.getBuiltinModel(providerId, modelId) || null;
  } catch {
    return null;
  }
}

/** Yerleşik katalogdaki thinking/context alanlarını models.json girdisine uygular. */
function applyBuiltinModelInfo(entry, modelId, builtin) {
  if (!builtin) return false;
  if (builtin.api !== entry.api) return false;
  const target = entry.models.find((m) => m.id === modelId);
  if (!target) return false;
  if (typeof builtin.contextWindow === 'number') target.contextWindow = builtin.contextWindow;
  if (typeof builtin.maxTokens === 'number') target.maxTokens = builtin.maxTokens;
  if (builtin.reasoning) {
    target.reasoning = true;
    if (builtin.thinkingLevelMap) target.thinkingLevelMap = builtin.thinkingLevelMap;
    if (builtin.compat) target.compat = { ...(target.compat || {}), ...builtin.compat, ...COMPAT_DEFAULTS };
  }
  return true;
}

/**
 * Doğrudan (Pi'siz) sohbetlerde thinking seviyesini reasoning_effort'a eşler.
 * Yalnızca Pi'nin yerleşik kataloğunda reasoning destekli ve openai-completions API'li
 * modeller için uygulanır; diğerlerinde null döner (parametre gönderilmez).
 */
function resolveDirectReasoning(providerId, modelId, thinking) {
  if (!thinking || thinking === 'off' || !THINKING_LEVELS.includes(thinking)) return null;
  const info = getBuiltinModelInfo(providerId, modelId);
  if (!info || info.api !== 'openai-completions' || !info.reasoning) return null;
  const mapped = info.thinkingLevelMap ? info.thinkingLevelMap[thinking] : undefined;
  if (mapped === null) return null;
  return typeof mapped === 'string' ? mapped : thinking;
}

function findPiCli() {
  const candidates = [process.env.PI_PATH, path.join(ROOT, 'vendor', 'pi', 'cli.js')].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// Pi'nin yerleşik sağlayıcılarıyla (groq, gemini...) çakışmasın diye önek kullanılır.
function piProviderName(providerId) {
  return `aic-${providerId}`;
}

function loadModelsJson() {
  try {
    return JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
  } catch {
    return { providers: {} };
  }
}

/**
 * Rollerin ihtiyaç duyduğu sağlayıcı/model çiftlerini models.json'a ekler.
 * @param {{provider:string, model:string}[]} pairs
 * @param {object} PROVIDERS server.js'teki sağlayıcı tanımları
 * @param {object} keys data/keys.json
 */
function ensurePiModels(pairs, PROVIDERS, keys) {
  fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
  const cfg = loadModelsJson();
  cfg.providers = cfg.providers || {};
  for (const { provider, model } of pairs) {
    const p = PROVIDERS[provider];
    if (!p || !model) continue;
    const name = piProviderName(provider);
    const entry = cfg.providers[name] || { models: [] };
    const native = NATIVE_APIS[provider];
    entry.baseUrl = native?.baseUrl || p.baseUrl;
    entry.api = native?.api || 'openai-completions';
    entry.apiKey = keys[provider] || 'no-key';
    if (provider === 'openrouter') entry.headers = { 'HTTP-Referer': 'http://localhost', 'X-Title': 'FreeAI Studio' };
    if (!entry.models.some((m) => m.id === model)) {
      entry.models.push({ id: model, name: model, input: ['text'], contextWindow: 128000, maxTokens: 8192 });
    }
    for (const m of entry.models) m.compat = { ...(m.compat || {}), ...COMPAT_DEFAULTS };
    // Pi'nin yerleşik kataloğundaki reasoning/thinking bilgisini uygula (groq, cerebras vb.)
    applyBuiltinModelInfo(entry, model, getBuiltinModelInfo(native?.catalogProvider || provider, model));
    cfg.providers[name] = entry;
  }
  fs.writeFileSync(MODELS_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

/** Anahtar değiştiğinde mevcut girişlerin apiKey'ini günceller. */
function refreshPiKeys(PROVIDERS, keys) {
  const cfg = loadModelsJson();
  let changed = false;
  for (const id of Object.keys(PROVIDERS)) {
    const entry = cfg.providers?.[piProviderName(id)];
    if (entry) {
      entry.apiKey = keys[id] || 'no-key';
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(MODELS_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

module.exports = { PI_AGENT_DIR, findPiCli, piProviderName, ensurePiModels, refreshPiKeys, getBuiltinModelInfo, resolveDirectReasoning, THINKING_LEVELS };
