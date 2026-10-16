// Ekip orkestratörünün döngüye girmediğini sahte (mock) ajanlarla doğrular.
// Çalıştırma: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'freeai-test-'));
process.env.FREEAI_DATA_DIR = DATA_DIR;
const { TeamOrchestrator, TeamStore, PO_TURN_CAP, ROLE_TOTAL_CAP, inferMessageKind, isTaskMessage, rolePromptText } = require('../team.js');

const PROJECT_DIR = path.join(DATA_DIR, 'project');
fs.mkdirSync(PROJECT_DIR, { recursive: true });

class MockAgent extends EventEmitter {
  constructor(reply) {
    super();
    this.reply = reply;
    this.busy = false;
    this.lastUsed = Date.now();
  }
  async prompt(text) {
    await new Promise((r) => setImmediate(r));
    return this.reply(text);
  }
  abort() {}
  dispose() {}
}

const ROLES = ['po', 'analyst', 'tech_lead', 'developer', 'designer', 'qa'];

/** behavior(roleId, turnText, turnNo) => model yanıtı. */
function makeOrchestrator(behavior) {
  const turns = [];
  const orch = new TeamOrchestrator({
    createAgent: ({ role }) =>
      new MockAgent((text) => {
        turns.push(role.id);
        return behavior(role.id, text, turns.filter((r) => r === role.id).length);
      }),
  });
  return { orch, turns };
}

function createTeam(orch, { lang = 'tr', budgetLimit = 1000 } = {}) {
  return orch.createTeam({
    name: 'Test',
    projectPath: PROJECT_DIR,
    lang,
    budgetLimit,
    roles: ROLES.map((preset) => ({ preset, provider: 'groq', model: 'mock', mode: 'pi' })),
  });
}

/** Ekip running dışındaki bir duruma geçip hiçbir rol çalışmadığında çözülür. */
function waitSettled(orch, teamId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      orch.off(`event:${teamId}`, onEvent);
      reject(new Error(`Ekip ${timeoutMs}ms içinde durmadı (döngü?)`));
    }, timeoutMs);
    const check = () => {
      const team = TeamStore.get(teamId);
      if (team && team.status !== 'running' && !orch.anyRoleBusy(teamId)) {
        clearTimeout(timer);
        orch.off(`event:${teamId}`, onEvent);
        resolve(team);
      }
    };
    const onEvent = (ev) => {
      if (ev.type === 'status_change') setTimeout(check, 100);
    };
    orch.on(`event:${teamId}`, onEvent);
  });
}

const maxTurns = () => PO_TURN_CAP + ROLE_TOTAL_CAP * (ROLES.length - 1);

after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('normal akış: PO görev dağıtır, roller sonuç döner, PO raporlar ve ekip durur', async () => {
  const { orch, turns } = makeOrchestrator((role, text, n) => {
    if (role === 'po') {
      if (n === 1)
        return '@@USER\nAnaliste ve teknik lidere görev verdim.\n@@END\n@@SEND to=analyst kind=görev\nGÖREV: gereksinimleri çıkar\n@@END\n@@SEND to=tech_lead kind=görev\nGÖREV: mimariyi incele\n@@END';
      return '@@USER\nNihai rapor: her şey hazır.\n@@END';
    }
    return '@@SEND to=po kind=sonuç\nİş tamamlandı.\n@@END';
  });
  const team = createTeam(orch);
  await orch.handleUserMessage(team.id, 'Bir yapılacaklar uygulaması istiyorum.');
  const done = await waitSettled(orch, team.id);
  assert.equal(done.status, 'waiting_user');
  assert.ok(turns.length <= 6, `beklenenden fazla tur: ${turns.length} (${turns.join(' ')})`);
  orch.disposeAll();
});

test('en kötü durum: PO her turda herkese görev verir, roller herkese soru sorar — ekip yine de durur', async () => {
  const everyone = ROLES.filter((r) => r !== 'po');
  const { orch, turns } = makeOrchestrator((role, text, n) => {
    if (role === 'po') {
      return everyone.map((r) => `@@SEND to=${r} kind=görev\nGÖREV: yeni iş #${n} (${Math.random()})\n@@END`).join('\n') + '\n@@USER\nDağıttım.\n@@END';
    }
    const others = ROLES.filter((r) => r !== role);
    return others.map((r) => `@@SEND to=${r} kind=soru\nBunu da kontrol eder misin? ${Math.random()}\n@@END`).join('\n');
  });
  const team = createTeam(orch);
  await orch.handleUserMessage(team.id, 'Başla');
  const done = await waitSettled(orch, team.id, 30000);
  assert.notEqual(done.status, 'running');
  assert.ok(turns.length <= maxTurns(), `tur sınırı aşıldı: ${turns.length} > ${maxTurns()}`);
  assert.ok(turns.filter((r) => r === 'po').length <= PO_TURN_CAP);
  for (const r of everyone) assert.ok(turns.filter((x) => x === r).length <= ROLE_TOTAL_CAP, `${r} sınırı aştı`);
  orch.disposeAll();
});

