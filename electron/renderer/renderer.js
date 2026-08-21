const state = { folder: '', files: new Map(), importing: false };
const dropzone = document.getElementById('dropzone');
const choose = document.getElementById('choose');
const start = document.getElementById('start');
const pause = document.getElementById('pause');
const cancel = document.getElementById('cancel');
const retry = document.getElementById('retry');
const folderLabel = document.getElementById('folder');
const playlistName = document.getElementById('playlistName');
const playlistDescription = document.getElementById('playlistDescription');
const clientId = document.getElementById('clientId');
const log = document.getElementById('log');
const summary = document.getElementById('summary');
const counts = document.getElementById('counts');
const progress = document.getElementById('progress');
const message = document.getElementById('message');

const statusClass = (status) => status.replaceAll(' ', '-');
const esc = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

function setFolder(folder) {
  state.folder = folder || '';
  if (!folder) return;
  const name = folder.split(/[\\/]/).filter(Boolean).pop();
  folderLabel.textContent = folder;
  if (!playlistName.value) playlistName.value = name;
  start.disabled = !clientId.value.trim() || state.importing;
  message.textContent = `${name} selected`;
}

function render() {
  const files = [...state.files.values()];
  const imported = files.filter((file) => file.status === 'imported').length;
  const matched = files.filter((file) => file.status === 'matched').length;
  const failed = files.filter((file) => file.status === 'failed').length;
  const pending = files.length - imported - matched - failed;
  summary.textContent = files.length ? `${imported} of ${files.length} imported` : 'Waiting for a folder';
  counts.innerHTML = `<span class="count imported">${imported} imported</span><span class="count matched">${matched} matched</span><span class="count failed">${failed} failed</span><span class="count pending">${pending} waiting</span>`;
  progress.style.width = `${files.length ? ((imported + failed) / files.length) * 100 : 0}%`;
  retry.disabled = state.importing || failed === 0;
  log.innerHTML = files.length ? files.map((file) => `<div class="file-row"><span class="file-dot ${statusClass(file.status)}"></span><span class="file-name" title="${esc(file.path)}">${esc(file.name)}</span><span class="file-detail">${esc(file.detail || '')}</span><span class="badge ${statusClass(file.status)}">${esc(file.status)}</span></div>`).join('') : '<p class="empty">Your tracks will appear here as they move through the importer.</p>';
}

function receive(event) {
  if (event.type === 'files') {
    state.files = new Map((event.files || []).map((file) => [file.path, file]));
    render();
  } else if (event.type === 'status' && event.file) {
    state.files.set(event.file.path, event.file);
    render();
  } else if (event.type === 'message') {
    message.textContent = event.message || 'Working';
  } else if (event.type === 'complete') {
    state.importing = false;
    start.disabled = false;
    pause.disabled = true;
    cancel.disabled = true;
    message.textContent = event.message || 'Import complete';
    render();
  } else if (event.type === 'cancelled') {
    state.importing = false;
    start.disabled = false;
    pause.disabled = true;
    cancel.disabled = true;
    pause.textContent = 'Pause';
    message.textContent = event.message || 'Import cancelled';
    render();
  } else if (event.type === 'error') {
    state.importing = false;
    start.disabled = false;
    pause.disabled = true;
    cancel.disabled = true;
    render();
    message.textContent = event.message || 'Import failed';
  } else if (event.type === 'paused' || event.type === 'resumed') {
    pause.textContent = event.type === 'paused' ? 'Resume' : 'Pause';
    message.textContent = event.message || 'Working';
  }
}

choose.addEventListener('click', async () => setFolder(await window.spotifyImporter.chooseFolder()));
clientId.addEventListener('input', () => { start.disabled = !state.folder || !clientId.value.trim() || state.importing; });
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', async (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  const file = event.dataTransfer.files[0];
  if (file) setFolder(window.spotifyImporter.getDroppedPath(file));
});
async function beginImport() {
  state.importing = true;
  state.files.clear();
  start.disabled = true;
  pause.disabled = false;
  cancel.disabled = false;
  pause.textContent = 'Pause';
  message.textContent = 'Preparing import...';
  render();
  await window.spotifyImporter.startImport({ folder: state.folder, clientId: clientId.value, playlistName: playlistName.value || state.folder.split(/[\\/]/).filter(Boolean).pop(), playlistDescription: playlistDescription.value });
}
start.addEventListener('click', beginImport);
retry.addEventListener('click', beginImport);
pause.addEventListener('click', () => window.spotifyImporter.pauseImport());
cancel.addEventListener('click', () => window.spotifyImporter.cancelImport());
window.spotifyImporter.onEvent(receive);
window.spotifyImporter.getDefaultClientId().then((defaultClientId) => {
  if (defaultClientId) {
    clientId.value = defaultClientId;
    start.disabled = !state.folder;
  }
});
