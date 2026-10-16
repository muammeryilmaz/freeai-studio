const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { normalizeLang } = require('./i18n.js');
const { ROLE_PRESETS_BY_LANG, PROTOCOL_DOC, COMMON_GUIDE, ROLE_GUIDANCE, TEXT } = require('./team-prompts.js');

const TEAMS_DIR = path.join(process.env.FREEAI_DATA_DIR || path.join(__dirname, 'data'), 'teams');
fs.mkdirSync(TEAMS_DIR, { recursive: true });

const DOCS_REL = path.join('docs', 'agile');
const ALL_TOOLS = ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'];
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const AGENT_IDLE_MS = 10 * 60 * 1000;

/** Ekibin dili: kurulurken seçilir; eski ekiplerde alan yoksa Türkçe. */
const teamLang = (team) => normalizeLang(team?.lang || 'tr'); // Dil alanı olmayan eski ekipler Türkçe kurulmuştu
const T = (team) => TEXT[teamLang(team)];
const rolePresets = (lang) => ROLE_PRESETS_BY_LANG[normalizeLang(lang)];
const ROLE_PRESETS = ROLE_PRESETS_BY_LANG.en;

/** Role özel çalışma rehberi — mevcut ekiplerde de geçerli olması için çalışma anında eklenir. */
function roleGuidance(role, lang = 'en') {
  const guides = ROLE_GUIDANCE[normalizeLang(lang)];
  return (role.isPO ? guides.po : guides[role.preset]) || '';
}

