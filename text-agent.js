// Araç çağırmayı (tool calling) desteklemeyen modeller için metin tabanlı ajan.
// Model düz metin etiketleriyle dosya işlemi ister, sunucu çalıştırıp sonucu geri verir.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const EventEmitter = require('node:events');

const MAX_STEPS = 15;
const MAX_READ_CHARS = 60000;
const MAX_HISTORY_CHARS = 120000;
const IGNORE_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', '.vs', '.idea', '.next', '__pycache__', '.venv', 'vendor']);

const TEXT_TOOLS_DOC_TR = `
--- DOSYA ARAÇLARI (metin modu) ---
Proje klasöründe çalışıyorsun. Dosya işlemi için cevabına aşağıdaki etiketleri yaz; sistem çalıştırıp sonucunu sana bir sonraki mesajda verir.
Bir mesajda birden fazla araç etiketi kullanabilirsin. Araç sonuçlarını bekliyorsan iletişim bloklarını (@@SEND vb.) henüz YAZMA.

@@LS yol            → klasör içeriğini listeler (yol boşsa proje kökü)
@@READ yol          → dosyayı okur (isteğe bağlı satır aralığı: @@READ src/a.cs 1-120)
@@GREP desen        → projede metin arar
@@BASH komut        → kabukta komut çalıştırır (60 sn sınır)
@@WRITE yol
...dosyanın TAM yeni içeriği...
@@END
@@EDIT yol
<<<<<<< ARA
...değişecek mevcut metin (birebir aynı)...
=======
...yeni metin...
>>>>>>> YENI
@@END

İşin bittiğinde araç etiketi kullanmadan son cevabını ve iletişim bloklarını yaz.
`;

const TEXT_TOOLS_DOC_EN = `
--- FILE TOOLS (text mode) ---
You are working in the project folder. For file operations, write the tags below in your answer; the system runs them and gives you the result in the next message.
You may use several tool tags in one message. If you are waiting for tool results, do NOT write communication blocks (@@SEND etc.) yet.

@@LS path           → lists the folder contents (project root if path is empty)
@@READ path         → reads a file (optional line range: @@READ src/a.cs 1-120)
@@GREP pattern      → searches text in the project
@@BASH command      → runs a shell command (60 s limit)
@@WRITE path
...the FULL new content of the file...
@@END
@@EDIT path
<<<<<<< SEARCH
...existing text to change (exactly the same)...
=======
...new text...
>>>>>>> REPLACE
@@END

When you are done, write your final answer and communication blocks without tool tags.
`;

// Araç çıktıları ve ajan döngüsü metinleri (ekibin diline göre).
const TT = {
  tr: {
    doc: TEXT_TOOLS_DOC_TR,
    outside: (rel) => `Proje klasörü dışına erişim engellendi: ${rel}`,
    treeTruncated: '... (liste kısaltıldı)',
    noMatch: '(eşleşme yok)',
    timeout: '[zaman aşımı: 60 sn]',
    exitCode: (c) => `[çıkış kodu: ${c}]`,
    noOutput: '(çıktı yok)',
    empty: '(boş)',
    readTruncated: '...[kırpıldı, satır aralığıyla devamını oku]',
    written: (p, n) => `yazıldı: ${p} (${n} karakter)`,
    edited: (p) => `düzenlendi: ${p}`,
    badEdit: 'EDIT formatı hatalı (<<<<<<< ARA / ======= / >>>>>>> YENI bekleniyor).',
    notFound: 'Aranan metin dosyada birebir bulunamadı; önce dosyayı oku.',
    unknownTool: (n) => `bilinmeyen araç: ${n}`,
    toolDisabled: (n) => `'${n}' aracı bu rol için kapalı.`,
    allowedTools: 'İzinli araçların',
    projectTree: 'PROJE AĞACI',
    toolResults: 'ARAÇ SONUÇLARI',
    errorPrefix: 'HATA',
    continue: 'Devam et. İşin bittiyse araç etiketi olmadan son cevabını ve iletişim bloklarını yaz.',
    stepLimit: 'Adım sınırına ulaşıldı. Şimdi araç kullanmadan son cevabını ve iletişim bloklarını yaz.',
  },
  en: {
    doc: TEXT_TOOLS_DOC_EN,
    outside: (rel) => `Access outside the project folder was blocked: ${rel}`,
    treeTruncated: '... (list truncated)',
    noMatch: '(no matches)',
    timeout: '[timed out: 60 s]',
    exitCode: (c) => `[exit code: ${c}]`,
    noOutput: '(no output)',
    empty: '(empty)',
    readTruncated: '...[truncated, read the rest with a line range]',
    written: (p, n) => `written: ${p} (${n} characters)`,
    edited: (p) => `edited: ${p}`,
    badEdit: 'Invalid EDIT format (expected <<<<<<< SEARCH / ======= / >>>>>>> REPLACE).',
    notFound: 'The search text was not found verbatim in the file; read the file first.',
    unknownTool: (n) => `unknown tool: ${n}`,
    toolDisabled: (n) => `The '${n}' tool is disabled for this role.`,
    allowedTools: 'Your allowed tools',
    projectTree: 'PROJECT TREE',
    toolResults: 'TOOL RESULTS',
    errorPrefix: 'ERROR',
    continue: 'Continue. If you are done, write your final answer and communication blocks without tool tags.',
    stepLimit: 'Step limit reached. Now write your final answer and communication blocks without using tools.',
  },
};
const tt = (lang) => TT[lang] || TT.tr;

