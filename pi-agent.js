// Pi coding-agent'ı RPC modunda alt süreç olarak çalıştıran istemci.
const { spawn } = require('node:child_process');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const { PI_AGENT_DIR, findPiCli, piProviderName } = require('./pi-config.js');
const { msg } = require('./i18n.js');

const TURN_TIMEOUT_MS = 10 * 60 * 1000;

class PiAgent extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.cwd proje klasörü
   * @param {string} opts.provider FreeAI Studio sağlayıcı id
   * @param {string} opts.model
   * @param {string[]} opts.tools
   * @param {string} opts.systemPromptFile
   * @param {string} opts.sessionDir
   * @param {string} [opts.lang] hata mesajlarının dili (tr | en)
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.proc = null;
    this.buffer = '';
    this.reqId = 0;
    this.pending = new Map();
    this.busy = false;
    this.lastUsed = Date.now();
    this.stderrTail = '';
  }

  start() {
    if (this.proc) return;
    const cli = findPiCli();
    if (!cli) throw new Error(msg(this.opts.lang, 'piCliMissing'));
    fs.mkdirSync(this.opts.sessionDir, { recursive: true });
    const args = [
      cli,
      '--mode', 'rpc',
      '--provider', this.opts.rawProvider ? this.opts.provider : piProviderName(this.opts.provider),
      '--model', this.opts.model,
      ...(this.opts.thinkingLevel ? ['--thinking', this.opts.thinkingLevel] : []),
      '--tools', this.opts.tools.join(','),
      '--append-system-prompt', this.opts.systemPromptFile,
      '--session-dir', this.opts.sessionDir,
      '--continue',
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--approve',
    ];
    this.proc = spawn(process.execPath, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: PI_AGENT_DIR, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    this.proc.on('exit', (code) => {
      const err = new Error(msg(this.opts.lang, 'piExited', code, this.stderrTail.slice(-800)));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      if (this._turn) this._turn.reject(err);
      this.proc = null;
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    // Sadece LF ile böl (U+2028 JSON içinde geçerli olabilir).
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      this._onRecord(rec);
    }
  }

  _onRecord(rec) {
    if (rec.type === 'response') {
      const p = rec.id && this.pending.get(rec.id);
      if (p) {
        this.pending.delete(rec.id);
        rec.success ? p.resolve(rec.data) : p.reject(new Error(rec.error || msg(this.opts.lang, 'piCommandFailed')));
      }
      return;
    }
    const turn = this._turn;
    if (rec.type === 'message_update' && rec.assistantMessageEvent?.type === 'text_delta') {
      if (turn) turn.text += rec.assistantMessageEvent.delta;
      this.emit('delta', rec.assistantMessageEvent.delta);
    } else if (rec.type === 'message_start' && rec.message?.role === 'assistant') {
      if (turn) turn.text = ''; // sadece son asistan mesajının metni önemli
    } else if (rec.type === 'message_end' && rec.message?.role === 'assistant') {
      if (turn && rec.message.errorMessage) turn.error = rec.message.errorMessage;
    } else if (rec.type === 'tool_execution_start') {
      this.emit('tool_start', { name: rec.toolName, args: rec.args });
    } else if (rec.type === 'tool_execution_end') {
      const text = (rec.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      this.emit('tool_end', { name: rec.toolName, isError: rec.isError, output: text.slice(0, 4000) });
    } else if (rec.type === 'agent_settled') {
      if (turn) {
        this._turn = null;
        clearTimeout(turn.timer);
        if (!turn.text.trim() && turn.error) turn.reject(new Error(turn.error));
        else turn.resolve(turn.text);
      }
    }
  }

  _send(cmd) {
    const id = `r${++this.reqId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
    });
  }

  /** Bir prompt gönderir, ajan tamamen durana kadar bekler, son asistan metnini döndürür. */
  async prompt(message, images) {
    this.start();
    this.busy = true;
    this.lastUsed = Date.now();
    try {
      const done = new Promise((resolve, reject) => {
        this._turn = { text: '', error: null, resolve, reject };
        this._turn.timer = setTimeout(() => {
          this.abort();
          reject(new Error(msg(this.opts.lang, 'piTurnTimeout')));
        }, TURN_TIMEOUT_MS);
      });
      const data = await this._send({ type: 'prompt', message, ...(images?.length ? { images } : {}) });
      if (data?.disposition === 'handled') {
        clearTimeout(this._turn.timer);
        this._turn = null;
        return '';
      }
      return await done;
    } finally {
      this.busy = false;
      this.lastUsed = Date.now();
    }
  }

  abort() {
    if (this.proc) this._send({ type: 'abort' }).catch(() => {});
  }

  dispose() {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {}
    const p = this.proc;
    setTimeout(() => {
      try {
        p.kill();
      } catch {}
    }, 3000);
    this.proc = null;
  }
}

module.exports = { PiAgent };