class TeamStore {
  static list() {
    try {
      return fs
        .readdirSync(TEAMS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, f), 'utf8'));
            return { id: d.id, name: d.name, createdAt: d.createdAt, status: d.status, projectPath: d.projectPath, rolesCount: d.roles.length, lang: teamLang(d) };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  static get(teamId) {
    if (!/^[\w-]+$/.test(teamId)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, `${teamId}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  static save(team) {
    const file = path.join(TEAMS_DIR, `${team.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(team, null, 2), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  }

  static delete(teamId) {
    if (!/^[\w-]+$/.test(teamId)) return false;
    const file = path.join(TEAMS_DIR, `${teamId}.json`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    fs.rmSync(path.join(TEAMS_DIR, teamId), { recursive: true, force: true });
    return true;
  }

  static dir(teamId) {
    return path.join(TEAMS_DIR, teamId);
  }
}

function getChannelKey(fromId, toId) {
  if (toId === 'all') return 'team';
  if ((fromId === 'user' && toId === 'po') || (fromId === 'po' && toId === 'user')) return 'po';
  return `dm:${[fromId, toId].sort().join('|')}`;
}

function normalizeRoleTarget(target, roles) {
  if (!target) return null;
  const t = target.trim().toLowerCase().replace(/["']/g, '');
  if (['all', 'herkes', 'ekip', 'everyone', 'team'].includes(t)) return 'all';
  if (['user', 'kullanici', 'kullanıcı', 'musteri', 'müşteri', 'customer'].includes(t)) return 'user';
  if (['system', 'sistem'].includes(t)) return 'system';
  for (const r of roles) if ([r.id, r.name, r.preset].some((v) => v.toLowerCase() === t)) return r.id;
  for (const r of roles) if (r.name.toLowerCase().includes(t) || r.id.toLowerCase().startsWith(t)) return r.id;
  return null;
}

/**
 * Mesaj türü: "görev" | "soru" | "sonuç" | "bilgi" (iç değerler; İngilizce karşılıkları da kabul edilir).
 * Gönderen @@SEND bloğunda kind= ile açıkça belirtir; belirtmemişse yapısal işaretlerden çıkarılır:
 * "GÖREV:"/"TASK:" önekiyse görev, son satırı soru işaretiyle bitiyorsa soru, aksi halde sonuç.
 * Kelime listesi kullanılmaz: karşı tarafı uyandırıp uyandırmayacağına bu tür ve açık istekler karar verir.
 */
const KIND_ALIASES = {
  görev: 'görev', gorev: 'görev', task: 'görev',
  soru: 'soru', question: 'soru',
  sonuç: 'sonuç', sonuc: 'sonuç', result: 'sonuç',
  bilgi: 'bilgi', info: 'bilgi',
};
function normalizeKind(raw) {
  if (!raw) return null;
  return KIND_ALIASES[String(raw).trim().toLocaleLowerCase('tr')] || null;
}
function inferMessageKind(text) {
  if (isTaskMessage(text)) return 'görev';
  // Uzun bir sonucun içindeki retorik soru işareti karşı tarafı uyandırmasın: yalnızca son satıra bakılır.
  const lastLine = String(text || '').trim().split('\n').pop() || '';
  if (/\?\s*$/.test(lastLine)) return 'soru';
  return 'sonuç';
}

/** İki metin arasındaki kelime benzerliği (Jaccard, 0..1). Tekrar eden mesajları yakalamak için. */
function textSimilarity(a, b) {
  const tokens = (s) => new Set(String(s || '').toLocaleLowerCase('tr').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1));
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Bu mesaj yeni bir tur başlatmayı gerektiriyor mu? (noReply: routing'de yanıt gerektirmediği işaretlenmiş mesajlar) */
function isActionableMessage(m) {
  return Boolean(m) && !m.noReply;
}

/** PO'nun yeni görev mesajı mı? ("GÖREV:" / "TASK:" ile başlayan tanımlı işler) */
function isTaskMessage(text) {
  return /(^|\n)\s*((yeni\s+)?görev|(new\s+)?task)\s*[:：]/i.test(String(text || ''));
}

// Döngü korumaları. Hepsi kullanıcının her yeni mesajında sıfırlanır; ekip içi mesajlar hiçbirini sıfırlayamaz.
// Böylece bir kullanıcı mesajı en fazla PO_TURN_CAP + ROLE_TOTAL_CAP × (rol sayısı - 1) tur üretebilir.
const ROLE_TURN_CAP = 4; // Bir görev başına rolün en fazla turu (PO'nun yeni görevi bu sayacı sıfırlar)
const ROLE_TOTAL_CAP = 6; // Bir kullanıcı isteği başına PO dışındaki bir rolün mutlak tur sınırı (hiçbir görev sıfırlayamaz)
const PO_TURN_CAP = 10; // Bir kullanıcı isteği başına PO'nun mutlak tur sınırı; son tur yalnızca nihai rapor içindir
const PAIR_LIMIT = 8; // Kullanıcıdan yeni girdi gelmeden iki rol arasında uyandırabilecek en fazla mesaj (devre kesici)
const DUPLICATE_SIMILARITY = 0.9; // Bir rolün aynı kanala art arda bu benzerlikte yazdığı mesaj tekrar sayılır

/** Rolün kuyruğundaki bu mesaj onu yeni tura uyandırmalı mı? */
function isWakeableMessage(team, role, m) {
  if (!isActionableMessage(m)) return false;
  if (m.from === 'user') return true; // Kullanıcının mesajı her zaman uyandırır (ve sayaçları sıfırlar)
  const count = team.turnCounts?.[role.id] || 0;
  if (role.isPO) return count < PO_TURN_CAP;
  if ((team.roleTotals?.[role.id] || 0) >= ROLE_TOTAL_CAP) return false;
  if (count < ROLE_TURN_CAP) return true;
  // Görev başına tur limiti dolunca yalnızca PO'nun yeni görev mesajları uyandırır.
  return m.task === true;
}

function parseActions(text, role, team) {
  const actions = [];
  const lines = text.split('\n');
  let cur = null;
  let buf = [];
  const flush = () => {
    if (cur) {
      cur.content = buf.join('\n').trim();
      actions.push(cur);
    }
    cur = null;
    buf = [];
  };
  for (const line of lines) {
    const t = line.trim();
    const send = t.match(/^@@SEND\s+to\s*=\s*["']?([^\s"'@]+)/i);
    const dec = t.match(/^@@DECISION\b/i);
    const user = /^@@USER\b/i.test(t);
    const status = /^@@STATUS\b/i.test(t);
    const idle = /^@@IDLE\b/i.test(t);
    const end = /^@@END\b/i.test(t);
    if (send || dec || user || status || idle || end) flush();
    if (send) {
      const target = normalizeRoleTarget(send[1], team.roles);
      cur = { type: 'send', to: target, rawTo: send[1], kind: normalizeKind(t.match(/\bkind\s*=\s*["']?([^\s"']+)/i)?.[1]) };
    } else if (dec) {
      const title = t.match(/title\s*=\s*["']([^"']+)["']/i)?.[1] || t.match(/title\s*=\s*(\S+)/i)?.[1] || T(team).defaultDecisionTitle;
      const category = t.match(/category\s*=\s*["']?([^"'\s]+)/i)?.[1] || 'genel';
      cur = { type: 'decision', title, category };
    } else if (user) cur = { type: 'user' };
    else if (status) cur = { type: 'status' };
    else if (idle) actions.push({ type: 'idle' });
    else if (!end && cur) buf.push(line);
  }
  flush();

  if (!actions.length && text.trim()) {
    actions.push(role.isPO ? { type: 'user', content: text.trim() } : { type: 'send', to: 'po', content: text.trim() });
  }
  return actions;
}

function rolePromptText(team, role) {
  const lang = teamLang(team);
  const t = TEXT[lang];
  const roster = team.roles.map((r) => `- ${r.id}: ${r.name}`).join('\n');
  return `${t.promptIntro(team.name, role)}
${t.promptCwd(team.projectPath)}
${t.promptRoster}
${roster}

${role.prompt}
${t.promptOwnDoc(role.docFile)}
${PROTOCOL_DOC[lang]}
${COMMON_GUIDE[lang]}
${roleGuidance(role, lang)}`;
}

class TeamOrchestrator extends EventEmitter {
  /**
   * @param {object} deps
   * @param {Function} deps.createAgent (team, role, onEvent) => agent  ({prompt, abort, dispose, busy, lastUsed})
   */
  constructor(deps) {
    super();
    this.createAgent = deps.createAgent;
    this.agents = new Map(); // `${teamId}:${roleId}` -> agent
    this.running = new Map(); // `${teamId}:${roleId}` -> çalışan worker promise'i
    this.pumps = new Map(); // teamId -> pump timeout
    this.aborting = new Set(); // kasıtlı iptal edilen tur anahtarları
    this.setMaxListeners(100);
    setInterval(() => this._reapIdle(), 60000).unref();
  }

  _agentKey(teamId, roleId) {
    return `${teamId}:${roleId}`;
  }

  isRoleBusy(teamId, roleId) {
    return this.running.has(this._agentKey(teamId, roleId));
  }

  anyRoleBusy(teamId) {
    const prefix = `${teamId}:`;
    for (const key of this.running.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  _reapIdle() {
    for (const [key, a] of this.agents) {
      if (!a.busy && !this.running.has(key) && Date.now() - a.lastUsed > AGENT_IDLE_MS) {
        a.dispose();
        this.agents.delete(key);
      }
    }
  }

  disposeTeamAgents(teamId) {
    const prefix = `${teamId}:`;
    for (const key of [...this.running.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.aborting.add(key);
      this.agents.get(key)?.abort();
    }
    for (const [key, a] of this.agents) {
      if (key.startsWith(prefix)) {
        a.dispose();
        this.agents.delete(key);
      }
    }
    clearTimeout(this.pumps.get(teamId));
    this.pumps.delete(teamId);
  }

  disposeAll() {
    for (const a of this.agents.values()) a.dispose();
    this.agents.clear();
    for (const t of this.pumps.values()) clearTimeout(t);
    this.pumps.clear();
  }

  emitEvent(teamId, type, data = {}) {
    this.emit(`event:${teamId}`, { type, ...data, timestamp: Date.now() });
  }

  createTeam({ name, projectPath, roles, budgetLimit = 25, lang }) {
    lang = normalizeLang(lang);
    const presets = rolePresets(lang);
    const t = TEXT[lang];
    const id = `team_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const used = new Set();
    const assigned = roles.map((r) => {
      const preset = presets[r.preset] || presets.custom;
      let rid = r.preset === 'po' ? 'po' : r.preset;
      let n = 2;
      while (used.has(rid)) rid = `${r.preset}_${n++}`;
      used.add(rid);
      return {
        id: rid,
        preset: r.preset,
        name: r.name || preset.name,
        isPO: r.preset === 'po',
        color: preset.color,
        provider: r.provider,
        model: r.model,
        mode: r.mode === 'text' && !String(r.provider).startsWith('pi:') ? 'text' : 'pi',
        thinking: THINKING_LEVELS.includes(r.thinking) ? r.thinking : '',
        tools: Array.isArray(r.tools) && r.tools.length ? r.tools.filter((x) => ALL_TOOLS.includes(x)) : [...ALL_TOOLS],
        prompt: r.prompt || preset.systemPrompt,
        docFile: rid === r.preset ? preset.docFile : preset.docFile.replace('.md', `-${rid}.md`),
      };
    });
    if (!assigned.some((r) => r.isPO)) throw new Error(t.needPO);

    const team = {
      id,
      name: name || t.defaultTeamName,
      lang,
      projectPath: path.resolve(projectPath),
      createdAt: Date.now(),
      status: 'idle',
      budget: { limit: budgetLimit, used: 0 },
      roles: assigned,
      channels: { po: [], team: [] },
      inbox: Object.fromEntries(assigned.map((r) => [r.id, []])),
      board: { status: t.initialStatus, decisions: [] },
      fileChanges: [],
      log: [],
      nudges: {},
    };
    fs.mkdirSync(path.join(team.projectPath, DOCS_REL), { recursive: true });
    TeamStore.save(team);
    return team;
  }

  updateRoles(teamId, roles) {
    const team = TeamStore.get(teamId);
    if (!team) throw new Error(TEXT.tr.teamNotFound);
    for (const upd of roles) {
      const r = team.roles.find((x) => x.id === upd.id);
      if (!r) continue;
      if (upd.provider) r.provider = upd.provider;
      if (upd.model) r.model = upd.model;
      if (upd.mode) r.mode = upd.mode === 'text' && !String(r.provider || upd.provider).startsWith('pi:') ? 'text' : 'pi';
      if (typeof upd.thinking === 'string') r.thinking = THINKING_LEVELS.includes(upd.thinking) ? upd.thinking : '';
      if (Array.isArray(upd.tools)) r.tools = upd.tools.filter((t) => ALL_TOOLS.includes(t));
    }
    this.disposeTeamAgents(teamId);
    TeamStore.save(team);
    return team;
  }

  getAgent(team, role) {
    const key = `${team.id}:${role.id}`;
    let agent = this.agents.get(key);
    const sig = `${role.mode}|${role.provider}|${role.model}|${role.tools.join(',')}|${role.thinking || ''}`;
    if (agent && agent.sig !== sig) {
      agent.dispose();
      agent = null;
    }
    if (!agent) {
      const promptDir = path.join(TeamStore.dir(team.id), 'prompts');
      fs.mkdirSync(promptDir, { recursive: true });
      const promptFile = path.join(promptDir, `${role.id}.md`);
      const promptText = rolePromptText(team, role);
      fs.writeFileSync(promptFile, promptText, 'utf8');
      agent = this.createAgent({
        team,
        role,
        promptFile,
        promptText,
        sessionDir: path.join(TeamStore.dir(team.id), 'sessions', role.id),
      });
      agent.sig = sig;
      agent.on('delta', (delta) => this.emitEvent(team.id, 'turn_delta', { roleId: role.id, delta }));
      agent.on('tool_start', (t) => this.emitEvent(team.id, 'tool_start', { roleId: role.id, roleName: role.name, tool: t }));
      agent.on('tool_end', (t) => {
        this.emitEvent(team.id, 'tool_end', { roleId: role.id, roleName: role.name, tool: t });
      });
      this.agents.set(key, agent);
    }
    return agent;
  }

  async handleUserMessage(teamId, text, attachments = []) {
    const team = TeamStore.get(teamId);
    if (!team) throw new Error(TEXT.tr.teamNotFound);
    const t = T(team);
    const msg = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      channel: 'po',
      from: 'user',
      fromName: t.userName,
      to: 'po',
      text: text.trim(),
      attachments,
      ts: Date.now(),
    };
    team.channels.po.push(msg);
    const po = team.roles.find((r) => r.isPO);
    team.inbox[po.id].push(msg);
    team.budget.used = 0;
    // Kullanıcı yeni girdi verdi: tüm döngü sayaçları ve devre kesiciler sıfırlanır.
    team.nudges = {};
    team.infoNudges = {};
    team.turnCounts = {};
    team.roleTotals = {};
    team.pairCounts = {};
    team.capNotified = {};
    team.poAwaitingUser = false;
    team.status = 'running';
    TeamStore.save(team);
    this.emitEvent(teamId, 'message', { channel: 'po', message: msg });
    this.emitEvent(teamId, 'status_change', { status: team.status, budget: team.budget });
    // PO meşgulse mesaj kuyruğa alınır; kullanıcıya bunu bildir.
    if (this.isRoleBusy(teamId, po.id)) {
      this.emitEvent(teamId, 'queued', {
        roleId: po.id,
        roleName: po.name,
        messageId: msg.id,
        message: t.queued(po.name),
      });
    }
    this.pump(teamId, 30);
    return msg;
  }

  async control(teamId, action) {
    const team = TeamStore.get(teamId);
    if (!team) throw new Error(TEXT.tr.teamNotFound);
    const abortActive = () => {
      const prefix = `${teamId}:`;
      for (const key of [...this.running.keys()]) {
        if (!key.startsWith(prefix)) continue;
        this.aborting.add(key);
        this.agents.get(key)?.abort();
      }
    };
    if (action === 'pause') {
      team.status = 'paused';
      abortActive();
    } else if (action === 'resume') {
      team.status = 'running';
    } else if (action === 'stop') {
      team.status = 'idle';
      abortActive();
      for (const k of Object.keys(team.inbox)) team.inbox[k] = [];
      team.poAwaitingUser = false;
    } else if (action === 'extend') {
      team.budget.limit += 25;
      team.status = 'running';
    }
    TeamStore.save(team);
    this.emitEvent(teamId, 'status_change', { status: team.status, budget: team.budget });
    if (team.status === 'running') this.pump(teamId, 50);
    return team;
  }

  /** İşleri kuyruklardan alıp uygun roller için eşzamanlı worker'lar başlatır. */
  pump(teamId, delay = 30) {
    clearTimeout(this.pumps.get(teamId));
    const timer = setTimeout(() => {
      this.pumps.delete(teamId);
      this._pumpNow(teamId);
    }, delay);
    this.pumps.set(teamId, timer);
  }

  _pumpNow(teamId) {
    const team = TeamStore.get(teamId);
    if (!team || team.status !== 'running') return;
    // Yalnızca yanıt gerektiren ve tur limiti uygun olan mesajlar yeni tur başlatır.
    const pending = team.roles.filter((r) => (team.inbox[r.id] || []).some((m) => isWakeableMessage(team, r, m)));
    if (!pending.length) {
      this._settleStatus(teamId);
      return;
    }
    if (team.budget.used >= team.budget.limit) {
      this._pauseForBudget(team);
      return;
    }
    for (const role of pending) {
      if (!this.running.has(this._agentKey(teamId, role.id))) this._startWorker(teamId, role.id);
    }
  }

  _pauseForBudget(team) {
    team.status = 'paused';
    TeamStore.save(team);
    this.emitEvent(team.id, 'budget_exhausted', { budget: team.budget, message: T(team).budgetExhausted(team.budget.limit) });
    this.emitEvent(team.id, 'status_change', { status: team.status, budget: team.budget });
  }

  /** Tüm kuyruklar boş ve çalışan worker yoksa ekibi idle/waiting_user durumuna getirir. */
  _settleStatus(teamId) {
    if (this.anyRoleBusy(teamId)) return;
    const team = TeamStore.get(teamId);
    if (!team || team.status !== 'running') return;
    if (team.roles.some((r) => (team.inbox[r.id] || []).some((m) => isWakeableMessage(team, r, m)))) {
      this.pump(teamId, 30);
      return;
    }
    team.status = team.poAwaitingUser ? 'waiting_user' : 'idle';
    TeamStore.save(team);
    this.emitEvent(teamId, 'status_change', { status: team.status, budget: team.budget });
  }

  _startWorker(teamId, roleId) {
    const key = this._agentKey(teamId, roleId);
    if (this.running.has(key)) return;
    const promise = (async () => {
      // Bir rol kendi kuyruğunu sırayla işler; farklı roller eşzamanlı çalışır.
      for (;;) {
        const team = TeamStore.get(teamId);
        if (!team || team.status !== 'running') return;
        if (team.budget.used >= team.budget.limit) return; // pump bütçe duraklatmasını yönetir
        const role = team.roles.find((r) => r.id === roleId);
        if (!role) return;
        if (!(team.inbox[roleId] || []).some((m) => isWakeableMessage(team, role, m))) return; // tur limiti / bilgi mesajı kontrolü
        await this.runTurn(teamId, roleId);
      }
    })()
      .catch((err) => this._onWorkerError(teamId, roleId, err))
      .finally(() => {
        this.running.delete(key);
        this.pump(teamId, 30);
      });
    this.running.set(key, promise);
  }

  _onWorkerError(teamId, roleId, err) {
    const key = this._agentKey(teamId, roleId);
    if (this.aborting.has(key)) {
      this.aborting.delete(key);
      return;
    }
    console.error(`Worker error (${key}):`, err);
    try {
      const team = TeamStore.get(teamId);
      if (!team) return;
      if (team.status === 'running') {
        team.status = 'paused';
        TeamStore.save(team);
        const role = team.roles.find((r) => r.id === roleId);
        this.emitEvent(teamId, 'turn_error', { roleId, roleName: role?.name || roleId, error: T(team).unexpectedError(err.message) });
        this.emitEvent(teamId, 'status_change', { status: 'paused', budget: team.budget });
      }
    } catch (e2) {
      console.error(`Worker recovery error (${key}):`, e2);
    }
  }

  /** Tur başlangıcı: gelen kutusunu boşalt, bütçeyi ve tur sayaçlarını düş (senkron kritik bölge). */
  _beginTurn(teamId, roleId) {
    const team = TeamStore.get(teamId);
    if (!team || team.status !== 'running') return null;
    const role = team.roles.find((r) => r.id === roleId);
    if (!role) return null;
    const inbox = team.inbox[roleId] || [];
    if (!inbox.length) return null;
    if (team.budget.used >= team.budget.limit) {
      this._pauseForBudget(team);
      return null;
    }
    team.inbox[roleId] = [];
    team.budget.used++;
    team.turnCounts = team.turnCounts || {};
    team.turnCounts[roleId] = (team.turnCounts[roleId] || 0) + 1;
    if (!role.isPO) {
      team.roleTotals = team.roleTotals || {};
      team.roleTotals[roleId] = (team.roleTotals[roleId] || 0) + 1;
    }
    TeamStore.save(team);
    this.emitEvent(teamId, 'turn_start', { roleId, roleName: role.name, budget: team.budget, mode: role.mode });
    return { team, role, inbox };
  }

  /** Bir tur: prompt çalıştır (asenkron), sohbet sonrası işlemler senkron. */
  async runTurn(teamId, roleId) {
    const started = this._beginTurn(teamId, roleId);
    if (!started) return;
    const { role, inbox } = started;
    const { text: turnText, images } = this.buildTurnMessage(started.team, role, inbox);
    const tools = [];
    const toolListener = (e) => {
      if (e.roleId !== roleId) return;
      if (e.type === 'tool_end') tools.push(e.tool);
      if (e.type === 'tool_start') tools.push({ ...e.tool, phase: 'start' });
    };
    this.on(`event:${teamId}`, toolListener);

    let response = '';
    let error = null;
    try {
      response = await this.getAgent(started.team, role).prompt(turnText, images);
    } catch (e) {
      error = e.message;
      // Pi modunda araç çağrısı hatası → metin moduna geç ve tekrar dene.
      if (role.mode === 'pi' && /tool|function.?call/i.test(error)) {
        this.emitEvent(teamId, 'notice', { message: T(started.team).switchedToText(role.name) });
        const fresh = TeamStore.get(teamId);
        const freshRole = fresh?.roles.find((r) => r.id === roleId);
        if (fresh && freshRole) {
          freshRole.mode = 'text';
          TeamStore.save(fresh);
          role.mode = 'text';
          try {
            response = await this.getAgent(fresh, role).prompt(turnText, images);
            error = null;
          } catch (e2) {
            error = e2.message;
          }
        }
      }
    } finally {
      this.off(`event:${teamId}`, toolListener);
    }

    this._finishTurn({ teamId, roleId, inbox, turnText, response, error, tools, roleName: role.name, mode: role.mode });
  }

  /** Tur sınırına ulaşan role ait bildirimi (kullanıcı mesajı başına bir kez) gönderir. */
  _notifyCapReached(team, role) {
    const capped = role.isPO ? (team.turnCounts?.[role.id] || 0) >= PO_TURN_CAP : (team.roleTotals?.[role.id] || 0) >= ROLE_TOTAL_CAP;
    if (!capped) return;
    team.capNotified = team.capNotified || {};
    if (team.capNotified[role.id]) return;
    team.capNotified[role.id] = true;
    const t = T(team);
    const message = role.isPO ? t.poCapNotice(role.name, PO_TURN_CAP) : t.roleCapNotice(role.name, ROLE_TOTAL_CAP);
    this.emitEvent(team.id, 'notice', { message });
  }

  /** Tur bitişi: yanıtı ayrıştır, mesajları dağıt, durum ve log güncelle (senkron). */
  _finishTurn({ teamId, roleId, inbox, turnText, response, error, tools, roleName, mode }) {
    const team = TeamStore.get(teamId);
    if (!team) {
      this.aborting.delete(this._agentKey(teamId, roleId));
      return;
    }
    const role = team.roles.find((r) => r.id === roleId);
    if (!role) return;
    const t = T(team);

    const finished = tools.filter((x) => !x.phase);
    const startArgs = tools.filter((x) => x.phase === 'start');
    startArgs.forEach((x) => {
      if (['write', 'edit'].includes(x.name) && x.args?.path) {
        team.fileChanges.push({ ts: Date.now(), roleId, roleName, tool: x.name, path: x.args.path });
      }
    });
    const logEntry = {
      ts: Date.now(),
      roleId,
      roleName,
      mode,
      prompt: turnText,
      response,
      tools: startArgs.map((x, i) => ({ ...x, result: finished[i] })),
      error: error || null,
    };
    team.log.push(logEntry);
    if (team.log.length > 300) team.log = team.log.slice(-300);

    const key = this._agentKey(teamId, roleId);
    const aborted = this.aborting.delete(key);

    if (error) {
      if (aborted) {
        // Kasıtlı iptal (duraklat/durdur): kullanıcıya hata gösterme.
        if (team.status !== 'idle') team.inbox[roleId] = [...inbox, ...(team.inbox[roleId] || [])];
        TeamStore.save(team);
        this.emitEvent(teamId, 'turn_aborted', { roleId, roleName });
        this.pump(teamId, 30);
        return;
      }
      team.inbox[roleId] = [...inbox, ...(team.inbox[roleId] || [])];
      if (team.status === 'running') team.status = 'paused';
      TeamStore.save(team);
      this.emitEvent(teamId, 'turn_error', { roleId, roleName, error });
      this.emitEvent(teamId, 'status_change', { status: team.status, budget: team.budget });
      return;
    }

    // PO son turundaysa gönderdiği görevler kimseyi uyandırmaz: yalnızca nihai rapor beklenir.
    const poFinalTurn = role.isPO && (team.turnCounts?.[roleId] || 0) >= PO_TURN_CAP;

    const actions = parseActions(response, role, team);
    logEntry.actions = actions;
    let announced = false;
    for (const act of actions) {
      if (act.type === 'send') {
        if (act.to === 'system') continue; // Sistem notlarına yanıt verilmez
        // PO'nun kendine yazdığı mesaj aslında kullanıcıya yazılmak istenmiştir; diğer roller için anlamsızdır.
        if (act.to === role.id) {
          if (!role.isPO) continue;
          act.to = 'user';
        }
        if (!act.to) {
          // Hedef çözümlenemedi (yazım hatası vb.) — mesaj kaybolmasın diye PO'ya/kullanıcıya yönlendir.
          act.to = role.isPO ? 'user' : 'po';
          act.content = `${t.unknownTarget(act.rawTo)}\n${act.content}`;
        }
        if (act.to === 'user') {
          act.type = role.isPO ? 'user' : 'send';
          if (!role.isPO) act.to = 'po';
        }
      }
      if (act.type === 'send') {
        const ch = getChannelKey(role.id, act.to);
        const kind = act.kind || inferMessageKind(act.content);
        const targetName = team.roles.find((r) => r.id === act.to)?.name || act.to;
        const history = team.channels[ch] || [];

        // Aynı rolün aynı kanala neredeyse aynı içeriği tekrar yazması: düşür (kelime listesi değil, içerik benzerliği).
        const last = act.to !== 'all' ? [...history].reverse().find((h) => h.from === role.id) : null;
        if (last && textSimilarity(last.text, act.content) >= DUPLICATE_SIMILARITY) {
          this.emitEvent(teamId, 'notice', { message: t.duplicateBlocked(role.name, targetName) });
          continue;
        }

        // Açık istek takibi: "owed[X>Y]" = X, Y'ye yanıt borçlu. Görev/soru yanıt borcu doğurur; yanıt borcu olan birine yazmak onu uyandırır.
        const owedKey = `${role.id}>${act.to}`;
        const owed = act.to !== 'all' && Boolean(team.owed?.[owedKey]);
        const asks = kind === 'görev' || kind === 'soru';
        if (asks && act.to !== 'all' && !poFinalTurn) {
          team.owed = team.owed || {};
          team.owed[`${act.to}>${role.id}`] = true;
        }
        if (owed) delete team.owed[owedKey];

        // Uyandırma kararı yapısal: görev/soru her zaman, sonuç/bilgi yalnızca açık bir isteğe yanıtsa.
        let wake = !poFinalTurn && (act.to === 'all' ? kind === 'görev' : asks || owed);

        // Döngü devre kesici: kullanıcıdan yeni girdi gelmeden bu kanalda çok fazla uyandırma olursa dur.
        let loopBlocked = false;
        if (wake) {
          team.pairCounts = team.pairCounts || {};
          const n = (team.pairCounts[ch] || 0) + 1;
          team.pairCounts[ch] = n;
          if (n > PAIR_LIMIT) {
            wake = false;
            loopBlocked = n === PAIR_LIMIT + 1; // PO'ya bildirim yalnızca bir kez gider
          }
        }

        // Yalnızca PO'nun görevi hedef rolün görev başına tur sayacını sıfırlar; mutlak sayaç (roleTotals) hiç sıfırlanmaz.
        const task = wake && kind === 'görev' && role.isPO;
        const msg = { id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, channel: ch, from: role.id, fromName: role.name, to: act.to, text: act.content, ts: Date.now(), kind, ...(wake ? {} : { noReply: true }), ...(task ? { task: true } : {}) };
        (team.channels[ch] ||= []).push(msg);
        const targets = act.to === 'all' ? team.roles.filter((r) => r.id !== role.id).map((r) => r.id) : [act.to];
        for (const target of targets) {
          if (team.inbox[target]) team.inbox[target].push(msg);
          const targetRole = team.roles.find((x) => x.id === target);
          if (task && targetRole && !targetRole.isPO) {
            team.turnCounts = team.turnCounts || {};
            team.turnCounts[target] = 0;
          }
        }
        if (loopBlocked && team.inbox.po) {
          team.inbox.po.push({
            id: `msg_${Date.now()}_loop`,
            channel: 'system',
            from: 'system',
            fromName: t.systemName,
            to: 'po',
            text: t.loopSuspect(role.name, targetName, PAIR_LIMIT),
            ts: Date.now(),
          });
          this.emitEvent(teamId, 'notice', { message: t.loopNotice(role.name, targetName) });
        }
        this.emitEvent(teamId, 'message', { channel: ch, message: msg });
        announced = true;
      } else if (act.type === 'user' && role.isPO) {
        const msg = { id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, channel: 'po', from: role.id, fromName: role.name, to: 'user', text: act.content, ts: Date.now() };
        team.channels.po.push(msg);
        team.poAwaitingUser = true;
        this.emitEvent(teamId, 'message', { channel: 'po', message: msg });
        announced = true;
      } else if (act.type === 'decision') {
        if (role.isPO) {
          const d = { id: `D-${team.board.decisions.length + 1}`, title: act.title, category: act.category, decision: act.content, author: role.name, ts: Date.now() };
          team.board.decisions.push(d);
          this.writeDecisionsFile(team);
          this.emitEvent(teamId, 'decision_added', { decision: d });
        } else {
          const ch = getChannelKey(role.id, 'po');
          const msg = { id: `msg_${Date.now()}`, channel: ch, from: role.id, fromName: role.name, to: 'po', text: `${t.decisionProposal} ${act.title} (${act.category})\n${act.content}`, ts: Date.now() };
          (team.channels[ch] ||= []).push(msg);
          team.inbox.po.push(msg);
          this.emitEvent(teamId, 'message', { channel: ch, message: msg });
        }
        announced = true;
      } else if (act.type === 'status' && role.isPO && act.content) {
        team.board.status = act.content;
        this.writeStatusFile(team);
        this.emitEvent(teamId, 'board_status_updated', { status: act.content });
        announced = true;
      }
    }

    // Mesaj aldı ama yazılı yanıt üretmedi: yalnızca gerçekten yanıt bekleyen mesaj varsa dürt/özetle.
    const needsReply = inbox.some(isActionableMessage);
    if (announced) delete team.nudges?.[roleId];
    if (!announced && needsReply) {
      team.nudges = team.nudges || {};
      const nudgeCount = team.nudges[roleId] || 0;
      if (nudgeCount < 1 && !poFinalTurn) {
        team.nudges[roleId] = nudgeCount + 1;
        const nudge = {
          id: `msg_${Date.now()}_nudge`,
          channel: 'system',
          from: 'system',
          fromName: t.systemName,
          to: roleId,
          text: role.isPO ? t.nudgePO : t.nudgeRole,
          ts: Date.now(),
        };
        (team.inbox[roleId] ||= []).push(nudge);
        this.emitEvent(teamId, 'notice', { message: t.nudgeNotice(role.name) });
      } else {
        delete team.nudges[roleId];
        const toolNote = startArgs.length
          ? `\n\n${t.toolsRun}: ${startArgs.map((x) => `${x.name}${x.args?.path ? ' ' + x.args.path : ''}${x.args?.command ? ' ' + String(x.args.command).slice(0, 120) : ''}`).join('; ')}`
          : '';
        const fallbackText = response.trim() ? response.trim().slice(0, 4000) : t.noWrittenSummary;
        const summaryId = `msg_${Date.now()}_auto`;
        if (role.isPO) {
          const msg = { id: summaryId, channel: 'po', from: roleId, fromName: role.name, to: 'user', text: `${t.autoSummary} ${fallbackText}${toolNote}`, ts: Date.now() };
          team.channels.po.push(msg);
          team.poAwaitingUser = true;
          this.emitEvent(teamId, 'message', { channel: 'po', message: msg });
        } else {
          const ch = getChannelKey(roleId, 'po');
          const msg = { id: summaryId, channel: ch, from: roleId, fromName: role.name, to: 'po', text: `${t.autoSummary} ${fallbackText}${toolNote}`, ts: Date.now() };
          (team.channels[ch] ||= []).push(msg);
          team.inbox.po.push(msg);
          this.emitEvent(teamId, 'message', { channel: ch, message: msg });
        }
      }
    }

    // PO görev dağıttıysa ama kullanıcıyı bilgilendirmediyse: bir kez kısa bilgi istemi gönder.
    if (role.isPO && !poFinalTurn) {
      const delegated = actions.filter((a) => a.type === 'send' && a.to && a.to !== 'all' && ['görev', 'soru'].includes(a.kind || inferMessageKind(a.content)));
      const informed = actions.some((a) => a.type === 'user' && a.content);
      if (informed) {
        delete team.infoNudges?.[roleId];
      } else if (delegated.length && !team.infoNudges?.[roleId]) {
        team.infoNudges = team.infoNudges || {};
        team.infoNudges[roleId] = 1;
        team.inbox[roleId] = team.inbox[roleId] || [];
        team.inbox[roleId].push({
          id: `msg_${Date.now()}_info`,
          channel: 'system',
          from: 'system',
          fromName: t.systemName,
          to: roleId,
          text: t.infoNudge,
          ts: Date.now(),
        });
        this.emitEvent(teamId, 'notice', { message: t.infoNudgeNotice(role.name) });
      }
    }

    this._notifyCapReached(team, role);
    TeamStore.save(team);
    this.emitEvent(teamId, 'turn_end', { roleId, roleName, budget: team.budget });
    if (finished.some((x) => ['write', 'edit'].includes(x.name)) || startArgs.some((x) => ['write', 'edit'].includes(x.name))) {
      this.emitEvent(teamId, 'files_changed', {});
    }
    this.pump(teamId, 30);
  }

  buildTurnMessage(team, role, inbox) {
    const t = T(team);
    let s = `${t.turnStatusHeader}\n${team.board.status}\n`;
    if (team.board.decisions.length) {
      s += `${t.turnDecisions(team.board.decisions.length, t.decisionsFile)}\n`;
      for (const d of team.board.decisions.slice(-5)) s += `- [${d.category}] ${d.title}\n`;
    }
    s += `\n${t.turnInboxHeader}\n`;
    const images = [];
    for (const m of inbox) {
      const fyi = !isActionableMessage(m);
      const header = m.from === 'system' ? t.turnFromSystem : `${t.turnFrom(m.fromName || m.from, m.from, m.channel)}${fyi ? t.tagInfo : t.tagAction}`;
      s += `\n${header}\n${m.text}\n`;
      for (const att of m.attachments || []) {
        if (att.type === 'file') s += `\n${t.attachedFile(att.name)}\n\`\`\`\n${att.text}\n\`\`\`\n`;
        else if (att.type === 'image' && att.dataUrl) {
          const mm = att.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
          if (mm) images.push({ type: 'image', mimeType: mm[1], data: mm[2] });
          s += `\n${t.attachedImage(att.name)}\n`;
        }
      }
    }
    const actionable = inbox.some(isActionableMessage);
    const count = team.turnCounts?.[role.id] || 0;
    if (role.isPO) {
      if (count >= PO_TURN_CAP) s += t.poFinalTurn;
      else if (count >= 4) s += t.poClosing;
      else if (count >= 3) s += t.poFocus(count);
    } else if (count >= 4) {
      s += t.roleClosing;
    } else if (count >= 3) {
      s += t.roleWrapUp(count);
    } else if (count >= 2) {
      s += t.roleFocus(count);
    }
    s += actionable ? (role.isPO ? t.turnActionablePO : t.turnActionable) : t.turnFyiOnly;
    return { text: s, images };
  }

  writeDecisionsFile(team) {
    const t = T(team);
    let md = t.decisionsDoc(team.name);
    for (const d of team.board.decisions) {
      md += `## ${d.id}: ${d.title}\n${t.decisionMeta(d, new Date(d.ts).toLocaleString(t.locale))}\n\n${d.decision}\n\n`;
    }
    this._writeDoc(team, t.decisionsFile, md);
  }

  writeStatusFile(team) {
    const t = T(team);
    this._writeDoc(team, t.statusFile, t.statusDoc(team.name, new Date().toLocaleString(t.locale), team.board.status));
  }

  _writeDoc(team, name, content) {
    try {
      const dir = path.join(team.projectPath, DOCS_REL);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), content, 'utf8');
    } catch (e) {
      console.error('Could not write document:', e.message);
    }
  }

  listDocs(team) {
    const dir = path.join(team.projectPath, DOCS_REL);
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => /\.(md|txt)$/i.test(f))
        .map((f) => {
          const full = path.join(dir, f);
          const st = fs.statSync(full);
          return { name: f, updatedAt: st.mtimeMs, size: st.size, content: fs.readFileSync(full, 'utf8').slice(0, 200000) };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }
}

module.exports = {
  ROLE_PRESETS,
  ROLE_PRESETS_BY_LANG,
  rolePresets,
  ALL_TOOLS,
  TeamStore,
  TeamOrchestrator,
  parseActions,
  normalizeRoleTarget,
  getChannelKey,
  rolePromptText,
  inferMessageKind,
  normalizeKind,
  textSimilarity,
  isActionableMessage,
  isTaskMessage,
  isWakeableMessage,
  ROLE_TURN_CAP,
  ROLE_TOTAL_CAP,
  PO_TURN_CAP,
  PAIR_LIMIT,
};
