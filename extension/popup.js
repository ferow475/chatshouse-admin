// Popup script — worker settings and stats
let backendUrl = 'https://chatshouse-admin-production.up.railway.app';

async function init() {
  const cfg = await chrome.storage.local.get(['backendUrl', 'workerInfo', 'workerName']);
  if (cfg.backendUrl) { backendUrl = cfg.backendUrl; document.getElementById('backend-url').value = backendUrl; }
  
  // Show worker info
  const wi = cfg.workerInfo;
  if (wi) {
    document.getElementById('worker-id-display').textContent = 'ID: ' + (wi.workerId || '').slice(0, 16) + '...';
  }
  if (cfg.workerName) {
    document.getElementById('worker-name').value = cfg.workerName;
  }

  await fetchStats();
}

async function fetchStats() {
  const dot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  try {
    const r = await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    if (data.ok) { dot.className = 'status-dot dot-on'; statusText.textContent = 'Connected'; }
  } catch(e) {
    dot.className = 'status-dot dot-off'; statusText.textContent = 'Backend offline';
    return;
  }

  try {
    const r = await fetch(`${backendUrl}/api/admin/state`, {
      headers: { 'x-admin-secret': 'chatshouse_admin_2024' },
      signal: AbortSignal.timeout(5000)
    });
    const data = await r.json();
    if (data) {
      // Get current worker ID from storage
      const wi = (await chrome.storage.local.get(['workerInfo'])).workerInfo;
      const workerId = wi ? wi.workerId : null;

      // Count dialogs and profiles for this worker
      const dialogs = (data.dialogs || []).filter(d => !workerId || d.worker_id === workerId);
      const profiles = (data.profiles || []).filter(p => !workerId || p.worker_id === workerId);
      const online = dialogs.filter(d => d.contact_is_online).length;
      const now = new Date();
      const urgent = dialogs.filter(d => {
        if (!d.last_message_incoming || !d.last_message_at) return false;
        const mins = (now - new Date(d.last_message_at)) / 60000;
        return d.contact_is_online ? mins > 5 : mins > 30;
      }).length;

      document.getElementById('s-profiles').textContent = profiles.length;
      document.getElementById('s-dialogs').textContent = dialogs.length;
      document.getElementById('s-online').textContent = online;
      document.getElementById('s-urgent').textContent = urgent;

      // Alerts for this worker
      const alerts = (data.alerts || []).filter(a => !workerId || a.worker_id === workerId).slice(0, 4);
      const alertsEl = document.getElementById('alerts-list');
      if (alerts.length) {
        alertsEl.innerHTML = alerts.map(a => `
          <div class="alert-item ${a.severity || 'medium'}">
            <div>${a.message}</div>
            <div style="color:#8892a4;font-size:10px;margin-top:2px">[${a.profile_name||'?'}] ${a.contact_name||''} · ${timeAgo(a.created_at)}</div>
          </div>`).join('');
      } else {
        alertsEl.innerHTML = '<div class="empty">✅ No active alerts</div>';
      }
    }
  } catch(e) {}
}

function timeAgo(str) {
  if (!str) return '';
  const m = Math.round((new Date() - new Date(str)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  return Math.round(m/60) + 'h ago';
}

function saveConfig() {
  backendUrl = document.getElementById('backend-url').value.trim() || 'http://localhost:4000';
  const workerName = document.getElementById('worker-name').value.trim() || 'Worker';
  chrome.storage.local.set({ backendUrl, workerName });
  document.getElementById('config-status').textContent = 'Saved!';
  setTimeout(() => { document.getElementById('config-status').textContent = ''; fetchStats(); }, 1000);
}

function openPanel() {
  chrome.tabs.create({ url: `${backendUrl}/panel` });
}

init();
