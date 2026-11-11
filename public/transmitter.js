// DCN·LINK text-only hardware sender, adapted to the existing HTML/CSS.
// Important: sends to the SAME origin. Never put PostgreSQL/API secrets here.
const tabs = document.querySelectorAll('.data-tab');
const uploadArea = document.getElementById('uploadArea');
const selectedFiles = document.getElementById('selectedFiles');
const textTransfer = document.getElementById('textTransfer');
const textMessage = document.getElementById('textMessage');
const characterCount = document.getElementById('characterCount');
const senderId = document.getElementById('senderId');
const sendCode = document.getElementById('sendCode');
const sendButton = document.getElementById('sendButton');
const transferStatus = document.getElementById('transferStatus');
const statusMessage = document.getElementById('statusMessage');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const progressPercentage = document.getElementById('progressPercentage');
let activeType = 'text';
let busy = false;

function showStatus(message, type = '') {
  statusMessage.textContent = message;
  transferStatus.className = 'transfer-status';
  if (type) transferStatus.classList.add(type);
}
function updateCount() {
  const bytes = new TextEncoder().encode(textMessage.value).length;
  characterCount.textContent = `${textMessage.value.length} chars · ${bytes}/160 UTF-8 bytes`;
}
function selectType(type) {
  activeType = type;
  tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.type === type));
  const isText = type === 'text';
  textTransfer.style.display = isText ? 'block' : 'none';
  uploadArea.style.display = isText ? 'none' : 'flex';
  selectedFiles.style.display = 'none';
  if (!isText) {
    showStatus(`${type[0].toUpperCase() + type.slice(1)} transfer is coming soon. Text works now.`);
  } else {
    showStatus('Ready to send text wirelessly from this PC to the other ESP32.');
  }
}

tabs.forEach(tab => tab.addEventListener('click', () => selectType(tab.dataset.type)));
textMessage.addEventListener('input', updateCount);

// Homepage transfers text to this screen without putting message text in a URL.
try {
  const draft = sessionStorage.getItem('dcn-link-draft');
  if (draft) {
    textMessage.value = draft;
    sessionStorage.removeItem('dcn-link-draft');
  }
} catch {}
selectType('text');
updateCount();
progressContainer.style.display = 'block';
progressBar.style.width = '0%';
progressPercentage.textContent = '0%';

sendButton.addEventListener('click', async () => {
  if (busy) return;
  if (activeType !== 'text') {
    showStatus('Only text messaging is enabled in this phase.', 'error');
    return;
  }
  const message = textMessage.value.trim();
  const name = senderId.value.trim();
  const code = sendCode.value;
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
    showStatus('Sender name must use 1–32 letters, digits, underscores or hyphens.', 'error');
    return;
  }
  if (!message || new TextEncoder().encode(message).length > 160) {
    showStatus('Write a message of at most 160 UTF-8 bytes.', 'error');
    return;
  }
  if (!code) {
    showStatus('Enter your sender access code.', 'error');
    sendCode.focus();
    return;
  }

  busy = true;
  sendButton.disabled = true;
  sendButton.textContent = 'Sending wirelessly…';
  progressBar.style.width = '30%';
  progressPercentage.textContent = 'Awaiting receiver';
  showStatus('Sending over ESP-NOW; waiting for the other ESP32 to receive and for the central database to save…');

  try {
    const response = await fetch('/api/hardware/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-send-code': code
      },
      body: JSON.stringify({
        sender_id: name,
        message,
        client_sent_at: new Date().toISOString()
      })
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || `Request failed (${response.status})`);
    }
    progressBar.style.width = '100%';
    progressPercentage.textContent = '100%';
    const ms = result.data?.end_to_end_ms;
    const timing = Number.isFinite(ms) ? ` · end-to-end ${ms} ms` : '';
    showStatus(`ESP-NOW confirmed on ${result.data.receiver_id}; saved to central DB as #${result.data.id}${timing}.`, 'success');
    textMessage.value = '';
    updateCount();
  } catch (error) {
    progressBar.style.width = '0%';
    progressPercentage.textContent = 'Failed';
    showStatus(`Message not confirmed: ${error.message}`, 'error');
  } finally {
    busy = false;
    sendButton.disabled = false;
    sendButton.textContent = '↑ Send Text';
  }
});
