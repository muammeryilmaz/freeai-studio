// public/team-page.js - Bağımsız Agile Ekip Odası Kontrolcüsü

(function () {
  let teamPresets = {};
  let allTools = ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'];
  const THINKING_LEVEL_IDS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const thinkingLabel = (level) => t(`thinking.${level}`);
  const esc = (s) => window.AiCommon.escapeHtml(s);
  let providers = [];
  let modelsByProvider = JSON.parse(localStorage.getItem('aiconv.models') || '{}');
  let modelStatus = JSON.parse(localStorage.getItem('aiconv.status') || '{}');
  let currentTeam = null;
  let activeChannel = 'po'; // 'po' | 'team' | 'dm:...'
  let currentSubView = 'channel'; // 'channel' | 'board' | 'files' | 'log'
  let sseSource = null;
  let activeDocName = null;
  let pendingAttachments = [];
  let activeTurns = new Map(); // roleId -> { roleId, roleName, mode, detail, startedAt, chars, lastTool } — eşzamanlı çalışan roller
  let activeTurnTicker = null;

  const els = {
    teamList: document.getElementById('teamList'),
    newTeamBtn: document.getElementById('newTeamBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsModal: document.getElementById('settingsModal'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    settingsRows: document.getElementById('settingsRows'),

    // Views
    createTeamView: document.getElementById('createTeamView'),
    activeTeamView: document.getElementById('activeTeamView'),

    // Create Form
    teamNameInput: document.getElementById('teamNameInput'),
    projectPathInput: document.getElementById('projectPathInput'),
    browseFolderBtn: document.getElementById('browseFolderBtn'),
    validatePathBtn: document.getElementById('validatePathBtn'),
    pathValidationStatus: document.getElementById('pathValidationStatus'),
    rolesList: document.getElementById('rolesList'),
    addRoleBtn: document.getElementById('addRoleBtn'),
    submitCreateTeamBtn: document.getElementById('submitCreateTeamBtn'),

    // Active Team Workspace
    teamHeaderTitle: document.getElementById('teamHeaderTitle'),
    teamHeaderPath: document.getElementById('teamHeaderPath'),
    teamStatusBadge: document.getElementById('teamStatusBadge'),
    teamBudgetBadge: document.getElementById('teamBudgetBadge'),
    teamLangBadge: document.getElementById('teamLangBadge'),
    teamActivity: document.getElementById('teamActivity'),
    teamPauseBtn: document.getElementById('teamPauseBtn'),
    teamResumeBtn: document.getElementById('teamResumeBtn'),
    teamExtendBtn: document.getElementById('teamExtendBtn'),
    teamEditRolesBtn: document.getElementById('teamEditRolesBtn'),
    teamDeleteBtn: document.getElementById('teamDeleteBtn'),
    teamDmList: document.getElementById('teamDmList'),

    // Sub Views
    channelSubView: document.getElementById('channelSubView'),
    boardSubView: document.getElementById('boardSubView'),
    filesSubView: document.getElementById('filesSubView'),
    logSubView: document.getElementById('logSubView'),

    // Messages
    teamMessages: document.getElementById('teamMessages'),
    teamComposerWrap: document.getElementById('teamComposerWrap'),
    teamAttachments: document.getElementById('teamAttachments'),
    teamComposerHint: document.getElementById('teamComposerHint'),
    teamAttachBtn: document.getElementById('teamAttachBtn'),
    teamFileInput: document.getElementById('teamFileInput'),
    teamInput: document.getElementById('teamInput'),
    teamSendBtn: document.getElementById('teamSendBtn'),
    teamReadonlyNotice: document.getElementById('teamReadonlyNotice'),

    // Board
    refreshDocsBtn: document.getElementById('refreshDocsBtn'),
    boardStatusBox: document.getElementById('boardStatusBox'),
    boardDecisionsBox: document.getElementById('boardDecisionsBox'),
    docsFileList: document.getElementById('docsFileList'),
    docsFileViewer: document.getElementById('docsFileViewer'),

    // Files
    filesChangeList: document.getElementById('filesChangeList'),

    // Log
    teamLogList: document.getElementById('teamLogList'),

    // Folder Browser Modal
    folderBrowseModal: document.getElementById('folderBrowseModal'),
    closeFolderBrowseBtn: document.getElementById('closeFolderBrowseBtn'),
    browserCurrentPath: document.getElementById('browserCurrentPath'),
    browserFolderList: document.getElementById('browserFolderList'),
    browserUpBtn: document.getElementById('browserUpBtn'),
    selectCurrentFolderBtn: document.getElementById('selectCurrentFolderBtn'),

    // Edit Roles Modal
    editRolesModal: document.getElementById('editRolesModal'),
    closeEditRolesBtn: document.getElementById('closeEditRolesBtn'),
    cancelEditRolesBtn: document.getElementById('cancelEditRolesBtn'),
    saveEditRolesBtn: document.getElementById('saveEditRolesBtn'),
    editRolesContainer: document.getElementById('editRolesContainer'),
  };

  // --- İLK YÜKLEME ---
  async function init() {
    await loadProviders();
    await loadPresets();
    await loadTeams();
    initFolderBrowser();
  }

  async function loadProviders() {
    try {
      const resp = await fetch('/api/providers');
      const data = await resp.json();
      providers = data.providers || [];
    } catch (e) {
      console.error('Providers error:', e);
    }
  }

  async function loadPresets() {
    try {
      const resp = await fetch('/api/team-presets');
      const data = await resp.json();
      teamPresets = data.presets || {};
      if (Array.isArray(data.allTools)) allTools = data.allTools;
    } catch (e) {
      console.error('Presets error:', e);
    }
  }

  // Model listesini sunucudan çeker ve localStorage'a önbelleğe alır.
  // Ana sohbet sayfasına hiç girilmemiş olsa bile rol kartlarındaki model menüleri dolsun diye.
  const modelFetchPromises = new Map();
  async function fetchModels(providerId) {
    if (!providerId) return null;
    if (modelsByProvider[providerId]) return modelsByProvider[providerId];
    if (!modelFetchPromises.has(providerId)) {
      modelFetchPromises.set(
        providerId,
        (async () => {
          try {
            const resp = await fetch(`/api/models?provider=${encodeURIComponent(providerId)}`);
            const data = await resp.json();
            if (Array.isArray(data.models)) {
              modelsByProvider[providerId] = data.models;
              localStorage.setItem('aiconv.models', JSON.stringify(modelsByProvider));
              return data.models;
            }
          } catch (e) {
            console.error('Model listesi alınamadı:', providerId, e);
          } finally {
            modelFetchPromises.delete(providerId);
          }
          return null;
        })(),
      );
    }
    return modelFetchPromises.get(providerId);
  }

  async function loadTeams() {
    try {
      const resp = await fetch('/api/teams');
      const data = await resp.json();
      renderTeamList(data.teams || []);
      if (!currentTeam && data.teams?.length) {
        selectTeam(data.teams[0].id);
      } else if (!data.teams?.length) {
        showCreateView();
      }
    } catch (e) {
      console.error('Teams load error:', e);
    }
  }

  function renderTeamList(teams) {
    els.teamList.innerHTML = '';
    if (!teams.length) {
      els.teamList.innerHTML = `<span style="font-size:12px; color:var(--text-dim); padding:6px 8px;">${esc(t('team.none'))}</span>`;
      return;
    }
    for (const team of teams) {
      const item = document.createElement('div');
      item.className = 'team-item' + (currentTeam && currentTeam.id === team.id ? ' active' : '');
      item.dataset.teamId = team.id;
      item.innerHTML = `
        <span class="status-dot ${team.status || 'idle'}" title="${esc(t(`status.${team.status || 'idle'}`))}"></span>
        <span class="title">${esc(team.name)}</span>
        <button class="delete" title="${esc(t('team.deleteTitle'))}">✕</button>
      `;
      item.addEventListener('click', () => selectTeam(team.id));
      item.querySelector('.delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(t('team.confirmDelete', { name: team.name }))) return;
        await fetch(`/api/teams/${team.id}`, { method: 'DELETE' });
        if (currentTeam && currentTeam.id === team.id) {
          currentTeam = null;
          if (sseSource) sseSource.close();
          showCreateView();
        }
        loadTeams();
      });
      els.teamList.appendChild(item);
    }
  }

  // --- GÖRÜNÜM GEÇİŞLERİ ---
  function showCreateView() {
    if (sseSource) sseSource.close();
    endActiveTurn();
    currentTeam = null;
    document.querySelectorAll('.team-item').forEach((el) => el.classList.remove('active'));
    els.activeTeamView.classList.add('hidden');
    els.createTeamView.classList.remove('hidden');

    els.teamNameInput.value = '';
    els.projectPathInput.value = '';
    els.pathValidationStatus.textContent = '';
    els.pathValidationStatus.className = 'path-status-msg';

    // Varsayılan roller: PO, Analyst, Tech Lead, Developer, Designer, QA
    els.rolesList.innerHTML = '';
    const defaultPresets = ['po', 'analyst', 'tech_lead', 'developer', 'designer', 'qa'];
    for (const p of defaultPresets) {
      addRoleCard(els.rolesList, p);
    }
  }

  async function selectTeam(teamId) {
    try {
      const resp = await fetch(`/api/teams/${teamId}`);
      if (!resp.ok) throw new Error(t('team.notFound'));
      const data = await resp.json();
      currentTeam = data.team;
      endActiveTurn();

      els.createTeamView.classList.add('hidden');
      els.activeTeamView.classList.remove('hidden');
      document.querySelectorAll('.team-item').forEach((el) => {
        el.classList.toggle('active', el.dataset.teamId === currentTeam.id);
      });

      renderTeamWorkspaceHeader();
      renderChannels();
      renderCurrentSubView();
      connectSSE(teamId);
    } catch (err) {
      alert(err.message);
    }
  }

  function renderTeamWorkspaceHeader() {
    if (!currentTeam) return;
    els.teamHeaderTitle.textContent = currentTeam.name;
    els.teamHeaderPath.textContent = `📁 ${currentTeam.projectPath}`;
    els.teamLangBadge.textContent = `🌐 ${String(currentTeam.lang || 'tr').toUpperCase()}`;
    updateStatusBadge(currentTeam.status);
    updateBudgetBadge(currentTeam.budget);
  }

  function updateStatusBadge(status) {
    els.teamStatusBadge.className = `status-badge ${status || 'idle'}`;

    if (status === 'running' && activeTurns.size) {
      updateActivityUi();
    } else {
      els.teamStatusBadge.textContent = t(`status.${status || 'idle'}`);
      els.teamStatusBadge.title = status === 'running' ? t('status.runningTitle') : '';
    }

    if (status === 'paused') {
      els.teamPauseBtn.classList.add('hidden');
      els.teamResumeBtn.classList.remove('hidden');
    } else {
      els.teamPauseBtn.classList.remove('hidden');
      els.teamResumeBtn.classList.add('hidden');
    }
  }

  function updateBudgetBadge(budget) {
    if (!budget) return;
    els.teamBudgetBadge.textContent = t('team.budget', { used: budget.used || 0, limit: budget.limit || 25 });
  }

  // --- SSE BAĞLANTISI ---
  function connectSSE(teamId) {
    if (sseSource) sseSource.close();
    sseSource = new EventSource(`/api/teams/${teamId}/events`);

    sseSource.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        handleSSEEvent(ev);
      } catch (err) {
        console.error('SSE JSON error:', err);
      }
    };
  }

  function handleSSEEvent(ev) {
    if (!currentTeam) return;

    if (ev.type === 'message') {
      const { channel, message } = ev;
      (currentTeam.channels[channel] ||= []).push(message);
      if (message.to === 'all') {
        for (const r of currentTeam.roles) if (r.id !== message.from) currentTeam.inbox?.[r.id]?.push(message);
      } else if (message.to && currentTeam.inbox?.[message.to]) {
        currentTeam.inbox[message.to].push(message);
      }
      if (currentSubView === 'channel' && activeChannel === channel) {
        appendTeamMessage(message);
      }
      renderChannels();
    } else if (ev.type === 'status_change') {
      currentTeam.status = ev.status;
      if (ev.budget) currentTeam.budget = ev.budget;
      if (ev.status !== 'running') endActiveTurn();
      updateStatusBadge(ev.status);
      updateBudgetBadge(ev.budget);
    } else if (ev.type === 'turn_start') {
      updateStatusBadge('running');
      if (ev.budget) updateBudgetBadge(ev.budget);
      startActiveTurn(ev.roleId, ev.roleName, ev.mode);
      // Sunucu bu rolün kuyruğunu boşalttı; bekleyen mesaj sayacını güncelle.
      if (currentTeam.inbox?.[ev.roleId]) currentTeam.inbox[ev.roleId] = [];
      renderChannels();
    } else if (ev.type === 'turn_delta') {
      const turn = activeTurns.get(ev.roleId);
      if (turn) {
        turn.chars += (ev.delta || '').length;
        setActiveTurnDetail(ev.roleId, t('act.writing', { n: turn.chars }));
      }
    } else if (ev.type === 'tool_start') {
      const turn = activeTurns.get(ev.roleId);
      if (turn) {
        turn.lastTool = ev.tool;
        setActiveTurnDetail(ev.roleId, describeTool(ev.tool));
      } else if (ev.roleName) {
        startActiveTurn(ev.roleId, ev.roleName, 'pi');
      }
    } else if (ev.type === 'tool_end') {
      if (activeTurns.has(ev.roleId)) setActiveTurnDetail(ev.roleId, t('act.evaluating'));
    } else if (ev.type === 'turn_end') {
      endActiveTurn(ev.roleId);
      if (ev.budget) updateBudgetBadge(ev.budget);
    } else if (ev.type === 'turn_aborted') {
      endActiveTurn(ev.roleId);
    } else if (ev.type === 'queued') {
      appendSystemNotice(ev.message || t('act.queued', { name: ev.roleName }), '⏳');
    } else if (ev.type === 'budget_exhausted') {
      endActiveTurn();
      updateStatusBadge('paused');
      alert(ev.message);
    } else if (ev.type === 'notice') {
      appendSystemNotice(ev.message);
    } else if (ev.type === 'files_changed') {
      loadTeamFiles();
    } else if (ev.type === 'doc_updated' || ev.type === 'decision_added' || ev.type === 'board_status_updated') {
      loadDocs();
    } else if (ev.type === 'turn_error') {
      endActiveTurn(ev.roleId);
      updateStatusBadge('paused');
      alert(t('team.errorAlert', { name: ev.roleName || t('common.system'), error: ev.error }));
    }

    if (ev.type === 'turn_end' || ev.type === 'turn_error') {
      // Arka planda logları, kuyruğu ve durumu senkronize et
      fetch(`/api/teams/${currentTeam.id}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.team) {
            currentTeam.log = d.team.log;
            currentTeam.fileChanges = d.team.fileChanges;
            currentTeam.board = d.team.board;
            currentTeam.inbox = d.team.inbox;
            if (currentSubView === 'log') renderLog();
            if (currentSubView === 'files') renderFiles();
            if (currentSubView === 'board') renderBoard();
          }
        });
    }
  }

  // --- AKTİF TUR: KİM NE YAPIYOR? ---
  function describeTool(tool) {
    if (!tool) return t('act.runningTool');
    const name = tool.name || t('tool.generic');
    const arg = tool.args?.path || tool.args?.command || tool.args?.pattern || '';
    return arg ? t('act.runningToolArg', { name, arg: String(arg).slice(0, 90) }) : t('act.runningToolName', { name });
  }

  function activeTurnList() {
    return [...activeTurns.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  function startActiveTurn(roleId, roleName, mode) {
    const prev = activeTurns.get(roleId);
    activeTurns.set(roleId, {
      roleId,
      roleName: roleName || prev?.roleName || roleId,
      mode: mode || prev?.mode || 'pi',
      detail: t('act.thinking'),
      startedAt: Date.now(),
      chars: 0,
      lastTool: null,
    });
    if (!activeTurnTicker) activeTurnTicker = setInterval(updateActivityUi, 1000);
    updateActivityUi();
  }

  function setActiveTurnDetail(roleId, detail) {
    const turn = activeTurns.get(roleId);
    if (!turn) return;
    turn.detail = detail;
    updateActivityUi();
  }

  function endActiveTurn(roleId) {
    if (roleId) {
      if (!activeTurns.has(roleId)) return;
      activeTurns.delete(roleId);
    } else {
      activeTurns.clear();
    }
    if (!activeTurns.size) {
      if (activeTurnTicker) {
        clearInterval(activeTurnTicker);
        activeTurnTicker = null;
      }
      hideThinkingBanner();
    }
    updateActivityUi();
  }

  function formatElapsed(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return t('time.sec', { s: sec });
    return t('time.minSec', { m: Math.floor(sec / 60), s: sec % 60 });
  }

  function pendingSummary() {
    if (!currentTeam) return '';
    const waiting = (currentTeam.roles || [])
      .map((r) => ({ name: r.name, n: (currentTeam.inbox?.[r.id] || []).filter((m) => !m.noReply).length }))
      .filter((x) => x.n > 0)
      .map((x) => t('act.pendingItem', { name: x.name, n: x.n }));
    return waiting.length ? t('act.queue', { list: waiting.join(', ') }) : t('act.queueEmpty');
  }

  function updateActivityUi() {
    const strip = els.teamActivity;
    const turns = activeTurnList();
    if (turns.length) {
      const parts = turns.map((turn) => `${turn.roleName}: ${turn.detail} (${formatElapsed(Date.now() - turn.startedAt)})`);
      if (strip) {
        strip.textContent = turns.length === 1 ? `⚙ ${parts[0]}` : t('act.many', { n: turns.length, parts: parts.join(' · ') });
        strip.classList.remove('hidden');
        strip.title = [
          ...turns.map(
            (turn) =>
              `${turn.roleName} (${turn.mode === 'text' ? t('mode.text') : t('mode.pi')}): ${turn.detail} · ${formatElapsed(Date.now() - turn.startedAt)}${turn.chars ? t('act.chars', { n: turn.chars }) : ''}`,
          ),
          pendingSummary(),
        ]
          .filter(Boolean)
          .join('\n');
      }
      // Ekip duraklatıldıysa rozet durumu korunur.
      if (!currentTeam || currentTeam.status === 'running') {
        els.teamStatusBadge.textContent =
          turns.length === 1
            ? t('status.runningOne', { name: turns[0].roleName })
            : t('status.runningMany', { n: turns.length, names: turns.map((turn) => turn.roleName).join(', ') });
        els.teamStatusBadge.title = strip ? strip.title : '';
      }
    } else if (strip) {
      strip.textContent = '';
      strip.title = '';
      strip.classList.add('hidden');
    }

    // Kanal listesinde meşgul rollerin yanında nabız işareti
    document.querySelectorAll('.team-channels .channel-item[data-channel]').forEach((el) => {
      const ch = el.getAttribute('data-channel') || '';
      el.classList.toggle('busy', turns.some((turn) => ch.includes(turn.roleId)));
    });

    renderActiveTurnBanner();
  }

  let thinkingBannerEl = null;
  let thinkingBannerText = '';

  // Aktif tur balonunu, hangi kanalda olursak olalım mesaj akışının sonunda gösterir.
  function renderActiveTurnBanner() {
    const turns = activeTurnList();
    if (!turns.length || currentSubView !== 'channel') return;
    const text = turns.map((turn) => `${turn.roleName} ${turn.detail} (${formatElapsed(Date.now() - turn.startedAt)})`).join(' · ');
    if (!thinkingBannerEl) {
      thinkingBannerEl = document.createElement('div');
      thinkingBannerEl.className = 'msg-row notice';
      thinkingBannerEl.innerHTML = '<div class="bubble"></div>';
      thinkingBannerText = '';
    }
    if (thinkingBannerText !== text) {
      thinkingBannerEl.querySelector('.bubble').textContent = text;
      thinkingBannerText = text;
    }
    if (thinkingBannerEl.parentElement !== els.teamMessages) {
      els.teamMessages.appendChild(thinkingBannerEl);
    }
    const nearBottom = els.teamMessages.scrollHeight - els.teamMessages.scrollTop - els.teamMessages.clientHeight < 140;
    if (nearBottom) els.teamMessages.scrollTop = els.teamMessages.scrollHeight;
  }

  function hideThinkingBanner() {
    if (thinkingBannerEl && thinkingBannerEl.parentElement) thinkingBannerEl.remove();
    thinkingBannerText = '';
  }

  function appendSystemNotice(text, icon = '⚠') {
    console.log('[team]', text);
    if (currentSubView !== 'channel') return;
    const row = document.createElement('div');
    row.className = 'msg-row notice';
    row.innerHTML = '<div class="bubble"></div>';
    row.querySelector('.bubble').textContent = `${icon} ${text}`;
    els.teamMessages.appendChild(row);
    els.teamMessages.scrollTop = els.teamMessages.scrollHeight;
  }

  // --- KANAL VE ALT GÖRÜNÜM ---
  function renderChannels() {
    if (!currentTeam) return;

    document.querySelectorAll('.team-channels .channel-item[data-channel]').forEach((el) => {
      const ch = el.getAttribute('data-channel');
      el.classList.toggle('active', currentSubView === 'channel' && activeChannel === ch);
    });

    document.querySelectorAll('.team-channels .channel-item[data-view]').forEach((el) => {
      const v = el.getAttribute('data-view');
      el.classList.toggle('active', currentSubView === v);
    });

    // DM listesi
    els.teamDmList.innerHTML = '';
    const dmKeys = Object.keys(currentTeam.channels || {}).filter((k) => k.startsWith('dm:'));
    for (const dm of dmKeys) {
      const pair = dm.replace('dm:', '').split('|');
      const r1 = currentTeam.roles.find((r) => r.id === pair[0])?.name || pair[0];
      const r2 = currentTeam.roles.find((r) => r.id === pair[1])?.name || pair[1];

      const item = document.createElement('div');
      item.className = 'channel-item' + (currentSubView === 'channel' && activeChannel === dm ? ' active' : '');
      item.setAttribute('data-channel', dm);
      item.innerHTML = `
        <span class="icon">👤</span>
        <span class="name" title="${window.AiCommon.escapeHtml(r1)} ↔ ${window.AiCommon.escapeHtml(r2)}">${window.AiCommon.escapeHtml(r1)} ↔ ${window.AiCommon.escapeHtml(r2)}</span>
      `;
      item.addEventListener('click', () => {
        currentSubView = 'channel';
        activeChannel = dm;
        renderChannels();
        renderCurrentSubView();
      });
      els.teamDmList.appendChild(item);
    }

    updateActivityUi();
  }

  function renderCurrentSubView() {
    hideThinkingBanner();
    els.channelSubView.classList.add('hidden');
    els.boardSubView.classList.add('hidden');
    els.filesSubView.classList.add('hidden');
    els.logSubView.classList.add('hidden');

    if (currentSubView === 'channel') {
      els.channelSubView.classList.remove('hidden');
      renderChannelMessages();
    } else if (currentSubView === 'board') {
      els.boardSubView.classList.remove('hidden');
      loadDocs();
      renderBoard();
    } else if (currentSubView === 'files') {
      els.filesSubView.classList.remove('hidden');
      renderFiles();
    } else if (currentSubView === 'log') {
      els.logSubView.classList.remove('hidden');
      renderLog();
    }
  }

  function renderChannelMessages() {
    els.teamMessages.innerHTML = '';
    const msgs = (currentTeam.channels[activeChannel] || []).slice();

    if (activeChannel === 'po') {
      els.teamComposerWrap.classList.remove('hidden');
      els.teamReadonlyNotice.classList.add('hidden');
    } else {
      els.teamComposerWrap.classList.add('hidden');
      els.teamReadonlyNotice.classList.remove('hidden');
    }

    if (!msgs.length) {
      els.teamMessages.innerHTML = `
        <div class="empty-state" style="padding:40px 20px;">
          <h3>${esc(t('ch.emptyTitle', { ch: activeChannel === 'team' ? t('ch.teamName') : activeChannel }))}</h3>
          <p>${esc(activeChannel === 'po' ? t('ch.poReady') : t('ch.empty'))}</p>
        </div>`;
      renderActiveTurnBanner();
      return;
    }

    for (const m of msgs) appendTeamMessage(m);
    els.teamMessages.scrollTop = els.teamMessages.scrollHeight;
    renderActiveTurnBanner();
  }

  function appendTeamMessage(msg) {
    els.teamMessages.querySelector('.empty-state')?.remove(); // Kanalın ilk mesajı geldiğinde "boş kanal" yazısı kalkar
    const isUser = msg.from === 'user';
    const roleObj = currentTeam.roles.find((r) => r.id === msg.from);
    const roleColor = roleObj ? roleObj.color : '#818cf8';

    const row = document.createElement('div');
    row.className = 'msg-row ' + (isUser ? 'user' : 'assistant');

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const senderHead = document.createElement('div');
    senderHead.className = 'team-msg-sender';
    if (isUser) {
      senderHead.innerHTML = `<span>${esc(t('msg.you'))}</span>`;
    } else {
      senderHead.innerHTML = `
        <span class="team-msg-role-tag" style="background:${roleColor}">${window.AiCommon.escapeHtml(roleObj?.name || msg.fromName || msg.from)}</span>
        <span class="team-msg-target">→ ${window.AiCommon.escapeHtml(msg.to)}</span>
      `;
    }
    bubble.appendChild(senderHead);

    if (msg.attachments && msg.attachments.length) {
      const attBox = document.createElement('div');
      attBox.className = 'msg-atts';
      for (const att of msg.attachments) {
        if (att.type === 'image' && att.dataUrl) {
          const img = document.createElement('img');
          img.src = att.dataUrl;
          img.title = att.name;
          img.addEventListener('click', () => window.open().document.write(`<img src="${att.dataUrl}" style="max-width:100%">`));
          attBox.appendChild(img);
        } else {
          const tag = document.createElement('span');
          tag.className = 'file-tag';
          tag.textContent = '📄 ' + att.name;
          attBox.appendChild(tag);
        }
      }
      bubble.appendChild(attBox);
    }

    const contentBox = document.createElement('div');
    if (isUser) {
      contentBox.textContent = msg.text;
    } else {
      contentBox.innerHTML = window.AiCommon.renderMarkdown(msg.text);
    }
    bubble.appendChild(contentBox);

    row.appendChild(bubble);
    els.teamMessages.appendChild(row);
    els.teamMessages.scrollTop = els.teamMessages.scrollHeight;
  }

  // --- PROJE PANOSU & DOKÜMANLAR ---
  async function loadDocs() {
    if (!currentTeam) return;
    try {
      const resp = await fetch(`/api/teams/${currentTeam.id}/docs`);
      const data = await resp.json();
      renderDocsList(data.docs || []);
    } catch (e) {
      console.error('Docs fetch error:', e);
    }
  }

  function renderDocsList(docs) {
    els.docsFileList.innerHTML = '';
    if (!docs.length) {
      els.docsFileList.innerHTML = `<span style="font-size:12px; color:var(--text-dim);">${esc(t('board.noDocs'))}</span>`;
      els.docsFileViewer.innerHTML = `<p class="empty-note">${esc(t('board.noDocsHint'))}</p>`;
      return;
    }
    if (!activeDocName || !docs.some((d) => d.name === activeDocName)) {
      activeDocName = docs[0].name;
    }

    for (const d of docs) {
      const btn = document.createElement('button');
      btn.className = 'doc-file-btn' + (activeDocName === d.name ? ' active' : '');
      btn.textContent = `📄 ${d.name}`;
      btn.title = d.name;
      btn.addEventListener('click', () => {
        activeDocName = d.name;
        renderDocsList(docs);
      });
      els.docsFileList.appendChild(btn);
    }

    const cur = docs.find((d) => d.name === activeDocName);
    if (cur) {
      els.docsFileViewer.innerHTML = `
        <div style="border-bottom:1px solid var(--border); padding-bottom:8px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:baseline;">
          <h3 style="margin:0; font-family:Consolas, monospace;">docs/agile/${window.AiCommon.escapeHtml(cur.name)}</h3>
          <span style="font-size:12px; color:var(--text-dim);">${new Date(cur.updatedAt).toLocaleString(I18n.locale)} · ${esc(t('board.bytes', { n: cur.size }))}</span>
        </div>
        <div>${window.AiCommon.renderMarkdown(cur.content)}</div>
      `;
    }
  }

  function renderBoard() {
    if (!currentTeam || !currentTeam.board) return;
    els.boardStatusBox.textContent = currentTeam.board.status || t('board.noStatus');

    els.boardDecisionsBox.innerHTML = '';
    const decisions = currentTeam.board.decisions || [];
    if (!decisions.length) {
      els.boardDecisionsBox.innerHTML = `<p class="empty-note">${esc(t('board.noDecisions'))}</p>`;
    } else {
      for (const d of decisions) {
        const item = document.createElement('div');
        item.style.marginBottom = '10px';
        // Kutu pre-wrap olduğu için şablonda etiketler arasına boşluk/satır sonu konmaz.
        item.innerHTML =
          `<strong style="color:#a5b4fc;">[${esc(d.category)}] ${esc(d.title)}</strong>` +
          `<div style="margin-top:2px;">${esc(String(d.decision || '').trim())}</div>` +
          `<div style="font-size:11px; color:var(--text-dim); margin-top:2px;">${esc(t('board.approvedBy', { name: d.author }))} · ${new Date(d.ts).toLocaleTimeString(I18n.locale)}</div>`;
        els.boardDecisionsBox.appendChild(item);
      }
    }
  }

  // --- DOSYA DEĞİŞİKLİKLERİ ---
  function loadTeamFiles() {
    renderFiles();
  }

  function renderFiles() {
    if (!currentTeam) return;
    els.filesChangeList.innerHTML = '';
    const changes = (currentTeam.fileChanges || []).slice().reverse();
    if (!changes.length) {
      els.filesChangeList.innerHTML = `<p class="empty-note">${esc(t('files.none'))}</p>`;
      return;
    }
    for (const c of changes) {
      const row = document.createElement('div');
      row.className = 'file-change-row';
      row.innerHTML = `
        <div class="file-change-left">
          <span class="change-tag ${c.tool}">${c.tool === 'write' ? t('files.new') : t('files.edited')}</span>
          <span class="file-change-path">${window.AiCommon.escapeHtml(c.path)}</span>
          <span style="font-size:12px; color:var(--text-dim);">— ${window.AiCommon.escapeHtml(c.roleName)}</span>
        </div>
        <span class="file-change-time">${new Date(c.ts).toLocaleTimeString(I18n.locale)}</span>
      `;
      els.filesChangeList.appendChild(row);
    }
  }

  // --- CANLI AKIŞ & LOG ---
  function renderLog() {
    if (!currentTeam) return;
    els.teamLogList.innerHTML = '';
    const logs = (currentTeam.log || []).slice().reverse();
    if (!logs.length) {
      els.teamLogList.innerHTML = `<p class="empty-note">${esc(t('log.empty'))}</p>`;
      return;
    }
    for (const l of logs) {
      const item = document.createElement('div');
      item.className = 'log-item';
      const roleObj = currentTeam.roles.find((r) => r.id === l.roleId);
      const roleColor = roleObj ? roleObj.color : '#818cf8';

      item.innerHTML = `
        <div class="log-item-header">
          <div class="log-item-title">
            <span class="team-msg-role-tag" style="background:${roleColor}">${window.AiCommon.escapeHtml(l.roleName || l.roleId)}</span>
            <span style="font-size:11px; background:#374151; padding:1px 6px; border-radius:4px; color:#e5e7eb;">${l.mode === 'text' ? t('mode.text') : t('mode.pi')}</span>
            ${l.error ? `<span style="color:var(--error); font-size:11px;">${t('log.errorTag')}</span>` : `<span style="color:var(--accent); font-size:11px;">${t('log.toolCalls', { n: (l.tools || []).length })}</span>`}
          </div>
          <span class="log-item-time">${new Date(l.ts).toLocaleTimeString(I18n.locale)}</span>
        </div>
        <div class="log-item-body hidden">
          <div>
            <div class="log-sec-title">${t('log.prompt')}</div>
            <div class="log-code-box">${window.AiCommon.escapeHtml(l.prompt)}</div>
          </div>
          ${
            l.tools && l.tools.length
              ? `<div>
            <div class="log-sec-title">${t('log.tools')}</div>
            <div class="log-code-box">${window.AiCommon.escapeHtml(JSON.stringify(l.tools, null, 2))}</div>
          </div>`
              : ''
          }
          <div>
            <div class="log-sec-title">${t('log.response')}</div>
            <div class="log-code-box">${esc(l.response || t('common.empty'))}</div>
          </div>
          ${
            l.actions && l.actions.length
              ? `<div>
            <div class="log-sec-title">${t('log.actions')}</div>
            <div class="log-code-box">${window.AiCommon.escapeHtml(JSON.stringify(l.actions, null, 2))}</div>
          </div>`
              : ''
          }
          ${
            l.error
              ? `<div>
            <div class="log-sec-title" style="color:var(--error)">${t('log.error')}</div>
            <div class="log-code-box" style="color:var(--error)">${window.AiCommon.escapeHtml(l.error)}</div>
          </div>`
              : ''
          }
        </div>
      `;
      item.querySelector('.log-item-header').addEventListener('click', () => {
        item.querySelector('.log-item-body').classList.toggle('hidden');
      });
      els.teamLogList.appendChild(item);
    }
  }

  // --- MESAJ GÖNDERME ---
  async function sendTeamMessage() {
    if (!currentTeam) return;
    const text = els.teamInput.value.trim();
    if (!text && !pendingAttachments.length) return;

    const attachments = [...pendingAttachments];
    pendingAttachments = [];
    renderPendingAttachments();
    els.teamInput.value = '';

    try {
      const resp = await fetch(`/api/teams/${currentTeam.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, attachments }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || t('team.sendFailed'));
      }
    } catch (err) {
      alert(err.message);
    }
  }

  function renderPendingAttachments() {
    els.teamAttachments.innerHTML = '';
    pendingAttachments.forEach((att, i) => {
      const chip = document.createElement('div');
      chip.className = 'att-chip';
      chip.innerHTML = att.type === 'image' ? '<img alt="" />' : '<span class="file-icon">📄</span>';
      if (att.type === 'image') chip.querySelector('img').src = att.dataUrl;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = att.name;
      chip.appendChild(name);

      const rm = document.createElement('button');
      rm.className = 'remove';
      rm.textContent = '✕';
      rm.addEventListener('click', () => {
        pendingAttachments.splice(i, 1);
        renderPendingAttachments();
      });
      chip.appendChild(rm);
      els.teamAttachments.appendChild(chip);
    });
  }

  async function addFiles(files) {
    for (const f of files) {
      try {
        const att = await window.AiCommon.fileToAttachment(f);
        pendingAttachments.push(att);
      } catch (err) {
        alert(err.message);
      }
    }
    renderPendingAttachments();
  }

  // --- KONTROLLER ---
  async function controlTeam(action) {
    if (!currentTeam) return;
    try {
      const resp = await fetch(`/api/teams/${currentTeam.id}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await resp.json();
      if (data.team) {
        currentTeam = data.team;
        renderTeamWorkspaceHeader();
      }
    } catch (err) {
      alert(err.message);
    }
  }

  // --- ROL KARTI OLUŞTURMA YARDIMCISI ---
  function addRoleCard(container, presetKey = 'developer', initialData = null) {
    const preset = teamPresets[presetKey] || teamPresets.custom || { name: t('role.custom'), color: '#818cf8', systemPrompt: '' };
    const card = document.createElement('div');
    card.className = 'role-card' + (presetKey === 'po' ? ' po-card' : '');

    let presetOpts = '';
    for (const [k, p] of Object.entries(teamPresets)) {
      presetOpts += `<option value="${k}" ${k === presetKey ? 'selected' : ''}>${window.AiCommon.escapeHtml(p.name)}</option>`;
    }

    let provOpts = '';
    for (const pr of providers) {
      provOpts += `<option value="${pr.id}">${window.AiCommon.escapeHtml(pr.label)}</option>`;
    }

    card.innerHTML = `
      <div class="role-card-top">
        <span class="role-badge" style="background:${preset.color}">${window.AiCommon.escapeHtml(preset.name)}</span>
        <select class="role-preset-select" style="width:130px;">${presetOpts}</select>
        <input type="text" class="text-input role-name-input" value="${esc(initialData?.name || preset.name)}" placeholder="${esc(t('role.namePlaceholder'))}" />
        <select class="role-provider-select">${provOpts}</select>
        <select class="role-model-select"></select>
        <select class="role-thinking-select hidden" title="${esc(t('role.thinkingTitle'))}"></select>
        <select class="role-mode-select" title="${esc(t('role.engine'))}">
          <option value="pi" ${initialData?.mode === 'pi' || !initialData ? 'selected' : ''}>${t('role.modePi')}</option>
          <option value="text" ${initialData?.mode === 'text' ? 'selected' : ''}>${t('role.modeText')}</option>
        </select>
        <button class="role-delete-btn" title="${esc(t('role.delete'))}">✕</button>
      </div>

      <div class="role-card-tools">
        <strong style="color:#d1d5db;">${t('role.tools')}</strong>
        ${allTools
          .map((tool) => {
            const isChecked = !initialData?.tools || initialData.tools.includes(tool);
            return `
            <label class="tool-chk-label">
              <input type="checkbox" name="tool_${tool}" value="${tool}" ${isChecked ? 'checked' : ''} />
              <span>${tool}</span>
            </label>
          `;
          })
          .join('')}
      </div>
    `;

    const provSel = card.querySelector('.role-provider-select');
    const modelSel = card.querySelector('.role-model-select');
    const modeSel = card.querySelector('.role-mode-select');
    const thinkingSel = card.querySelector('.role-thinking-select');
    const presetSel = card.querySelector('.role-preset-select');
    const nameInp = card.querySelector('.role-name-input');
    const badge = card.querySelector('.role-badge');
    const delBtn = card.querySelector('.role-delete-btn');

    const defaultProv = initialData?.provider || localStorage.getItem('aiconv.provider') || providers[0]?.id || 'groq';
    provSel.value = defaultProv;

    // Pi üzerinden bağlı sağlayıcılar yalnızca Pi CLI modunda çalışır (metin modu API anahtarı gerektirir).
    function syncModeForProvider() {
      const isPiProvider = String(provSel.value).startsWith('pi:');
      const textOpt = modeSel.querySelector('option[value="text"]');
      if (textOpt) {
        textOpt.disabled = isPiProvider;
        textOpt.textContent = isPiProvider ? t('role.modeTextNoPi') : t('role.modeText');
      }
      if (isPiProvider) modeSel.value = 'pi';
    }

    async function populateModels() {
      const pId = provSel.value;
      if (!pId) return;
      if (!modelsByProvider[pId]) {
        modelSel.innerHTML = `<option value="">${esc(t('common.loading'))}</option>`;
        const fetched = await fetchModels(pId);
        // Bu sırada kullanıcı sağlayıcıyı değiştirdiyse eski sonucu yazma.
        if (provSel.value !== pId) return;
        if (!fetched) {
          modelSel.innerHTML = `<option value="">${esc(t('role.modelsFailed'))}</option>`;
          return;
        }
      }
      const models = modelsByProvider[pId] || [];
      modelSel.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.id + (m.free ? t('model.free') : m.pi ? ' (Pi)' : '');
        modelSel.appendChild(opt);
      }
      if (initialData?.model && models.some((m) => m.id === initialData.model)) {
        modelSel.value = initialData.model;
      }
      window.AiCommon.applyModelColorsToSelect(pId, modelSel);
      populateThinking();
    }

    function hideThinking() {
      thinkingSel.innerHTML = '';
      thinkingSel.classList.add('hidden');
    }

    async function populateThinking() {
      const pId = provSel.value;
      const model = modelSel.value;
      hideThinking();
      if (!pId || !model || modeSel.value !== 'pi') return;
      try {
        const resp = await fetch(`/api/thinking-levels?provider=${encodeURIComponent(pId)}&model=${encodeURIComponent(model)}`);
        const data = await resp.json();
        if (provSel.value !== pId || modelSel.value !== model) return;
        const levels = (Array.isArray(data.levels) ? data.levels : []).filter((l) => THINKING_LEVEL_IDS.includes(l));
        if (!levels.length || (levels.length === 1 && levels[0] === 'off')) return;
        thinkingSel.innerHTML = '';
        const def = document.createElement('option');
        def.value = '';
        def.textContent = t('thinking.defaultShort');
        thinkingSel.appendChild(def);
        for (const lv of levels) {
          const o = document.createElement('option');
          o.value = lv;
          o.textContent = `🧠 ${thinkingLabel(lv)}`;
          thinkingSel.appendChild(o);
        }
        if (initialData?.thinking && levels.includes(initialData.thinking)) thinkingSel.value = initialData.thinking;
        thinkingSel.title = t('role.thinkingLevels', { levels: levels.join(', ') });
        thinkingSel.classList.remove('hidden');
      } catch {
        hideThinking();
      }
    }

    provSel.addEventListener('change', () => {
      syncModeForProvider();
      populateModels();
    });
    modelSel.addEventListener('change', populateThinking);
    modeSel.addEventListener('change', () => {
      if (modeSel.value === 'pi') populateThinking();
      else hideThinking();
    });
    syncModeForProvider();
    populateModels();

    presetSel.addEventListener('change', () => {
      const p = teamPresets[presetSel.value];
      if (p) {
        nameInp.value = p.name;
        badge.textContent = p.name;
        badge.style.background = p.color;
        if (presetSel.value === 'po') card.classList.add('po-card');
        else card.classList.remove('po-card');
      }
    });

    delBtn.addEventListener('click', () => card.remove());
    container.appendChild(card);
  }

  // --- YENİ EKİP KAYDI ---
  async function submitCreateTeam() {
    const name = els.teamNameInput.value.trim() || t('create.defaultName');
    const projectPath = els.projectPathInput.value.trim();

    if (!projectPath) {
      alert(t('create.needPath'));
      return;
    }

    const valResp = await fetch('/api/fs/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath }),
    });
    const valData = await valResp.json();
    if (!valData.ok) {
      alert(t('create.invalidPath', { error: valData.error }));
      return;
    }

    const roleCards = els.rolesList.querySelectorAll('.role-card');
    if (!roleCards.length) {
      alert(t('create.needRole'));
      return;
    }

    const roles = [];
    let hasPO = false;
    let missingModelFor = null;

    roleCards.forEach((card, idx) => {
      const preset = card.querySelector('.role-preset-select').value;
      const roleName = card.querySelector('.role-name-input').value.trim();
      const provider = card.querySelector('.role-provider-select').value;
      const model = card.querySelector('.role-model-select').value;
      const mode = card.querySelector('.role-mode-select').value;
      const thinking = card.querySelector('.role-thinking-select')?.value || '';

      const checkedTools = [];
      card.querySelectorAll('.role-card-tools input[type="checkbox"]:checked').forEach((c) => checkedTools.push(c.value));

      if (!model && !missingModelFor) missingModelFor = roleName || t('role.nth', { n: idx + 1 });
      if (preset === 'po') hasPO = true;

      roles.push({
        preset,
        name: roleName,
        provider,
        model,
        mode,
        thinking,
        tools: checkedTools,
      });
    });

    if (missingModelFor) {
      alert(t('create.needModel', { name: missingModelFor }));
      return;
    }

    if (!hasPO) {
      alert(t('create.needPO'));
      return;
    }

    try {
      els.submitCreateTeamBtn.disabled = true;
      els.submitCreateTeamBtn.textContent = t('create.creating');

      const resp = await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, projectPath: valData.path, roles, budgetLimit: 25, lang: I18n.lang }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || t('create.failed'));
      }

      const data = await resp.json();
      await loadTeams();
      selectTeam(data.team.id);
    } catch (err) {
      alert(err.message);
    } finally {
      els.submitCreateTeamBtn.disabled = false;
      els.submitCreateTeamBtn.textContent = t('create.submit');
    }
  }

  // --- ROLLERİ DÜZENLE MODALI ---
  function openEditRolesModal() {
    if (!currentTeam) return;
    els.editRolesContainer.innerHTML = '';
    for (const r of currentTeam.roles) {
      addRoleCard(els.editRolesContainer, r.preset, r);
    }
    els.editRolesModal.classList.remove('hidden');
  }

  async function saveEditedRoles() {
    if (!currentTeam) return;
    const cards = els.editRolesContainer.querySelectorAll('.role-card');
    const updatedRoles = [];

    cards.forEach((card, idx) => {
      const preset = card.querySelector('.role-preset-select').value;
      const roleName = card.querySelector('.role-name-input').value.trim();
      const provider = card.querySelector('.role-provider-select').value;
      const model = card.querySelector('.role-model-select').value;
      const mode = card.querySelector('.role-mode-select').value;
      const thinking = card.querySelector('.role-thinking-select')?.value || '';

      const checkedTools = [];
      card.querySelectorAll('.role-card-tools input[type="checkbox"]:checked').forEach((c) => checkedTools.push(c.value));

      const origId = currentTeam.roles[idx]?.id || preset;
      updatedRoles.push({
        id: origId,
        provider,
        model,
        mode,
        thinking,
        tools: checkedTools,
      });
    });

    try {
      const resp = await fetch(`/api/teams/${currentTeam.id}/roles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles: updatedRoles }),
      });
      const data = await resp.json();
      if (data.ok) {
        currentTeam = data.team;
        els.editRolesModal.classList.add('hidden');
        alert(t('roles.updated'));
      } else {
        throw new Error(data.error);
      }
    } catch (e) {
      alert(t('roles.updateError', { error: e.message }));
    }
  }

  // --- KLASÖR GEZGİNİ ---
  let browserPath = '';
  function initFolderBrowser() {
    els.browseFolderBtn.addEventListener('click', () => {
      openFolderBrowser(els.projectPathInput.value.trim() || '');
    });
    els.closeFolderBrowseBtn.addEventListener('click', () => els.folderBrowseModal.classList.add('hidden'));
    els.selectCurrentFolderBtn.addEventListener('click', () => {
      els.projectPathInput.value = browserPath;
      validatePath(browserPath);
      els.folderBrowseModal.classList.add('hidden');
    });
    els.browserUpBtn.addEventListener('click', () => {
      if (browserPath) {
        const parts = browserPath.split(/[\\/]/);
        if (parts.length > 1) {
          parts.pop();
          openFolderBrowser(parts.join('\\') || parts.join('/'));
        }
      }
    });

    els.validatePathBtn.addEventListener('click', () => {
      validatePath(els.projectPathInput.value.trim());
    });
  }

  async function openFolderBrowser(targetPath) {
    try {
      const resp = await fetch(`/api/fs/browse?path=${encodeURIComponent(targetPath)}`);
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error);
      browserPath = data.current;
      els.browserCurrentPath.textContent = data.current;
      els.browserFolderList.innerHTML = '';

      if (!data.dirs.length) {
        els.browserFolderList.innerHTML = `<span style="font-size:12px; color:var(--text-dim); padding:6px;">${esc(t('folder.empty'))}</span>`;
      } else {
        for (const dir of data.dirs) {
          const item = document.createElement('div');
          item.className = 'folder-item';
          item.innerHTML = `<span>📁</span> <span>${window.AiCommon.escapeHtml(dir)}</span>`;
          item.addEventListener('dblclick', () => {
            const next = browserPath.endsWith('\\') || browserPath.endsWith('/') ? `${browserPath}${dir}` : `${browserPath}\\${dir}`;
            openFolderBrowser(next);
          });
          item.addEventListener('click', () => {
            document.querySelectorAll('.folder-item').forEach((e) => (e.style.background = ''));
            item.style.background = 'var(--bg-input)';
          });
          els.browserFolderList.appendChild(item);
        }
      }
      els.folderBrowseModal.classList.remove('hidden');
    } catch (e) {
      alert(t('folder.error', { error: e.message }));
    }
  }

  async function validatePath(p) {
    if (!p) {
      els.pathValidationStatus.textContent = '';
      return;
    }
    const resp = await fetch('/api/fs/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    const d = await resp.json();
    if (d.ok) {
      els.pathValidationStatus.textContent = t('create.pathOk', { git: d.hasGit ? t('create.gitYes') : t('create.gitNo') });
      els.pathValidationStatus.className = 'path-status-msg ok';
    } else {
      els.pathValidationStatus.textContent = `✕ ${d.error}`;
      els.pathValidationStatus.className = 'path-status-msg err';
    }
  }

  // --- EVENT LİSTENER'LAR ---
  els.newTeamBtn.addEventListener('click', showCreateView);
  els.addRoleBtn.addEventListener('click', () => addRoleCard(els.rolesList, 'developer'));
  els.submitCreateTeamBtn.addEventListener('click', submitCreateTeam);

  // Kanal ve alt görünüm sekmeleri
  document.querySelectorAll('.team-channels .channel-item[data-channel]').forEach((el) => {
    el.addEventListener('click', () => {
      currentSubView = 'channel';
      activeChannel = el.getAttribute('data-channel');
      renderChannels();
      renderCurrentSubView();
    });
  });

  document.querySelectorAll('.team-channels .channel-item[data-view]').forEach((el) => {
    el.addEventListener('click', () => {
      currentSubView = el.getAttribute('data-view');
      renderChannels();
      renderCurrentSubView();
    });
  });

  // Kontroller
  els.teamPauseBtn.addEventListener('click', () => controlTeam('pause'));
  els.teamResumeBtn.addEventListener('click', () => controlTeam('resume'));
  els.teamExtendBtn.addEventListener('click', () => controlTeam('extend'));
  els.teamEditRolesBtn.addEventListener('click', openEditRolesModal);
  els.closeEditRolesBtn.addEventListener('click', () => els.editRolesModal.classList.add('hidden'));
  els.cancelEditRolesBtn.addEventListener('click', () => els.editRolesModal.classList.add('hidden'));
  els.saveEditRolesBtn.addEventListener('click', saveEditedRoles);

  els.teamDeleteBtn.addEventListener('click', async () => {
    if (!currentTeam) return;
    if (!confirm(t('team.confirmDelete', { name: currentTeam.name }))) return;
    await fetch(`/api/teams/${currentTeam.id}`, { method: 'DELETE' });
    currentTeam = null;
    showCreateView();
    loadTeams();
  });

  els.refreshDocsBtn.addEventListener('click', loadDocs);

  // Mesajlaşma
  els.teamSendBtn.addEventListener('click', sendTeamMessage);
  els.teamInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTeamMessage();
    }
  });

  els.teamAttachBtn.addEventListener('click', () => els.teamFileInput.click());
  els.teamFileInput.addEventListener('change', () => {
    addFiles([...els.teamFileInput.files]);
    els.teamFileInput.value = '';
  });

  // Ayarlar modalı
  els.settingsBtn.addEventListener('click', openSettings);
  els.closeSettingsBtn.addEventListener('click', () => els.settingsModal.classList.add('hidden'));

  async function openSettings() {
    const resp = await fetch('/api/settings');
    const data = await resp.json();
    els.settingsRows.innerHTML = '';
    for (const p of providers) {
      if (p.pi) continue; // Pi üyelikleri aşağıdaki özel bölümde
      const row = document.createElement('div');
      row.className = 'setting-row';
      row.innerHTML = `
        <div class="row-head">
          <label>${window.AiCommon.escapeHtml(p.label)}</label>
          <span class="key-src">${t('settings.keyLabel')} <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${esc(p.keyUrl.replace(/^https?:\/\//, ''))}</a></span>
        </div>
        <div class="row-input">
          <input type="password" placeholder="${data.keys[p.id] ? t('settings.savedPlaceholder') : p.noKey ? t('settings.noKeyPlaceholder') : t('settings.keyPlaceholder')}" />
          <button class="mini-btn save">${t('common.save')}</button>
          <button class="mini-btn clear">${t('common.delete')}</button>
        </div>
        <span class="key-status">${data.keys[p.id] ? t('settings.saved') : p.noKey ? t('settings.noKeyNeeded') : ''}</span>`;
      const input = row.querySelector('input');
      row.querySelector('.save').addEventListener('click', () => saveKey(p.id, input, row));
      row.querySelector('.clear').addEventListener('click', () => saveKey(p.id, { value: '' }, row));
      els.settingsRows.appendChild(row);
    }
    await window.AiCommon.renderPiSettings(els.settingsRows, {
      onChange: async () => {
        await loadProviders();
        refreshRoleProviderOptions();
      },
    });
    els.settingsModal.classList.remove('hidden');
  }

  // Yeni bağlanan Pi sağlayıcılarını, ekrandaki mevcut rol kartlarına ekler (seçimleri bozmadan).
  function refreshRoleProviderOptions() {
    for (const sel of document.querySelectorAll('.role-provider-select')) {
      const existing = new Set([...sel.options].map((o) => o.value));
      for (const pr of providers) {
        if (existing.has(pr.id)) continue;
        const opt = document.createElement('option');
        opt.value = pr.id;
        opt.textContent = pr.label;
        sel.appendChild(opt);
      }
    }
  }

  async function saveKey(provider, input, row) {
    const resp = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, key: input.value }),
    });
    const data = await resp.json();
    input.value = '';
    row.querySelector('.key-status').textContent = data.keySet ? t('settings.saved') : t('settings.deleted');
  }

  init();
})();