test('kind yazmayan ve her mesajı soru işaretiyle bitiren modeller döngüye girmez', async () => {
  const { orch, turns } = makeOrchestrator((role, text, n) => {
    if (role === 'po') return '@@SEND to=analyst\nGÖREV: analiz et\n@@END\n@@SEND to=qa\nTest planı hazırlar mısın?\n@@END';
    if (role === 'analyst') return `@@SEND to=qa\nAnaliz bitti, sen ne düşünüyorsun? ${n}\n@@END\n@@SEND to=po\nSonuçlar hazır, başka bir şey var mı? ${n}\n@@END`;
    if (role === 'qa') return `@@SEND to=analyst\nTeşekkürler, peki ya bu senaryo? ${n}\n@@END`;
    return '@@IDLE';
  });
  const team = createTeam(orch);
  await orch.handleUserMessage(team.id, 'Başla');
  const done = await waitSettled(orch, team.id, 30000);
  assert.notEqual(done.status, 'running');
  assert.ok(turns.length <= maxTurns(), `tur sınırı aşıldı: ${turns.length}`);
  orch.disposeAll();
});

test('onay mesajları (kind=bilgi / sonuç) karşı tarafı uyandırmaz', async () => {
  const { orch, turns } = makeOrchestrator((role, text, n) => {
    if (role === 'po') return n === 1 ? '@@SEND to=analyst kind=görev\nGÖREV: x\n@@END\n@@USER\nAnaliste verdim.\n@@END' : '@@USER\nTamam.\n@@END';
    if (role === 'analyst') return `@@SEND to=po kind=sonuç\nBitti.\n@@END\n@@SEND to=qa kind=bilgi\nBilgin olsun ${n}\n@@END`;
    if (role === 'qa') return '@@SEND to=analyst kind=bilgi\nAnladım\n@@END';
    return '@@IDLE';
  });
  const team = createTeam(orch);
  await orch.handleUserMessage(team.id, 'Başla');
  await waitSettled(orch, team.id);
  assert.equal(turns.filter((r) => r === 'qa').length, 0, 'bilgi mesajı QA\'yı uyandırmamalı');
  assert.equal(turns.filter((r) => r === 'analyst').length, 1);
  orch.disposeAll();
});

test('PO son turunda gönderdiği görevler kimseyi uyandırmaz ve yeni kullanıcı mesajı sayaçları sıfırlar', async () => {
  // PO her turda sıradaki role görev verir (kanal devre kesicisine takılmadan PO sınırına ulaşmak için).
  const others = ROLES.filter((r) => r !== 'po');
  const { orch, turns } = makeOrchestrator((role, text, n) => {
    if (role === 'po') return `@@SEND to=${others[(n - 1) % others.length]} kind=görev\nGÖREV: iş ${n} ${Math.random()}\n@@END\n@@USER\nDevam.\n@@END`;
    return '@@SEND to=po kind=sonuç\nYaptım.\n@@END';
  });
  const team = createTeam(orch);
  await orch.handleUserMessage(team.id, 'Başla');
  await waitSettled(orch, team.id, 30000);
  const firstRound = turns.length;
  assert.equal(turns.filter((r) => r === 'po').length, PO_TURN_CAP);
  const t1 = TeamStore.get(team.id);
  const lastTarget = others[(PO_TURN_CAP - 1) % others.length];
  const finalPoTask = [...t1.channels[`dm:${[lastTarget, 'po'].sort().join('|')}`]].reverse().find((m) => m.from === 'po');
  assert.equal(finalPoTask.noReply, true, 'son turdaki görev uyandırmamalı');
  assert.ok(!turns.slice(turns.lastIndexOf('po') + 1).length, 'PO\'nun son turundan sonra kimse çalışmamalı');

  await orch.handleUserMessage(team.id, 'Devam et');
  await waitSettled(orch, team.id, 30000);
  assert.ok(turns.length > firstRound, 'yeni kullanıcı mesajı ekibi yeniden çalıştırmalı');
  orch.disposeAll();
});

