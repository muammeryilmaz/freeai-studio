// pi-thinking.js — Bir (pi sağlayıcısı, model) çifti için desteklenen thinking seviyelerini
// Pi'nin RPC modundan sorgular. Sonuçlar önbelleğe alınır; süreç bir kez başlatılıp kapatılır.
const { spawn } = require('node:child_process');
const { PI_AGENT_DIR, findPiCli, THINKING_LEVELS } = require('./pi-config.js');

const QUERY_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map(); // `${provider}|${model}` -> { levels, default, at, error }
const inflight = new Map();

function runRpcQuery(piProvider, model) {
  return new Promise((resolve) => {
    const cli = findPiCli();
    if (!cli) return resolve({ levels: [], default: null, error: 'Pi CLI bulunamadı.' });
    const args = [cli, '--mode', 'rpc', '--provider', piProvider, '--model', model, '--no-tools', '--offline', '--no-session'];
    const proc = spawn(process.execPath, args, {
      env: { ...process.env, PI_CODING_AGENT_DIR: PI_AGENT_DIR, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buffer = '';
    let settled = false;
    let graceTimer = null;
    const result = { levels: null, default: null, error: null };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      try {
        proc.kill();
      } catch {}
      if (!result.levels) result.levels = [];
      resolve(result);
    };
    const timer = setTimeout(() => {
      result.error = 'zaman aşımı';
      finish();
    }, QUERY_TIMEOUT_MS);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type !== 'response') continue;
        if (rec.id === 'q_levels' && rec.success) result.levels = rec.data?.levels || [];
        if (rec.id === 'q_state' && rec.success) result.default = rec.data?.thinkingLevel || null;
        if (result.levels && result.default) {
          clearTimeout(timer);
          finish();
        } else if (result.levels && !graceTimer) {
          // get_state biraz gecikebilir; seviyeler geldikten sonra kisa bir ek süre tanı.
          graceTimer = setTimeout(() => {
            clearTimeout(timer);
            finish();
          }, 600);
        }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => {});
    proc.on('error', (e) => {
      result.error = e.message;
      clearTimeout(timer);
      finish();
    });
    proc.on('exit', (code) => {
      if (!result.levels && !result.error) result.error = `pi süreci kapandı (kod ${code})`;
      clearTimeout(timer);
      finish();
    });
    setTimeout(() => {
      try {
        proc.stdin.write(JSON.stringify({ id: 'q_levels', type: 'get_available_thinking_levels' }) + '\n');
        proc.stdin.write(JSON.stringify({ id: 'q_state', type: 'get_state' }) + '\n');
      } catch {}
    }, 2200);
  });
}

/**
 * @param {string} piProvider pi'nin sağlayıcı kimliği (aic- öneki çoktan uygulanmış olmalı)
 * @param {string} model
 * @returns {Promise<{levels:string[], default:string|null, error?:string}>}
 */
async function getThinkingLevels(piProvider, model) {
  const key = `${piProvider}|${model}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const promise = runRpcQuery(piProvider, model)
    .then((res) => {
      const levels = (res.levels || []).filter((l) => THINKING_LEVELS.includes(l));
      const entry = { levels, default: res.default, error: res.error || undefined, at: Date.now() };
      cache.set(key, entry);
      return entry;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

function invalidateThinkingCache() {
  cache.clear();
}

module.exports = { getThinkingLevels, invalidateThinkingCache, THINKING_LEVELS };
