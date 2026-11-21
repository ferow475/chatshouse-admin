// Background Service Worker — Chatshouse Admin Monitor
// 1 worker (сотрудник) → many profiles (девушки) → many dialogs

const BACKEND_URL = 'https://chatshouse-admin-production.up.railway.app';
let wsConn = null;
let workerInfo = null; // { workerId, workerName }

// ─── WebSocket ─────────────────────────────────────────────
function connectWS() {
  if (wsConn && wsConn.readyState === WebSocket.OPEN) return;
  try {
    wsConn = new WebSocket(BACKEND_URL.replace('http', 'ws'));
    wsConn.onopen = () => {
      if (workerInfo) wsConn.send(JSON.stringify({ type: 'auth_worker', workerId: workerInfo.workerId }));
    };
    wsConn.onmessage = (e) => {
      try { handleBackendMsg(JSON.parse(e.data)); } catch(err) {}
    };
    wsConn.onclose = () => setTimeout(connectWS, 5000);
    wsConn.onerror = () => {};
  } catch(e) {}
}

function handleBackendMsg(msg) {
  if (msg.type === 'notification') {
    showNotification(msg.message, msg.severity, msg.profileName);
    // Forward to content script
    chrome.tabs.query({ url: 'https://chatshouse.com/*' }, (tabs) => {
      tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { type: 'notification', ...msg }).catch(() => {}));
    });
  } else if (msg.type === 'ai_tips') {
    // Forward AI tips to content script
    chrome.tabs.query({ url: 'https://chatshouse.com/*' }, (tabs) => {
      tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { type: 'ai_tips', ...msg }).catch(() => {}));
    });
  }
}

function showNotification(message, severity, profileName) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: severity === 'high' ? '⚠️ URGENT!' : (profileName ? `💬 ${profileName}` : '📢 Reminder'),
    message: message,
    priority: severity === 'high' ? 2 : 1,
    requireInteraction: severity === 'high'
  });
}

// ─── Message handlers ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'set_worker') {
    workerInfo = { workerId: msg.workerId, workerName: msg.workerName || 'Worker' };
    chrome.storage.local.set({ workerInfo });
    connectWS();
    sendResponse({ ok: true });
  }

  else if (msg.type === 'sync_all_profiles') {
    // Main sync: worker + all profiles with their dialogs
    fetch(`${BACKEND_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId: msg.workerId,
        workerName: msg.workerName,
        profiles: msg.profiles,
        mails: msg.mails || []
      })
    }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  else if (msg.type === 'send_messages') {
    if (!workerInfo) { sendResponse({ ok: false }); return true; }
    fetch(`${BACKEND_URL}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId: workerInfo.workerId,
        profileUlid: msg.profileUlid,
        contactUlid: msg.contactUlid,
        messages: msg.messages
      })
    }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  else if (msg.type === 'log_event') {
    if (!workerInfo) return;
    fetch(`${BACKEND_URL}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId: workerInfo.workerId,
        profileUlid: msg.profileUlid || '',
        type: msg.eventType,
        payload: msg.payload
      })
    }).catch(() => {});
  }

  else if (msg.type === 'get_worker') {
    sendResponse({ worker: workerInfo });
  }

  return true;
});

// ─── Init ──────────────────────────────────────────────────
chrome.storage.local.get(['workerInfo'], (result) => {
  if (result.workerInfo) {
    workerInfo = result.workerInfo;
    connectWS();
  }
});

// Mark worker offline on browser close
chrome.runtime.onSuspend.addListener(() => {
  if (workerInfo) {
    fetch(`${BACKEND_URL}/api/offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: workerInfo.workerId })
    }).catch(() => {});
  }
});

// Periodic sync trigger
chrome.alarms.create('sync', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') {
    chrome.tabs.query({ url: 'https://chatshouse.com/*', active: true }, (tabs) => {
      if (tabs.length > 0) chrome.tabs.sendMessage(tabs[0].id, { type: 'trigger_sync' }).catch(() => {});
    });
    if (!wsConn || wsConn.readyState !== WebSocket.OPEN) connectWS();
  }
});
