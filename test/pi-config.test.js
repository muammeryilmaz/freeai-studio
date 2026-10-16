// Pi models.json üretiminin sağlayıcı uyumluluk ayarlarını doğru yazdığını doğrular.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'freeai-piconfig-'));
process.env.FREEAI_DATA_DIR = DATA_DIR;
const { ensurePiModels, PI_AGENT_DIR } = require('../pi-config.js');
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

const PROVIDERS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
};
const read = () => JSON.parse(fs.readFileSync(path.join(PI_AGENT_DIR, 'models.json'), 'utf8')).providers;

test('models.json veri klasörüne yazılır ve OpenAI\'ye özgü alanlar kapatılır', () => {
  ensurePiModels([{ provider: 'groq', model: 'openai/gpt-oss-120b' }], PROVIDERS, { groq: 'k1' });
  assert.ok(PI_AGENT_DIR.startsWith(DATA_DIR));
  const groq = read()['aic-groq'];
  assert.equal(groq.api, 'openai-completions');
  assert.equal(groq.apiKey, 'k1');
  const model = groq.models.find((m) => m.id === 'openai/gpt-oss-120b');
  assert.equal(model.compat.supportsStore, false);
  assert.equal(model.compat.supportsDeveloperRole, false);
});

test('Gemini, araç çağrıları için Pi\'nin yerel Google istemcisiyle tanımlanır', () => {
  ensurePiModels([{ provider: 'gemini', model: 'gemini-3.1-flash-lite' }], PROVIDERS, { gemini: 'k2' });
  const gemini = read()['aic-gemini'];
  assert.equal(gemini.api, 'google-generative-ai');
  assert.equal(gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  const model = gemini.models.find((m) => m.id === 'gemini-3.1-flash-lite');
  assert.equal(model.reasoning, true, 'düşünme bilgisi Pi kataloğundaki google kaydından gelmeli');
});
