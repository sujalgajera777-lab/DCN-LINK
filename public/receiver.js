// Same receiver inbox on BOTH PCs; only actual ESP-NOW receipts saved on the HUB appear.
const incomingList = document.getElementById('incomingList');
const receiverAddress = document.getElementById('receiverAddress');
const serverStatus = document.getElementById('serverStatus');
const viewCode = document.getElementById('viewCode');
const inboxFeedback = document.getElementById('inboxFeedback');
const refreshInbox = document.getElementById('refreshInbox');
let loading = false;

receiverAddress.textContent = 'ESP-NOW · shared inbox · central PostgreSQL';

function showEmpty(message) {
  incomingList.replaceChildren();
  const p = document.createElement('p');
  p.className = 'empty-message';
  p.textContent = message;
  incomingList.append(p);
}

function makeText(tag, value, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = String(value);
  return el;
}

async function checkServer() {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    if (!response.ok) throw new Error('Offline');
    const health = await response.json();
    const hw = await fetch('/api/hardware/status', {cache: 'no-store'}).then(r => r.json());
    const board = hw.radio_ready ? 'ESP32 ready' : 'ESP32 not ready';
    const hub = hw.central_database_online ? 'Central DB online' : 'Central DB offline';
    serverStatus.textContent = `${hw.node_id} · ${board} · ${hub}`;
  } catch {
    serverStatus.textContent = 'Backend disconnected';
  }
}

async function loadInbox() {
  const code = viewCode.value;
  if (!code) {
    inboxFeedback.textContent = 'Enter the inbox access code to view received messages.';
    return;
  }
  if (loading) return;
  loading = true;
  try {
    const response = await fetch('/api/hardware/inbox', {
      headers: { 'x-view-code': code },
      cache: 'no-store'
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || `Failed (${response.status})`);
    }
    incomingList.replaceChildren();
    const messages = result.messages || [];
    if (!messages.length) {
      showEmpty('No wireless messages recorded from either ESP32 yet.');
    }
    for (const msg of messages) {
      const item = document.createElement('article');
      item.className = 'incoming-item';
      item.append(makeText('h4', `${msg.sender_id} → ${msg.receiver_id}`));
      item.append(makeText('p', msg.message));
      const time = new Date(msg.received_at).toLocaleString();
      item.append(makeText('p', `Received: ${time} · Message ID: ${msg.id}`));
      const deliveryMs = msg.metadata?.end_to_end_ms;
      const timing = typeof deliveryMs === 'number' ? ` · End-to-end: ${deliveryMs} ms` : '';
      const rssi = msg.metadata?.receiver_rssi_dbm;
      const signal = typeof rssi === 'number' ? ` · Receiver RSSI: ${rssi} dBm` : '';
      item.append(makeText('p', `Transport: ${msg.transport} · ${msg.payload_bytes} bytes${timing}${signal}`));
      incomingList.append(item);
    }
    inboxFeedback.textContent = `Showing ${messages.length} wireless hardware-received message(s).`;
  } catch (error) {
    inboxFeedback.textContent = error.message;
    showEmpty('Unable to load your inbox. Check the access code and server.');
  } finally {
    loading = false;
  }
}
refreshInbox.addEventListener('click', loadInbox);
viewCode.addEventListener('keydown', event => {
  if (event.key === 'Enter') loadInbox();
});
checkServer();
setInterval(() => { checkServer(); if (viewCode.value) loadInbox(); }, 3000);
