// Metin modu ajanının proje klasöründe dosya işlemleri yapabildiğini ve klasör dışına çıkamadığını doğrular.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextAgent, parseToolCalls, executeTool, projectTree } = require('../text-agent.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'freeai-textagent-'));
fs.mkdirSync(path.join(ROOT, 'src'));
fs.writeFileSync(path.join(ROOT, 'src', 'app.js'), 'const greeting = "merhaba";\nconsole.log(greeting);\n');
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('araç etiketleri ayrıştırılır', () => {
  const calls = parseToolCalls('@@LS src\n@@READ src/app.js 1-1\n@@GREP greeting\n@@WRITE notes.md\n# Not\n@@END');
  assert.deepEqual(calls.map((c) => c.name), ['ls', 'read', 'grep', 'write']);
  assert.equal(calls[1].args.from, 1);
  assert.equal(calls[3].args.body, '# Not');
});

test('proje klasöründe listeleme, okuma, arama, yazma ve düzenleme çalışır', async () => {
  assert.match(await executeTool(ROOT, { name: 'ls', args: { path: 'src' } }), /app\.js/);
  assert.match(await executeTool(ROOT, { name: 'read', args: { path: 'src/app.js' } }), /merhaba/);
  assert.match(await executeTool(ROOT, { name: 'grep', args: { pattern: 'greeting' } }), /src[\\/]app\.js:1/);
  await executeTool(ROOT, { name: 'write', args: { path: 'docs/plan.md', body: '# Plan' } });
  assert.equal(fs.readFileSync(path.join(ROOT, 'docs', 'plan.md'), 'utf8'), '# Plan');
  await executeTool(ROOT, { name: 'edit', args: { path: 'src/app.js', body: '<<<<<<< ARA\n"merhaba"\n=======\n"hello"\n>>>>>>> YENI' } });
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8'), /"hello"/);
  assert.match(projectTree(ROOT), /src\/\n\s+app\.js/);
});

test('bash komutu proje klasöründe çalışır', async () => {
  const out = await executeTool(ROOT, { name: 'bash', args: { command: process.platform === 'win32' ? '(Get-Location).Path' : 'pwd' } });
  assert.equal(path.resolve(out.trim()).toLowerCase(), path.resolve(ROOT).toLowerCase());
});

test('proje klasörü dışına erişim engellenir', async () => {
  for (const p of ['../dışarı.txt', path.join(os.tmpdir(), 'x.txt'), 'src/../../x.txt']) {
    await assert.rejects(executeTool(ROOT, { name: 'write', args: { path: p, body: 'x' } }), /dışına|outside/);
    await assert.rejects(executeTool(ROOT, { name: 'read', args: { path: p } }), /dışına|outside/);
  }
});

test('TextAgent: izinli olmayan araç reddedilir, dil ayarı araç sonuçlarına yansır', async () => {
  const replies = ['@@WRITE secret.txt\nx\n@@END', '@@SEND to=po kind=result\nDone.\n@@END'];
  const seen = [];
  const agent = new TextAgent({
    cwd: ROOT,
    provider: 'mock',
    model: 'mock',
    tools: ['read'],
    systemPrompt: 'test',
    sessionFile: path.join(ROOT, '.session', 'history.json'),
    lang: 'en',
    callChat: async ({ messages }) => {
      seen.push(messages);
      return replies.shift();
    },
  });
  const final = await agent.prompt('go');
  assert.match(final, /@@SEND/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'secret.txt')), 'yazma izni olmayan rol dosya oluşturmamalı');
  const toolResult = seen[1].at(-1).content;
  assert.match(toolResult, /TOOL RESULTS/);
  assert.match(toolResult, /disabled for this role/);
  assert.match(seen[0][0].content, /FILE TOOLS \(text mode\)/);
});