function safeResolve(root, rel, lang) {
  const p = path.resolve(root, (rel || '.').trim().replace(/^["']|["']$/g, ''));
  const r = path.resolve(root);
  if (p !== r && !p.startsWith(r + path.sep)) throw new Error(tt(lang).outside(rel));
  return p;
}

function projectTree(root, maxEntries = 300, lang) {
  const lines = [];
  const walk = (dir, depth) => {
    if (lines.length >= maxEntries || depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length >= maxEntries) return;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
      lines.push(`${'  '.repeat(depth)}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  if (lines.length >= maxEntries) lines.push(tt(lang).treeTruncated);
  return lines.join('\n');
}

function grep(root, pattern, maxHits = 80, lang) {
  const hits = [];
  const needle = pattern.toLowerCase();
  const walk = (dir) => {
    if (hits.length >= maxHits) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= maxHits) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full);
        continue;
      }
      let text;
      try {
        const st = fs.statSync(full);
        if (st.size > 1024 * 1024) continue;
        const buf = fs.readFileSync(full);
        if (buf.subarray(0, 4096).includes(0)) continue;
        text = buf.toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
        if (lines[i].toLowerCase().includes(needle)) hits.push(`${path.relative(root, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    }
  };
  walk(root);
  return hits.length ? hits.join('\n') : tt(lang).noMatch;
}

function runBash(root, command, lang) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/bash';
    const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command];
    execFile(shell, args, { cwd: root, timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      let out = `${stdout || ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
      if (err && err.killed) out += `\n${tt(lang).timeout}`;
      else if (err) out += `\n${tt(lang).exitCode(err.code)}`;
      resolve(out.slice(0, 20000) || tt(lang).noOutput);
    });
  });
}

/** Model cevabındaki araç etiketlerini çıkarır. */
function parseToolCalls(text) {
  const calls = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    let m;
    if ((m = t.match(/^@@LS\b\s*(.*)$/i))) calls.push({ name: 'ls', args: { path: m[1] || '.' } });
    else if ((m = t.match(/^@@READ\s+(\S+)(?:\s+(\d+)\s*-\s*(\d+))?/i))) calls.push({ name: 'read', args: { path: m[1], from: m[2] && +m[2], to: m[3] && +m[3] } });
    else if ((m = t.match(/^@@GREP\s+(.+)$/i))) calls.push({ name: 'grep', args: { pattern: m[1].trim() } });
    else if ((m = t.match(/^@@BASH\s+(.+)$/i))) calls.push({ name: 'bash', args: { command: m[1].trim() } });
    else if ((m = t.match(/^@@(WRITE|EDIT)\s+(\S+)/i))) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^@@END\b/i.test(lines[j].trim())) break;
        body.push(lines[j]);
      }
      i = j;
      calls.push({ name: m[1].toLowerCase(), args: { path: m[2], body: body.join('\n') } });
    }
  }
  return calls;
}

async function executeTool(root, call, lang) {
  const { name, args } = call;
  const t = tt(lang);
  if (name === 'ls') {
    const p = safeResolve(root, args.path, lang);
    return fs.readdirSync(p, { withFileTypes: true }).map((e) => e.name + (e.isDirectory() ? '/' : '')).join('\n') || t.empty;
  }
  if (name === 'read') {
    const p = safeResolve(root, args.path, lang);
    let text = fs.readFileSync(p, 'utf8');
    if (args.from) text = text.split('\n').slice(args.from - 1, args.to || undefined).join('\n');
    if (text.length > MAX_READ_CHARS) text = text.slice(0, MAX_READ_CHARS) + `\n${t.readTruncated}`;
    return text;
  }
  if (name === 'grep') return grep(root, args.pattern, 80, lang);
  if (name === 'bash') return runBash(root, args.command, lang);
  if (name === 'write') {
    const p = safeResolve(root, args.path, lang);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, args.body.replace(/^\n/, ''), 'utf8');
    return t.written(args.path, args.body.length);
  }
  if (name === 'edit') {
    const p = safeResolve(root, args.path, lang);
    const m = args.body.match(/<<<<<<<[^\n]*\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>>/);
    if (!m) throw new Error(t.badEdit);
    const cur = fs.readFileSync(p, 'utf8');
    const norm = (s) => s.replace(/\r\n/g, '\n');
    const curN = norm(cur);
    if (!curN.includes(norm(m[1]))) throw new Error(t.notFound);
    let out = curN.replace(norm(m[1]), norm(m[2]));
    if (cur.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
    fs.writeFileSync(p, out, 'utf8');
    return t.edited(args.path);
  }
  throw new Error(t.unknownTool(name));
}

class TextAgent extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.cwd
   * @param {string} opts.provider
   * @param {string} opts.model
   * @param {string[]} opts.tools izin verilen araçlar
   * @param {string} opts.systemPrompt
   * @param {string} opts.sessionFile geçmişin saklandığı dosya
   * @param {Function} opts.callChat server.js callChatCompletion
   * @param {string} [opts.lang] ekibin dili (tr | en)
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.busy = false;
    this.lastUsed = Date.now();
    this.controller = null;
    try {
      this.history = JSON.parse(fs.readFileSync(opts.sessionFile, 'utf8'));
    } catch {
      this.history = [];
    }
  }

  _save() {
    // Geçmiş çok büyürse eskiyi at (ilk kullanıcı mesajı korunur).
    let total = this.history.reduce((n, m) => n + String(m.content).length, 0);
    while (total > MAX_HISTORY_CHARS && this.history.length > 4) {
      const removed = this.history.splice(1, 2);
      total -= removed.reduce((n, m) => n + String(m.content).length, 0);
    }
    fs.mkdirSync(path.dirname(this.opts.sessionFile), { recursive: true });
    fs.writeFileSync(this.opts.sessionFile, JSON.stringify(this.history), 'utf8');
  }

  async prompt(message) {
    this.busy = true;
    this.lastUsed = Date.now();
    this.controller = new AbortController();
    const allowed = new Set(this.opts.tools.map((t) => (t === 'find' ? 'ls' : t)));
    const lang = this.opts.lang;
    const t = tt(lang);
    const system = `${this.opts.systemPrompt}\n${t.doc}\n${t.allowedTools}: ${[...allowed].join(', ')}\n\n${t.projectTree} (${this.opts.cwd}):\n${projectTree(this.opts.cwd, 300, lang)}`;
    this.history.push({ role: 'user', content: message });
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const text = await this.opts.callChat({
          provider: this.opts.provider,
          model: this.opts.model,
          messages: [{ role: 'system', content: system }, ...this.history],
          signal: this.controller.signal,
          onDelta: (d) => this.emit('delta', d),
          lang,
        });
        this.history.push({ role: 'assistant', content: text });
        const calls = parseToolCalls(text);
        if (!calls.length) {
          this._save();
          return text;
        }
        const results = [];
        for (const call of calls) {
          this.emit('tool_start', { name: call.name, args: { ...call.args, body: call.args.body ? `(${call.args.body.length} karakter)` : undefined } });
          let out;
          let isError = false;
          try {
            if (!allowed.has(call.name) && !(call.name === 'grep' && allowed.has('read'))) throw new Error(t.toolDisabled(call.name));
            out = await executeTool(this.opts.cwd, call, lang);
          } catch (e) {
            out = `${t.errorPrefix}: ${e.message}`;
            isError = true;
          }
          this.emit('tool_end', { name: call.name, isError, output: String(out).slice(0, 4000) });
          results.push(`### ${call.name} ${call.args.path || call.args.pattern || call.args.command || ''}\n${out}`);
        }
        this.history.push({ role: 'user', content: `${t.toolResults}:\n${results.join('\n\n')}\n\n${t.continue}` });
        this._save();
      }
      this.history.push({ role: 'user', content: t.stepLimit });
      const final = await this.opts.callChat({
        provider: this.opts.provider,
        model: this.opts.model,
        messages: [{ role: 'system', content: system }, ...this.history],
        signal: this.controller.signal,
        lang,
      });
      this.history.push({ role: 'assistant', content: final });
      this._save();
      return final;
    } finally {
      this.busy = false;
      this.lastUsed = Date.now();
    }
  }

  abort() {
    this.controller?.abort();
  }

  dispose() {}
}

module.exports = { TextAgent, parseToolCalls, executeTool, projectTree };
