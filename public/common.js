// public/common.js - Ortak yardımcı fonksiyonlar ve durum yönetimi
(function (global) {
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderMarkdown(text) {
    const parts = String(text || '').split(/```/);
    let html = '';
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const firstNl = part.indexOf('\n');
        const code = firstNl >= 0 ? part.slice(firstNl + 1) : part;
        html += `<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
      } else {
        html += renderProse(part);
      }
    });
    return html;
  }

  // Markdown tablo ayraç satırı: | --- | :---: |
  const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  function renderProse(text) {
    const lines = escapeHtml(text).split('\n');
    let html = '';
    let inList = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Tablo: başlık satırı ve hemen altında ayraç satırı
      if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_SEP_RE.test(lines[i + 1])) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        html += '<table class="md-table"><thead><tr>' + splitRow(line).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
        let j = i + 2;
        for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) {
          html += '<tr>' + splitRow(lines[j]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
        }
        html += '</tbody></table>';
        i = j - 1;
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        html += '<hr>';
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)/);
      const bullet = line.match(/^\s*[-*]\s+(.*)/);
      const numbered = line.match(/^\s*\d+\.\s+(.*)/);
      if (heading) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        const lvl = Math.min(heading[1].length + 1, 4);
        html += `<h${lvl}>${inline(heading[2])}</h${lvl}>`;
      } else if (bullet || numbered) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += `<li>${inline(bullet ? bullet[1] : numbered[1])}</li>`;
      } else {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        if (line.trim()) html += `<p>${inline(line)}</p>`;
      }
    }
    if (inList) html += '</ul>';
    return html;
  }

  const MAX_IMAGE_SIDE = 1600;
  const MAX_TEXT_CHARS = 200000;
  const MAX_FILE_BYTES = 20 * 1024 * 1024;

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  async function imageToDataUrl(file) {
    const src = await readAsDataUrl(file);
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(t('file.imageReadError')));
      i.src = src;
    });
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
    if (scale === 1 && file.size < 1024 * 1024 && /jpe?g|png|webp/.test(file.type)) return src;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  async function fileToAttachment(file) {
    if (file.size > MAX_FILE_BYTES) throw new Error(t('file.tooBig', { name: file.name }));
    if (file.type.startsWith('image/')) {
      return { type: 'image', name: file.name || t('file.defaultImageName'), dataUrl: await imageToDataUrl(file) };
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.subarray(0, 8192).includes(0)) {
      throw new Error(t('file.binary', { name: file.name }));
    }
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + '\n' + t('file.truncated');
    return { type: 'file', name: file.name, text };
  }

  function applyModelColorsToSelect(providerId, selectEl, statusMap = null) {
    if (!statusMap) {
      const allStatus = JSON.parse(localStorage.getItem('aiconv.status') || '{}');
      statusMap = allStatus[providerId] || {};
    }
    for (const opt of selectEl.options) {
      const st = statusMap[opt.value];
      if (st && !st.ok) {
        opt.style.color = '#e5484d';
        opt.title = t('model.notWorking', { error: st.error || t('model.error') });
      } else if (st && st.ok) {
        opt.style.color = '#10a37f';
        opt.title = t('model.working');
      } else {
        opt.style.color = '';
        opt.title = '';
      }
    }
  }

  // --- PI ÜYELİK / OAUTH AYARLARI (ortak arayüz) ---
  async function renderPiSettings(container, opts = {}) {
    const section = document.createElement('div');
    section.className = 'pi-auth-section';
    section.innerHTML = `
      <h3 class="pi-auth-title">${t('pi.title')} <span class="pi-auth-badge">${t('pi.badge')}</span></h3>
      <p class="pi-auth-desc">${t('pi.desc')}</p>
      <div class="pi-auth-rows"><span class="pi-auth-loading">${t('common.loading')}</span></div>`;
    container.appendChild(section);
    const rowsEl = section.querySelector('.pi-auth-rows');

    async function refresh() {
      const resp = await fetch('/api/pi-auth/providers');
      const data = await resp.json();
      rowsEl.innerHTML = '';
      for (const p of data.providers || []) rowsEl.appendChild(buildRow(p));
    }

    function buildRow(p) {
      const row = document.createElement('div');
      row.className = 'pi-auth-row';
      row.innerHTML = `
        <div class="pi-auth-row-head">
          <label>${window.AiCommon.escapeHtml(p.label)}</label>
          <span class="pi-auth-status ${p.connected ? 'connected' : 'off'}">
            ${p.connected ? t('pi.connected') : t('pi.notConnected')}
          </span>
        </div>
        <div class="pi-auth-row-desc">${window.AiCommon.escapeHtml(p.description || '')}</div>
        <div class="pi-auth-actions">
          <button class="mini-btn primary connect">${p.connected ? t('pi.reconnect') : t('pi.connect')}</button>
          ${p.connected ? `<button class="mini-btn disconnect">${t('pi.disconnect')}</button>` : ''}
        </div>
        <div class="pi-auth-flow hidden"></div>`;

      const flow = row.querySelector('.pi-auth-flow');
      flow.innerHTML = `<div class="pi-auth-flow-content"></div><button class="mini-btn pi-auth-cancel hidden">${t('common.giveUp')}</button>`;
      const flowContent = flow.querySelector('.pi-auth-flow-content');
      const cancelBtn = flow.querySelector('.pi-auth-cancel');
      let source = null;
      let sessionId = null;

      const closeFlow = () => {
        if (source) source.close();
        source = null;
        sessionId = null;
        flow.classList.add('hidden');
        flowContent.innerHTML = '';
        cancelBtn.classList.add('hidden');
      };

      cancelBtn.addEventListener('click', async () => {
        if (sessionId) await fetch(`/api/pi-auth/login/${sessionId}/cancel`, { method: 'POST' }).catch(() => {});
        closeFlow();
      });

      const sendInput = async (promptId, value) => {
        await fetch(`/api/pi-auth/login/${sessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ promptId, value }),
        });
      };

      const handleEvent = async (ev) => {
        if (ev.type === 'notify') {
          if (ev.notifyType === 'auth_url') {
            flowContent.innerHTML = `<div class="pi-auth-info">${t('pi.authUrl', { url: window.AiCommon.escapeHtml(ev.url || '') })}</div>`;
          } else if (ev.notifyType === 'device_code') {
            flowContent.innerHTML = `<div class="pi-auth-info">${t('pi.deviceGo')} <a href="${window.AiCommon.escapeHtml(ev.verificationUri || '')}" target="_blank" rel="noopener">${window.AiCommon.escapeHtml(ev.verificationUri)}</a><br>
              ${t('pi.deviceCode')} <strong class="pi-auth-code">${window.AiCommon.escapeHtml(ev.userCode || '')}</strong></div>`;
          } else if (ev.notifyType === 'progress') {
            flowContent.innerHTML = `<div class="pi-auth-info">⏳ ${window.AiCommon.escapeHtml(ev.message || '')}</div>`;
          }
        } else if (ev.type === 'prompt') {
          const prompt = ev.prompt || {};
          if (prompt.type === 'select') {
            flowContent.innerHTML = `<div class="pi-auth-info">${window.AiCommon.escapeHtml(prompt.message || t('pi.selectMethod'))}</div>`;
            const btnWrap = document.createElement('div');
            btnWrap.className = 'pi-auth-options';
            for (const opt of prompt.options || []) {
              const b = document.createElement('button');
              b.className = 'mini-btn primary';
              b.textContent = opt.label || opt.id;
              b.addEventListener('click', () => sendInput(ev.promptId, opt.id));
              btnWrap.appendChild(b);
            }
            flowContent.appendChild(btnWrap);
          } else {
            flowContent.innerHTML = `<div class="pi-auth-info">${window.AiCommon.escapeHtml(prompt.message || t('pi.inputNeeded'))}</div>`;
            const wrap = document.createElement('div');
            wrap.className = 'pi-auth-input-row';
            const input = document.createElement('input');
            input.type = prompt.type === 'secret' ? 'password' : 'text';
            input.placeholder = prompt.placeholder || '';
            const b = document.createElement('button');
            b.className = 'mini-btn primary';
            b.textContent = t('common.send');
            b.addEventListener('click', () => sendInput(ev.promptId, input.value));
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') sendInput(ev.promptId, input.value);
            });
            wrap.appendChild(input);
            wrap.appendChild(b);
            flowContent.appendChild(wrap);
          }
        } else if (ev.type === 'done') {
          flowContent.innerHTML = `<div class="pi-auth-ok">${t('pi.done', { label: window.AiCommon.escapeHtml(ev.label || t('pi.provider')) })}</div>`;
          cancelBtn.classList.add('hidden');
          if (source) source.close();
          source = null;
          setTimeout(async () => {
            closeFlow();
            await refresh();
            opts.onChange?.();
          }, 1800);
        } else if (ev.type === 'error') {
          flowContent.innerHTML = `<div class="pi-auth-err">✕ ${window.AiCommon.escapeHtml(ev.message || t('pi.failed'))}</div>`;
          cancelBtn.classList.add('hidden');
          if (source) source.close();
          source = null;
        }
      };

      row.querySelector('.connect').addEventListener('click', async () => {
        closeFlow();
        flow.classList.remove('hidden');
        cancelBtn.classList.remove('hidden');
        flowContent.innerHTML = `<div class="pi-auth-info">${t('pi.starting')}</div>`;
        try {
          const resp = await fetch('/api/pi-auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: p.id }),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || t('pi.startFailed'));
          sessionId = data.sessionId;
          source = new EventSource(`/api/pi-auth/login/${sessionId}/events`);
          source.onmessage = (e) => {
            try {
              handleEvent(JSON.parse(e.data));
            } catch {}
          };
          source.onerror = () => {};
        } catch (err) {
          cancelBtn.classList.add('hidden');
          flowContent.innerHTML = `<div class="pi-auth-err">✕ ${window.AiCommon.escapeHtml(err.message)}</div>`;
        }
      });

      row.querySelector('.disconnect')?.addEventListener('click', async () => {
        if (!confirm(t('pi.confirmDisconnect', { label: p.label }))) return;
        await fetch('/api/pi-auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: p.id }),
        });
        await refresh();
        opts.onChange?.();
      });

      return row;
    }

    await refresh();
  }

  global.escapeHtml = escapeHtml;
  global.renderMarkdown = renderMarkdown;
  global.fileToAttachment = fileToAttachment;
  global.applyModelColorsToSelect = applyModelColorsToSelect;

  global.AiCommon = {
    escapeHtml,
    renderMarkdown,
    fileToAttachment,
    applyModelColorsToSelect,
    renderPiSettings,
  };
})(typeof window !== 'undefined' ? window : globalThis);