test('tur bütçesi dolunca ekip duraklar', async () => {
  const { orch, turns } = makeOrchestrator((role) => {
    if (role === 'po') return ROLES.filter((r) => r !== 'po').map((r) => `@@SEND to=${r} kind=görev\nGÖREV: ${Math.random()}\n@@END`).join('\n');
    return `@@SEND to=po kind=soru\nNe yapayım? ${Math.random()}\n@@END`;
  });
  const team = createTeam(orch, { budgetLimit: 5 });
  await orch.handleUserMessage(team.id, 'Başla');
  const done = await waitSettled(orch, team.id);
  assert.equal(done.status, 'paused');
  assert.equal(turns.length, 5);
  orch.disposeAll();
});

test('İngilizce ekip: istemler, sistem metinleri ve doküman adları İngilizce', async () => {
  const { orch } = makeOrchestrator((role, text) => {
    if (role === 'po') {
      assert.match(text, /NEW MESSAGES FOR YOU/);
      return '@@DECISION title="Stack" category="technical"\nDecision: Node\n@@END\n@@STATUS\nAll good\n@@END\n@@USER\nDone.\n@@END';
    }
    return '@@IDLE';
  });
  const team = createTeam(orch, { lang: 'en' });
  assert.equal(team.roles.find((r) => r.id === 'analyst').name, 'Business / Systems Analyst');
  await orch.handleUserMessage(team.id, 'Start');
  await waitSettled(orch, team.id);
  const docs = orch.listDocs(TeamStore.get(team.id)).map((d) => d.name);
  assert.ok(docs.includes('DECISIONS.md') && docs.includes('STATUS.md'), docs.join(','));
  const prompt = fs.readFileSync(path.join(TeamStore.dir(team.id), 'prompts', 'po.md'), 'utf8');
  assert.match(prompt, /Write in English/);
  assert.match(prompt, /TASK:/);
  orch.disposeAll();
});

test('PO kendine @@SEND yazarsa kullanıcıya gider; to=system yok sayılır ve tekrar dürtme olmaz', async () => {
  const { orch, turns } = makeOrchestrator((role) => {
    if (role === 'po') return '@@SEND to=po kind=sonuç\nİş bitti, rapor bu.\n@@END\n@@SEND to=system kind=sonuç\nTamam.\n@@END';
    return '@@IDLE';
  });
  const team = createTeam(orch);
  await orch.handleUserMessage(team.id, 'Başla');
  const done = await waitSettled(orch, team.id);
  const toUser = done.channels.po.filter((m) => m.from === 'po' && m.to === 'user');
  assert.equal(toUser.length, 1);
  assert.match(toUser[0].text, /rapor bu/);
  assert.ok(!toUser.some((m) => /system/i.test(m.text)), 'sisteme yazılan mesaj kullanıcıya düşmemeli');
  assert.equal(turns.length, 1, 'PO bir kez daha dürtülmemeli');
  orch.disposeAll();
});

test('varsayılan dil İngilizce; dil alanı olmayan eski ekipler Türkçe kalır', () => {
  const { orch } = makeOrchestrator(() => '@@IDLE');
  const team = orch.createTeam({ name: 'Default', projectPath: PROJECT_DIR, roles: [{ preset: 'po', provider: 'groq', model: 'mock' }] });
  assert.equal(team.lang, 'en');
  assert.equal(team.board.status, 'The project has not started yet.');
  const legacy = { ...team, lang: undefined, name: 'Legacy' };
  assert.match(rolePromptText(legacy, legacy.roles[0]), /Türkçe yaz/);
  orch.disposeAll();
});

test('mesaj türü çıkarımı: GÖREV/TASK öneki ve yalnızca son satırdaki soru işareti', () => {
  assert.equal(inferMessageKind('GÖREV: bir şey yap'), 'görev');
  assert.equal(inferMessageKind('TASK: do something'), 'görev');
  assert.equal(inferMessageKind('Bunu kontrol eder misin?'), 'soru');
  assert.equal(inferMessageKind('Neden yavaş? Çünkü indeks yok.\nDüzelttim.'), 'sonuç');
  assert.ok(isTaskMessage('New task: x'));
});
