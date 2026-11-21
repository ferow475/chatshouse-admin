// Content Script — runs on chatshouse.com
// Monitors ALL profiles that this worker manages (5-15 girls per worker)

(function() {
  'use strict';
  if (window.__chatAdminLoaded) return;
  window.__chatAdminLoaded = true;

  const API = 'https://api.chatshouse.com/tru';
  let workerId = null;        // ID сотрудника (генерируется 1 раз)
  let workerName = null;      // имя сотрудника из настроек
  let allProfiles = [];       // все профили девушек (из /tru/profiles)
  let profileDialogs = {};    // profileUlid -> { profile, dialogs, mails }
  let currentProfileUlid = null; // текущий активный профиль
  let currentContactUlid = null; // текущий открытый диалог
  let syncTimer = null;
  let lastUrlCheck = '';

  // ─── Worker ID ────────────────────────────────────────────
  // Генерируем постоянный ID сотрудника и сохраняем в localStorage
  function getWorkerId() {
    let id = localStorage.getItem('__ca_worker_id');
    if (!id) {
      id = 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('__ca_worker_id', id);
    }
    return id;
  }

  // ─── Intercept fetch ──────────────────────────────────────
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const promise = originalFetch.apply(this, args);

    // Intercept dialogs list (triggered when switching profiles or refreshing)
    if (url.match(/\/tru\/dialogs(\?|$)/) && !url.includes('/tru/dialogs/')) {
      promise.then(r => r.clone().json().then(data => {
        if (data && data.data && currentProfileUlid) {
          if (!profileDialogs[currentProfileUlid]) profileDialogs[currentProfileUlid] = { dialogs: [], mails: [] };
          profileDialogs[currentProfileUlid].dialogs = data.data;
          scheduleSync();
        }
      }).catch(() => {}));
    }

    // Intercept single dialog messages
    if (url.match(/\/tru\/dialogs\/[A-Z0-9]+/i) || url.match(/\/tru\/dialog\/[A-Z0-9]+/i)) {
      promise.then(r => r.clone().json().then(data => {
        if (data && data.messages && data.messages.length && currentProfileUlid) {
          const contactUlid = data.dialog && data.dialog.contact && data.dialog.contact.ulid_id;
          if (contactUlid) {
            chrome.runtime.sendMessage({
              type: 'send_messages',
              profileUlid: currentProfileUlid,
              contactUlid,
              messages: data.messages
            }).catch(() => {});
          }
        }
      }).catch(() => {}));
    }

    // Intercept profiles list → detect which profile is active
    if (url.includes('/tru/profiles')) {
      promise.then(r => r.clone().json().then(data => {
        if (data && data.data) {
          allProfiles = data.data;
        }
      }).catch(() => {}));
    }

    // Intercept init → detect current active profile from URL
    if (url.includes('/tru/init')) {
      promise.then(r => r.clone().json().then(data => {
        if (data && data.user) {
          // After init, detect which profile is currently active
          detectCurrentProfile();
        }
      }).catch(() => {}));
    }

    // Intercept mails
    if (url.includes('/tru/inmails') || url.includes('/tru/mails')) {
      promise.then(r => r.clone().json().then(data => {
        if (data && data.data && currentProfileUlid) {
          const processed = data.data.map(m => ({
            id: m.id,
            profile_ulid: currentProfileUlid,
            contact_ulid: m.user ? m.user.ulid_id : (m.contact ? m.contact.ulid_id : ''),
            contact_name: m.user ? m.user.name : (m.contact ? m.contact.name : ''),
            subject: m.subject || '',
            body: m.body || m.last_message_body || '',
            is_incoming: m.is_incoming !== undefined ? (m.is_incoming ? 1 : 0) : 1,
            is_read: m.is_read ? 1 : 0,
            sent_at: m.sent_at || m.created_at || ''
          }));
          if (!profileDialogs[currentProfileUlid]) profileDialogs[currentProfileUlid] = { dialogs: [], mails: [] };
          profileDialogs[currentProfileUlid].mails = processed;
          scheduleSync();
        }
      }).catch(() => {}));
    }

    return promise;
  };

  // ─── Detect current active profile ───────────────────────
  // На сайте у сотрудника выбран определённый профиль девушки.
  // Определяем его по x_ulid параметру в URL или по данным init.
  async function detectCurrentProfile() {
    try {
      // Смотрим на x_ulid в URL (chatshouse использует этот параметр)
      const urlParams = new URLSearchParams(window.location.search);
      const xUlid = urlParams.get('x_ulid');

      if (xUlid) {
        currentProfileUlid = xUlid;
      } else {
        // Fallback: получаем из /tru/init
        const r = await originalFetch(`${API}/init?from=/dialogs&ft=${Date.now()}`, { credentials: 'include' });
        const data = await r.json();
        if (data && data.user) {
          currentProfileUlid = data.user.ulid_id;
        }
      }

      // Загрузить профили если ещё не загружены
      if (!allProfiles.length) {
        const pr = await originalFetch(`${API}/profiles`, { credentials: 'include' });
        const pdata = await pr.json();
        if (pdata && pdata.data) allProfiles = pdata.data;
      }

      updateOverlayProfile();
    } catch(e) {}
  }

  // ─── Full sync ────────────────────────────────────────────
  // Собираем данные по ВСЕМ профилям текущего сотрудника
  async function fullSync() {
    if (!workerId) return;
    try {
      // Определяем текущий профиль
      await detectCurrentProfile();

      // Загружаем диалоги текущего профиля
      if (currentProfileUlid) {
        const dr = await originalFetch(`${API}/dialogs?search=&tab=saved&is_online=0&unread=0&per_page=100&x_ulid=${currentProfileUlid}`, { credentials: 'include' });
        const ddata = await dr.json();
        if (ddata && ddata.data) {
          if (!profileDialogs[currentProfileUlid]) profileDialogs[currentProfileUlid] = { dialogs: [], mails: [] };
          profileDialogs[currentProfileUlid].dialogs = ddata.data;
        }

        // Загружаем письма текущего профиля
        try {
          const mr = await originalFetch(`${API}/inmails?tab=inbox&per_page=50`, { credentials: 'include' });
          const mdata = await mr.json();
          if (mdata && mdata.data) {
            const processed = mdata.data.map(m => ({
              id: m.id,
              profile_ulid: currentProfileUlid,
              contact_ulid: m.user ? m.user.ulid_id : '',
              contact_name: m.user ? m.user.name : '',
              subject: m.subject || '',
              body: m.body || '',
              is_incoming: m.is_incoming ? 1 : 0,
              is_read: m.is_read ? 1 : 0,
              sent_at: m.sent_at || ''
            }));
            profileDialogs[currentProfileUlid].mails = processed;
          }
        } catch(e) {}
      }

      // Собираем данные по всем профилям для отправки
      const profilesPayload = allProfiles.map(p => {
        const pd = profileDialogs[p.ulid_id] || { dialogs: [], mails: [] };
        return {
          ulid: p.ulid_id,
          name: p.name,
          photo: p.main_photo ? p.main_photo.profile_url : '',
          dialogs: pd.dialogs,
          mails: pd.mails
        };
      }).filter(p => p.ulid);

      // Если нет профилей в списке, добавляем хотя бы текущий
      if (profilesPayload.length === 0 && currentProfileUlid) {
        const pd = profileDialogs[currentProfileUlid] || { dialogs: [], mails: [] };
        profilesPayload.push({
          ulid: currentProfileUlid,
          name: 'Unknown',
          photo: '',
          dialogs: pd.dialogs,
          mails: pd.mails
        });
      }

      // Собираем все письма
      const allMails = [];
      Object.values(profileDialogs).forEach(pd => {
        allMails.push(...(pd.mails || []));
      });

      // Отправляем на backend
      chrome.runtime.sendMessage({
        type: 'sync_all_profiles',
        workerId,
        workerName,
        profiles: profilesPayload,
        mails: allMails
      }).catch(() => {});

      // Обновляем оверлей
      updateOverlayAll();
      checkUrgentDialogs();
    } catch(e) {}
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(fullSync, 2000);
  }

  // ─── Watch URL changes ─────────────────────────────────────
  new MutationObserver(() => {
    if (location.href !== lastUrlCheck) {
      lastUrlCheck = location.href;
      onUrlChange(location.href);
    }
  }).observe(document, { subtree: true, childList: true });

  function onUrlChange(url) {
    // Определяем x_ulid из URL
    const params = new URLSearchParams(url.split('?')[1] || '');
    const xUlid = params.get('x_ulid');
    if (xUlid && xUlid !== currentProfileUlid) {
      currentProfileUlid = xUlid;
      updateOverlayProfile();
      scheduleSync();
    }

    // Определяем текущий диалог
    const dialogMatch = url.match(/\/dialogs\/([A-Z0-9]+)/i);
    if (dialogMatch) {
      currentContactUlid = dialogMatch[1];
      chrome.runtime.sendMessage({ type: 'log_event', profileUlid: currentProfileUlid, eventType: 'open_dialog', payload: { contactUlid: currentContactUlid } }).catch(() => {});
      setTimeout(loadCurrentDialogMessages, 1500);
    }

    if (url.includes('/mails') || url.includes('/icebreakers')) {
      chrome.runtime.sendMessage({ type: 'log_event', profileUlid: currentProfileUlid, eventType: 'open_mails', payload: {} }).catch(() => {});
    }
  }

  async function loadCurrentDialogMessages() {
    if (!currentContactUlid || !currentProfileUlid) return;
    try {
      const r = await originalFetch(`${API}/dialogs/${currentContactUlid}`, { credentials: 'include' });
      const data = await r.json();
      if (data && data.messages) {
        chrome.runtime.sendMessage({
          type: 'send_messages',
          profileUlid: currentProfileUlid,
          contactUlid: currentContactUlid,
          messages: data.messages
        }).catch(() => {});
      }
    } catch(e) {}
  }

  // ─── Check urgent ─────────────────────────────────────────
  function checkUrgentDialogs() {
    const now = new Date();
    Object.entries(profileDialogs).forEach(([profUlid, pd]) => {
      const profile = allProfiles.find(p => p.ulid_id === profUlid);
      const profName = profile ? profile.name : '?';
      (pd.dialogs || []).forEach(d => {
        if (!d.is_last_message_incoming || !d.last_message_sent_at) return;
        const mins = (now - new Date(d.last_message_sent_at)) / 60000;
        const online = d.contact && d.contact.is_online;
        if (online && mins > 5) {
          showInPageAlert(`🟢 [${profName}] ${d.contact.name} ONLINE — waiting ${Math.round(mins)}min!`, 'high', profUlid + d.contact.ulid_id);
        }
      });
    });
  }

  // ─── Overlay ──────────────────────────────────────────────
  function createOverlay() {
    if (document.getElementById('ca-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'ca-overlay';
    overlay.innerHTML = `
      <div id="ca-ov-header">
        <span id="ca-ov-logo">🔍 Monitor</span>
        <span id="ca-ov-profile" style="font-size:10px;color:#8892a4;flex:1;text-align:center"></span>
        <div id="ca-ov-controls">
          <span id="ca-ov-status">⚪</span>
          <button id="ca-ov-toggle">▼</button>
          <button id="ca-ov-close">✕</button>
        </div>
      </div>
      <div id="ca-ov-body">
        <div id="ca-ov-tabs">
          <button class="ca-ov-tab active" data-tab="urgent">🔴 Urgent</button>
          <button class="ca-ov-tab" data-tab="dialogs">💬 Dialogs</button>
          <button class="ca-ov-tab" data-tab="tips">💡 AI Tips</button>
          <button class="ca-ov-tab" data-tab="mails">✉️ Mails</button>
        </div>
        <div id="ca-ov-content">
          <div class="ca-ov-panel active" id="ca-panel-urgent"><div class="ca-ov-empty">✅ No urgent items</div></div>
          <div class="ca-ov-panel" id="ca-panel-dialogs"><div class="ca-ov-empty">Loading...</div></div>
          <div class="ca-ov-panel" id="ca-panel-tips"><div class="ca-ov-empty">💡 AI tips appear here after analysis</div></div>
          <div class="ca-ov-panel" id="ca-panel-mails"><div class="ca-ov-empty">📭 No new mails</div></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const style = document.createElement('style');
    style.textContent = `
      #ca-overlay { position:fixed;bottom:20px;right:20px;width:340px;background:#1a1d2e;border:1px solid #2e3155;border-radius:12px;z-index:2147483647;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;color:#e2e8f0;box-shadow:0 8px 32px rgba(0,0,0,0.5); }
      #ca-ov-header { display:flex;align-items:center;padding:10px 12px;background:#252840;border-radius:12px 12px 0 0;border-bottom:1px solid #2e3155;cursor:move;user-select:none; }
      #ca-ov-logo { font-weight:700;color:#6c63ff;font-size:12px; }
      #ca-ov-controls { display:flex;gap:6px;align-items:center; }
      #ca-ov-controls button { background:none;border:none;cursor:pointer;color:#8892a4;font-size:13px;padding:2px 4px;border-radius:4px; }
      #ca-ov-controls button:hover { background:#2e3155;color:#e2e8f0; }
      #ca-ov-tabs { display:flex;gap:2px;padding:8px 8px 0; }
      .ca-ov-tab { flex:1;padding:5px 4px;background:none;border:none;border-radius:6px 6px 0 0;cursor:pointer;color:#8892a4;font-size:10px;font-weight:600; }
      .ca-ov-tab.active { background:#252840;color:#6c63ff; }
      #ca-ov-content { max-height:320px;overflow-y:auto; }
      .ca-ov-panel { display:none;padding:8px; }
      .ca-ov-panel.active { display:block; }
      .ca-ov-empty { text-align:center;padding:20px;color:#8892a4;font-size:12px; }
      .ca-ov-item { background:#252840;border-radius:8px;padding:8px 10px;margin-bottom:6px;border-left:3px solid #2e3155; }
      .ca-ov-item.urgent { border-left-color:#ef4444; }
      .ca-ov-item.warning { border-left-color:#f59e0b; }
      .ca-ov-item.info { border-left-color:#6c63ff; }
      .ca-ov-item-name { font-weight:600;font-size:12px;margin-bottom:2px; }
      .ca-ov-item-text { color:#8892a4;font-size:11px;line-height:1.4; }
      .ca-ov-btn { display:inline-block;padding:2px 8px;background:#6c63ff;color:#fff;border-radius:4px;font-size:10px;cursor:pointer;text-decoration:none;margin-top:4px; }
      .ca-profile-badge { display:inline-block;padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;background:rgba(108,99,255,0.2);color:#6c63ff;margin-right:4px; }
      #ca-ov-alert { position:fixed;top:20px;right:20px;z-index:2147483648;background:#1a1d2e;border:2px solid #ef4444;border-radius:10px;padding:12px 16px;max-width:320px;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;color:#e2e8f0;box-shadow:0 4px 20px rgba(239,68,68,0.3);animation:ca-slide-in 0.3s ease; }
      #ca-ov-alert.warning { border-color:#f59e0b; }
      @keyframes ca-slide-in { from{transform:translateX(120%);opacity:0} to{transform:translateX(0);opacity:1} }
      .ca-ov-tip-item { background:#252840;border-radius:8px;padding:8px 10px;margin-bottom:6px; }
      .ca-ov-tip-contact { font-weight:600;font-size:11px;color:#6c63ff;margin-bottom:4px; }
      .ca-ov-tip-list { list-style:none; }
      .ca-ov-tip-list li { font-size:11px;color:#e2e8f0;padding:2px 0; }
      .ca-ov-tip-list li::before { content:'→ ';color:#6c63ff; }
      .ca-ov-score { display:inline-block;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:700;margin-left:4px; }
      .ca-ov-score.good { background:rgba(34,197,94,0.2);color:#22c55e; }
      .ca-ov-score.avg { background:rgba(245,158,11,0.2);color:#f59e0b; }
      .ca-ov-score.bad { background:rgba(239,68,68,0.2);color:#ef4444; }
      #ca-overlay::-webkit-scrollbar { width:4px; }
      #ca-overlay::-webkit-scrollbar-thumb { background:#2e3155;border-radius:2px; }
    `;
    document.head.appendChild(style);

    overlay.querySelectorAll('.ca-ov-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        overlay.querySelectorAll('.ca-ov-tab').forEach(t => t.classList.remove('active'));
        overlay.querySelectorAll('.ca-ov-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('ca-panel-' + tab.dataset.tab).classList.add('active');
      });
    });
    document.getElementById('ca-ov-close').addEventListener('click', () => { overlay.style.display = 'none'; });
    document.getElementById('ca-ov-toggle').addEventListener('click', () => {
      const body = document.getElementById('ca-ov-body');
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });
    makeDraggable(overlay, document.getElementById('ca-ov-header'));
  }

  function makeDraggable(el, handle) {
    let x = 0, y = 0, mx = 0, my = 0;
    handle.addEventListener('mousedown', e => {
      e.preventDefault(); mx = e.clientX; my = e.clientY;
      document.addEventListener('mousemove', drag);
      document.addEventListener('mouseup', () => { document.removeEventListener('mousemove', drag); });
    });
    function drag(e) {
      x = mx - e.clientX; y = my - e.clientY; mx = e.clientX; my = e.clientY;
      el.style.top = (el.offsetTop - y) + 'px';
      el.style.right = 'auto'; el.style.left = (el.offsetLeft - x) + 'px'; el.style.bottom = 'auto';
    }
  }

  function updateOverlayProfile() {
    const el = document.getElementById('ca-ov-profile');
    if (!el) return;
    if (currentProfileUlid) {
      const p = allProfiles.find(x => x.ulid_id === currentProfileUlid);
      el.textContent = p ? `👤 ${p.name}` : currentProfileUlid.slice(-6);
    }
  }

  function timeAgo(str) {
    if (!str) return '';
    const m = Math.round((new Date() - new Date(str)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    return Math.round(m/60) + 'h ago';
  }

  function updateOverlayAll() {
    const urgentPanel = document.getElementById('ca-panel-urgent');
    const dialogsPanel = document.getElementById('ca-panel-dialogs');
    if (!urgentPanel || !dialogsPanel) return;

    const now = new Date();
    const urgent = [];
    const allDialogs = [];

    Object.entries(profileDialogs).forEach(([profUlid, pd]) => {
      const profile = allProfiles.find(p => p.ulid_id === profUlid);
      const profName = profile ? profile.name : profUlid.slice(-4);
      (pd.dialogs || []).forEach(d => {
        const mins = d.last_message_sent_at ? (now - new Date(d.last_message_sent_at)) / 60000 : 0;
        const online = d.contact && d.contact.is_online;
        const inc = d.is_last_message_incoming;
        const name = d.contact ? d.contact.name : '—';
        const ulid = d.contact ? d.contact.ulid_id : '';
        const credits = d.contact && d.contact.credits ? d.contact.credits.spend : '—';
        const item = { profName, profUlid, name, ulid, mins, online, inc, msg: d.last_message_body, credits };
        allDialogs.push(item);
        if (inc && online && mins > 3) urgent.push({ ...item, level: 'urgent' });
        else if (inc && mins > 20) urgent.push({ ...item, level: 'warning' });
      });
    });

    // Render urgent
    if (!urgent.length) {
      urgentPanel.innerHTML = '<div class="ca-ov-empty">✅ No urgent items</div>';
    } else {
      urgentPanel.innerHTML = urgent.map(u => `
        <div class="ca-ov-item ${u.level}">
          <div class="ca-ov-item-name"><span class="ca-profile-badge">${u.profName}</span>${u.online ? '🟢' : '⏰'} ${u.name}</div>
          <div class="ca-ov-item-text">${u.online ? 'ONLINE! Waiting' : 'Waiting'} ${Math.round(u.mins)}min</div>
          <div class="ca-ov-item-text">"${(u.msg || '').slice(0, 55)}"</div>
          <a href="/dialogs/${u.ulid}?x_ulid=${u.profUlid}" class="ca-ov-btn">Reply →</a>
        </div>`).join('');
    }

    // Render all dialogs sorted by urgency
    const sorted = allDialogs.sort((a,b) => (b.inc ? 1 : 0) - (a.inc ? 1 : 0)).slice(0, 20);
    dialogsPanel.innerHTML = sorted.map(d => `
      <div class="ca-ov-item ${d.inc && d.online ? 'urgent' : d.inc ? 'warning' : 'info'}">
        <div class="ca-ov-item-name"><span class="ca-profile-badge">${d.profName}</span>${d.online ? '🟢 ' : ''}${d.name} <span style="color:#8892a4;font-size:10px">${d.credits} cr</span></div>
        <div class="ca-ov-item-text">${d.inc ? '📨' : '📤'} "${(d.msg || '').slice(0, 50)}"</div>
        <a href="/dialogs/${d.ulid}?x_ulid=${d.profUlid}" class="ca-ov-btn">Open →</a>
      </div>`).join('') || '<div class="ca-ov-empty">No dialogs yet</div>';

    // Mails
    updateMailsPanel();
  }

  function updateMailsPanel() {
    const panel = document.getElementById('ca-panel-mails');
    if (!panel) return;
    const unread = [];
    Object.entries(profileDialogs).forEach(([profUlid, pd]) => {
      const profile = allProfiles.find(p => p.ulid_id === profUlid);
      const profName = profile ? profile.name : '?';
      (pd.mails || []).filter(m => m.is_incoming && !m.is_read).forEach(m => {
        unread.push({ ...m, profName, profUlid });
      });
    });
    if (!unread.length) { panel.innerHTML = '<div class="ca-ov-empty">📭 No unread mails</div>'; return; }
    panel.innerHTML = `<div style="color:#f59e0b;font-weight:600;font-size:12px;padding:4px 2px;margin-bottom:6px">📬 ${unread.length} unread mails</div>` +
      unread.slice(0, 10).map(m => `
        <div class="ca-ov-item warning">
          <div class="ca-ov-item-name"><span class="ca-profile-badge">${m.profName}</span>✉️ ${m.contact_name}</div>
          <div class="ca-ov-item-text">${(m.subject || m.body || '').slice(0, 60)}</div>
          <a href="/mails?x_ulid=${m.profUlid}" class="ca-ov-btn">View →</a>
        </div>`).join('');
  }

  // ─── In-page alert ────────────────────────────────────────
  const shownAlerts = new Set();
  function showInPageAlert(message, severity, uid) {
    const key = uid + message.slice(0, 20);
    if (shownAlerts.has(key)) return;
    shownAlerts.add(key);
    setTimeout(() => shownAlerts.delete(key), 600000);
    let alertEl = document.getElementById('ca-ov-alert');
    if (!alertEl) { alertEl = document.createElement('div'); alertEl.id = 'ca-ov-alert'; document.body.appendChild(alertEl); }
    alertEl.className = severity === 'high' ? '' : 'warning';
    alertEl.innerHTML = `
      <div style="font-weight:700;margin-bottom:4px">${severity === 'high' ? '🔴 URGENT' : '⚠️ Reminder'}</div>
      <div style="font-size:12px">${message}</div>
      <div style="text-align:right;margin-top:6px">
        <button onclick="this.parentElement.parentElement.style.display='none'" style="background:none;border:1px solid #2e3155;color:#8892a4;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">OK</button>
      </div>`;
    alertEl.style.display = 'block';
    setTimeout(() => { if (alertEl) alertEl.style.display = 'none'; }, 15000);
  }

  // ─── Show AI tips ─────────────────────────────────────────
  function showAITips(data) {
    const panel = document.getElementById('ca-panel-tips');
    if (!panel) return;
    const scoreClass = data.score >= 80 ? 'good' : data.score >= 55 ? 'avg' : 'bad';
    const html = `<div class="ca-ov-tip-item">
      <div class="ca-ov-tip-contact"><span class="ca-profile-badge">${data.profileName || '?'}</span>${data.contactName} <span class="ca-ov-score ${scoreClass}">${data.score}</span></div>
      <div style="color:#8892a4;font-size:11px;margin-bottom:6px">${data.comment || ''}</div>
      <ul class="ca-ov-tip-list">${(data.tips || []).map(t => `<li>${t}</li>`).join('')}</ul>
    </div>`;
    if (panel.innerHTML.includes('ca-ov-empty')) panel.innerHTML = html;
    else panel.innerHTML = html + panel.innerHTML;

    // Switch to tips tab
    document.querySelectorAll('.ca-ov-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.ca-ov-panel').forEach(p => p.classList.remove('active'));
    const tipsTab = document.querySelector('.ca-ov-tab[data-tab="tips"]');
    if (tipsTab) tipsTab.classList.add('active');
    panel.classList.add('active');

    if (data.score < 50) showInPageAlert(`💡 [${data.profileName}] Low score ${data.score} for ${data.contactName}: ${data.tips && data.tips[0] || 'Improve responses'}`, 'medium', data.profileUlid + data.contactUlid);
  }

  // ─── Messages from background ─────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'trigger_sync') { fullSync(); sendResponse({ ok: true }); }
    else if (msg.type === 'ai_tips') { showAITips(msg); sendResponse({ ok: true }); }
    else if (msg.type === 'notification') {
      showInPageAlert(msg.message, msg.severity || 'medium', msg.contactUlid || Math.random().toString());
    }
    return true;
  });

  // ─── Init ─────────────────────────────────────────────────
  async function init() {
    workerId = getWorkerId();
    // Get worker name from storage
    chrome.storage.local.get(['workerName'], (r) => { workerName = r.workerName || 'Worker'; });

    // Register worker with background
    chrome.runtime.sendMessage({ type: 'set_worker', workerId, workerName: workerName || 'Worker' }).catch(() => {});

    createOverlay();
    await detectCurrentProfile();
    setTimeout(fullSync, 2000);
    setInterval(fullSync, 30000);
    onUrlChange(location.href);
  }

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init);
})();
