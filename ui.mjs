import { defaultModel, models } from '/models.mjs';

const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="wf-token"]').content;
const scope = /^\/printers\/[a-f0-9-]{36}/.exec(location.pathname)?.[0] ?? '';
const selectionKey = scope ? `wf-active-queue:${scope}` : 'wf-active-queue';
if (scope) {
  $('single-view').removeAttribute('aria-current');
  $('fleet-profile-note').hidden = false;
}
let state = {};
let latestRequest = 0;
let updating = false;
let selected = localStorage.getItem(selectionKey) ?? 'default';
let tabKey;
let jobsKey;
let settingsKey;
let heightKey;
let editId;
let renaming = false;
let cameraConnection;
let cameraUrl;
let cameraIp;
let cameraStamp;

function status(message, target = $('message')) {
  target.textContent = message;
  if (target.id === 'message') target.hidden = !message;
}

function btn(label, action, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = 'secondary compact';
  button.disabled = disabled;
  button.onclick = action;
  return button;
}

function formatDuration(seconds) {
  if (seconds < 60) return seconds > 0 ? '< 1 min' : '0 min';
  const minutes = Math.ceil(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function displayedSweepHeight(value) {
  return `${Number(value) === 0 ? 0.2 : value} mm`;
}

function renderQueue(next) {
  if (!next.lists.some(item => item.id === selected)) selected = next.lists[0].id;
  const currentTabKey = JSON.stringify([next.lists.map(({ id, name }) => [id, name]), selected, next.activeQueue]);
  if (tabKey !== currentTabKey) {
    tabKey = currentTabKey;
    $('queue-tabs').replaceChildren(...next.lists.map(entry => {
      const tab = btn(entry.name, () => {
        selected = entry.id;
        localStorage.setItem(selectionKey, selected);
        render(state);
      });
      tab.setAttribute('aria-pressed', String(entry.id === selected));
      tab.dataset.active = String(entry.id === next.activeQueue);
      return tab;
    }));
  }
  const entry = next.lists.find(item => item.id === selected);
  const settings = entry.settings;
  const eta = $('queue-time-left');
  const { seconds, unknown } = entry.estimate;
  eta.hidden = !seconds && !unknown;
  eta.textContent = unknown
    ? (seconds ? `Queue time left · ${formatDuration(seconds)} estimated + jobs without a time estimate` : 'Queue time left · No estimates in these files')
    : `Queue time left · About ${formatDuration(seconds)}`;
  eta.title = 'Estimated print and clearing time. Excludes cooldown and time waiting for confirmation.';
  const height = entry.clearingHeight;
  const adjustable = entry.clearingPreset !== 'custom';
  const builtIn = entry.clearingPreset === 'slow' ? '0.2 mm' : '4 mm';
  $('clearing-filename').textContent = adjustable
    ? `${entry.clearingFilename} · Z ${height === null ? builtIn : displayedSweepHeight(height)}`
    : entry.clearingFilename;
  $('clearing-height-form').hidden = !adjustable;
  $('clearing-height-form').querySelectorAll('input, button').forEach(control => { control.disabled = next.busy; });
  $('reset-height').hidden = height === null;
  $('test-clearing-height').disabled = next.busy || !connectedNow(next);
  const currentHeightKey = JSON.stringify([selected, height, entry.clearingPreset]);
  if (currentHeightKey !== heightKey) {
    heightKey = currentHeightKey;
    $('sweep-height').value = height ?? 0;
    $('sweep-height-value').textContent = displayedSweepHeight(height ?? 0);
  }
  const preset = $('clearing-preset');
  preset.querySelector('[value="custom"]').hidden = !entry.customClearing;
  preset.value = entry.clearingPreset;
  $('clearing-file').querySelectorAll('input, button, select').forEach(control => { control.disabled = next.busy; });
  const coolingStep = settings.skipCooldown ? '' : ' → Cool';
  const confirmationStep = settings.autoConfirmClear || next.simulation ? 'OK → Next copy' : 'Confirm plate clear';
  $('clearing-mode').textContent = settings.manualClearing ? 'Manual plate removal for this queue.'
    : `Print${coolingStep} → OK → Clear → ${confirmationStep}`;
  const currentSettingsKey = JSON.stringify([selected, settings]);
  if (settings && currentSettingsKey !== settingsKey) {
    settingsKey = currentSettingsKey;
    const form = $('queue-settings').elements;
    form.autoLevel.checked = settings.autoLevel;
    form.manualClearing.checked = settings.manualClearing;
    form.skipCooldown.checked = settings.skipCooldown;
    form.autoConfirmClear.checked = settings.autoConfirmClear;
    form.keepWarm.checked = settings.keepWarm;
    form.bed.value = settings.bed;
    form.nozzle.value = settings.nozzle;
    form.minutes.value = settings.minutes;
    $('standby-options').hidden = !settings.keepWarm;
  }
  $('save-settings').disabled = next.busy;
  const jobs = next.jobs.filter(job => job.queueId === selected);
  const queued = jobs.filter(job => job.state === 'Queued');
  const remaining = queued.reduce((sum, job) => sum + job.copies - job.completed, 0);
  const finished = jobs.reduce((sum, job) => sum + job.completed, 0);
  $('queue-summary').textContent = jobs.length ? `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} · ${finished} completed · ${remaining} queued` : 'Add a sliced G-code file to get started.';
  $('start').disabled = !next.canPrint || !connectedNow(next) || next.busy || !queued.length;
  $('new-queue').disabled = next.busy;
  $('rename').disabled = next.busy;

  const currentJobsKey = JSON.stringify([selected, jobs, next.busy]);
  if (jobsKey === currentJobsKey) return;
  jobsKey = currentJobsKey;
  const rows = jobs.map(job => {
    const row = document.createElement('tr');
    for (const value of [job.filename, `${job.completed} / ${job.copies}`, job.state]) {
      row.insertCell().textContent = value;
    }
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (job.state === 'Queued') {
      const index = queued.indexOf(job);
      actions.append(
        btn('↑', () => void post('/move', { id: job.id, direction: -1 }), next.busy || index === 0),
        btn('↓', () => void post('/move', { id: job.id, direction: 1 }), next.busy || index === queued.length - 1),
        btn('Edit', () => editJob(job), next.busy),
      );
      actions.children[0].setAttribute('aria-label', 'Move job up');
      actions.children[1].setAttribute('aria-label', 'Move job down');
    }
    actions.append(btn('Remove', () => {
      if (ask(`Remove ${job.filename} from this queue?`)) void post('/remove', { id: job.id });
    }, next.busy));
    row.insertCell().append(actions);
    return row;
  });
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.className = 'empty-row';
    cell.textContent = 'No jobs in this queue.';
    rows.push(row);
  }
  $('jobs').replaceChildren(...rows);
}

function connectedNow(next) {
  return next.connected && !next.connectionIssue &&
    (next.simulation || Date.now() - Date.parse(next.checkedAt) < 18000);
}
const localTime = utc => new Date(utc).toLocaleTimeString();
function render(next) {
  state = next;
  const fresh = connectedNow(next);
  $('sim').hidden = !next.simulation;
  const badge = $('connection');
  badge.dataset.tone = fresh ? (next.simulation ? 'warn' : 'good') : next.connected ? 'warn' : 'idle';
  badge.lastElementChild.textContent = fresh ? (next.simulation ? 'Simulator' : 'Printer verified') : next.connected ? 'Response stale' : 'Disconnected';
  $('open-connect').textContent = next.connected ? 'Change printer' : 'Connect printer';
  $('open-connect').disabled = next.busy;
  $('verify').disabled = !next.connected;
  $('camera-refresh').disabled = !next.connected || next.simulation;
  $('proof').textContent = next.connectionIssue || (next.checkedAt
    ? `${next.simulation ? 'Simulator response' : 'Printer replied'} at ${localTime(next.checkedAt)}${next.details?.identitySource ? ` · ${next.details.identitySource}` : ''}`
    : 'Waiting for a response from the printer.');
  const d = next.details;
  $('dashboard-model').textContent = d?.model ?? 'Flashforge LAN printers';
  const capabilities = $('model-capabilities');
  capabilities.hidden = !next.connected || next.canClear;
  capabilities.textContent = next.canPrint ? 'This model uses manual plate clearing between prints.'
    : 'This connection supports monitoring. Start and stop prints from the printer or its slicer.';
  $('clearing-card').hidden = next.connected && !next.canClear;
  $('add').querySelector('button[type="submit"]').disabled = next.connected && !next.canPrint;
  $('print-time-left').textContent = fresh && Number.isFinite(next.activeSeconds) ? formatDuration(next.activeSeconds) : '—';
  for (const [name, value] of Object.entries({
    'machine-state': d?.state, 'nozzle-size': d?.nozzle ? `${String(d.nozzle).replace(/\s*mm$/i, '')} mm` : null,
    'bed-temp': Number.isFinite(d?.bed) ? `${Math.round(d.bed)} °C` : null,
    'nozzle-temp': Number.isFinite(d?.nozzleTemp) ? `${Math.round(d.nozzleTemp)} °C` : null,
    device: d?.name, model: d?.model, ip: next.simulation && next.connected ? 'Simulated LAN' : next.ip, firmware: d?.firmware,
  })) $(name).textContent = value ?? '—';
  for (const [id, target] of [['bed-target', d?.bedTarget], ['nozzle-target', d?.nozzleTarget]]) {
    $(id).textContent = Number.isFinite(target) ? target === 0 ? 'Heater off' : `Target ${target} °C` : '';
  }
  $('phase').textContent = next.cancelling ? 'Requesting printer cancellation…'
    : next.warmIssue || next.problem || (next.warmUntil
      ? `${next.phase} · until ${localTime(next.warmUntil)}`
      : next.phase);
  $('phase').dataset.alert = String(Boolean(next.warmIssue || next.problem || next.waiting));
  $('stop').hidden = !next.busy;
  $('stop').disabled = next.cancelling;
  $('cancel-print').hidden = !next.canCancel && !next.cancelling;
  $('cancel-print').disabled = next.cancelling;
  $('pause').hidden = !next.activeQueue;
  $('pause').textContent = next.pauseAfterCopy ? 'Cancel planned pause' : 'Pause after copy';
  $('clear').hidden = !next.waiting && !next.contactAwaitingConfirmation && !next.canAcknowledgeEnd;
  $('clear').textContent = next.contactAwaitingConfirmation ? 'Confirm successful ejection' : 'Confirm plate clear';
  renderQueue(next);

  if (next.ip !== cameraIp) {
    cameraIp = next.ip;
    stopCamera();
    clearFrame();
    showCameraEmpty(next.simulation ? 'Simulator camera' : next.connected ? 'Getting camera frame…' : 'Camera offline',
      next.simulation ? 'There is no physical camera in simulator mode.' : 'Enable Camera on the printer if no image appears.');
    if (next.connected && !next.simulation) void getCamera();
  }
}

function clearFrame() {
  $('camera-image').removeAttribute('src');
  $('camera-image').hidden = true;
  $('camera-empty').hidden = false;
  $('frame-time').hidden = true;
  if (cameraUrl) URL.revokeObjectURL(cameraUrl);
  cameraStamp = null;
  cameraUrl = null;
}
function showCameraEmpty(label, help) {
  $('camera-label').textContent = label;
  $('camera-help').textContent = help;
  $('camera-status').textContent = help;
}

function stopCamera() {
  cameraConnection?.abort();
  cameraConnection = null;
}

async function getCamera() {
  if (cameraConnection || document.hidden || !state.connected || state.simulation) return;
  const connection = new AbortController();
  cameraConnection = connection;
  try {
    const response = await fetch(scope + '/camera', {
      headers: { 'X-WF-Token': token }, cache: 'no-store', signal: connection.signal,
    });
    if (!response.ok) throw Error((await response.json()).error);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw Error('Camera stream disconnected. Reconnecting…');
      const lines = (pending + value).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const { jpeg, live, error } = JSON.parse(line);
        if (error) throw Error(error);
        const bytes = Uint8Array.from(atob(jpeg), char => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
        try {
          const test = new Image();
          test.src = url;
          await test.decode();
          if (connection.signal.aborted) return;
          if (cameraUrl) URL.revokeObjectURL(cameraUrl);
          cameraUrl = url;
          cameraStamp = Date.now();
          $('camera-image').src = url;
          $('camera-image').hidden = false;
          $('camera-empty').hidden = true;
          $('frame-time').hidden = false;
          $('frame-time').textContent = `Frame received ${localTime(cameraStamp)}`;
          $('camera-status').textContent = live ? 'Live camera over LAN' : 'Camera snapshots over LAN';
        } finally {
          if (url !== cameraUrl) URL.revokeObjectURL(url);
        }
      }
    }
  } catch (error) {
    if (!connection.signal.aborted) {
      $('camera-status').textContent = error.message;
      if (!cameraStamp || Date.now() - cameraStamp > 7000) {
        clearFrame();
        showCameraEmpty('Camera unavailable', error.message);
      } else $('frame-time').textContent = `Last frame ${localTime(cameraStamp)} · camera delayed`;
    }
  } finally {
    connection.abort();
    if (cameraConnection === connection) cameraConnection = null;
  }
}

async function getState() {
  if (updating) return;
  const id = ++latestRequest;
  try {
    const response = await fetch(scope + '/state');
    const data = await response.json();
    if (id === latestRequest) render(data);
  } catch {
    if (id === latestRequest) {
      status('Local server disconnected. Start AutoLoop and refresh this page.');
      if (state.jobs) render({ ...state, connectionIssue: 'Local server unreachable.' });
      stopCamera();
      clearFrame();
      showCameraEmpty('Camera offline', 'Local server disconnected.');
    }
  }
}

async function post(path, body = {}, target) {
  if (updating && !['/stop', '/cancel-print'].includes(path)) return false;
  const id = ++latestRequest;
  updating = true;
  status('');
  if (target) status('', target);
  try {
    const response = await fetch(scope + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WF-Token': token }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    if (id === latestRequest) {
      if (data.selectedQueue) { selected = data.selectedQueue; localStorage.setItem(selectionKey, selected); }
      render(data);
    }
    return true;
  } catch (error) { status(error.message, target); return false; }
  finally { if (id === latestRequest) updating = false; }
}

function ask(message) { return state.simulation || window.confirm(message); }
function readUpload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(Error('Could not read the G-code file.'));
    reader.readAsDataURL(file);
  });
}
function editJob(job) {
  editId = job.id;
  $('edit-filename').textContent = job.filename;
  $('edit-form').elements.copies.min = job.completed + 1;
  $('edit-form').elements.copies.value = job.copies;
  $('edit-dialog').showModal();
}
function nameQueue(rename) {
  renaming = rename;
  $('name-title').textContent = rename ? 'Rename queue' : 'New queue';
  $('name-form').elements.namedItem('name').value = rename ? state.lists.find(entry => entry.id === selected)?.name ?? '' : '';
  $('name-dialog').showModal();
}
for (const close of document.querySelectorAll('[data-close]')) close.onclick = () => $(close.dataset.close).close();
const connectForm = $('connect');
for (const model of Object.values(models)) {
  connectForm.elements.model.add(new Option(model.name + (model.transport === 'monitor' ? ' (monitoring)' : ''), model.id));
}
function showPairingFields() {
  const tcpOnly = models[connectForm.elements.model.value]?.transport === 'monitor';
  for (const label of connectForm.querySelectorAll('[data-lan-auth]')) {
    label.hidden = tcpOnly;
    label.querySelector('input').required = !tcpOnly && !state.simulation;
  }
}
connectForm.elements.model.onchange = showPairingFields;
$('open-connect').onclick = () => {
  connectForm.elements.model.value = state.modelId ?? defaultModel;
  showPairingFields();
  $('connect-dialog').showModal();
};
$('verify').onclick = () => void post('/refresh');
$('camera-refresh').onclick = () => {
  stopCamera();
  void getCamera();
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else void getCamera();
});
$('new-queue').onclick = () => nameQueue(false);
$('rename').onclick = () => nameQueue(true);
$('name-form').onsubmit = async event => {
  event.preventDefault();
  const name = new FormData(event.target).get('name');
  if (await post(renaming ? '/rename-queue' : '/create-queue', { id: selected, name })) $('name-dialog').close();
};
$('edit-form').onsubmit = async event => {
  event.preventDefault();
  const values = new FormData(event.target);
  if (await post('/edit', { id: editId, copies: Number(values.get('copies')) })) $('edit-dialog').close();
};
$('connect').onsubmit = async event => {
  event.preventDefault();
  const values = new FormData(event.target);
  if (await post('/connect', Object.fromEntries(values), $('connect-result'))) {
    event.target.elements.code.value = '';
    $('connect-dialog').close();
  }
};
$('add').onsubmit = async event => {
  event.preventDefault();
  const values = new FormData(event.target);
  const file = values.get('file');
  const queueId = selected;
  if (file.size > 48 * 1024 * 1024) return status('Use a G-code file under 48 MiB.');
  try {
    if (await post('/add', { queueId, filename: file.name, data: await readUpload(file), copies: Number(values.get('copies')) })) {
      event.target.elements.file.value = '';
    }
  } catch (error) { status(error.message); }
};
$('clearing-file').onsubmit = async event => {
  event.preventDefault();
  const file = event.target.elements.file.files[0];
  if (!file || file.size > 256 * 1024) return status('Choose a clearing G-code file under 256 KiB.');
  try {
    if (await post('/clearing-file', { id: selected, file: { filename: file.name, data: await readUpload(file) } })) {
      event.target.reset();
    }
  } catch (error) { status(error.message); }
};
$('clearing-preset').onchange = async event => {
  if (!await post('/clearing-preset', { id: selected, preset: event.target.value })) render(state);
};
$('sweep-height').oninput = event => {
  $('sweep-height-value').textContent = displayedSweepHeight(event.target.value);
};
$('clearing-height-form').onsubmit = async event => {
  event.preventDefault();
  await post('/clearing-height', { id: selected, height: Number($('sweep-height').value) });
};
$('reset-height').onclick = () => void post('/clearing-height', { id: selected, height: null });
$('test-clearing-height').onclick = () => {
  const entry = state.lists.find(item => item.id === selected);
  const height = Number($('sweep-height').value);
  const speed = entry.clearingPreset === 'slow' ? 'Slow clear' : 'Fast clear';
  const prompt = `Run ${speed} at Z${displayedSweepHeight(height)}? The test heats the printer and moves the toolhead. Confirm the plate and exit path are empty, then stay at the printer.`;
  if (ask(prompt)) void post('/test-clearing-height', { id: selected, height, ack: true });
};
$('start').onclick = () => {
  const entry = state.lists.find(item => item.id === selected);
  const base = 'Confirm the plate is empty, filament detection is on, and the printer is ready.';
  const prompt = !state.canClear || entry.settings.manualClearing ? base
    : ` ${base} Also confirm ${entry.clearingFilename} has been tested with these parts and the exit path is clear. Stay by the printer.`.trim();
  const hotClear = state.canClear && !entry.settings.manualClearing && entry.settings.skipCooldown
    ? ' Cooldown is off. Confirm the clearing file was tested immediately after a print.' : '';
  const automatic = state.canClear && !entry.settings.manualClearing && entry.settings.autoConfirmClear
    ? ' The next copy starts automatically when clearing completes. Verify this clearing setup before using auto-confirm.' : '';
  const height = state.canClear && !entry.settings.manualClearing && entry.clearingPreset !== 'custom' && entry.clearingHeight !== null
    ? ` The selected sweep height is ${displayedSweepHeight(entry.clearingHeight)}.` : '';
  if (ask(prompt + height + hotClear + automatic)) void post('/start', { ack: true, id: selected, clearingValidated: state.canClear && !entry.settings.manualClearing });
};
$('queue-settings').elements.keepWarm.onchange = event => {
  $('standby-options').hidden = !event.target.checked;
};
$('queue-settings').onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  await post('/queue-settings', { id: selected, autoLevel: form.has('autoLevel'), manualClearing: form.has('manualClearing'), skipCooldown: form.has('skipCooldown'), autoConfirmClear: form.has('autoConfirmClear'), keepWarm: form.has('keepWarm'),
    bed: Number(form.get('bed')), nozzle: Number(form.get('nozzle')), minutes: Number(form.get('minutes')) });
};
$('cancel-print').onclick = () => {
  if (ask('Cancel the active print on this printer and stop this queue?')) void post('/cancel-print');
};
$('stop').onclick = () => void post('/stop');
$('pause').onclick = () => void post('/pause-next');
$('clear').onclick = () => {
  if (ask('Confirm the entire build plate is empty, including the purge area.')) void post('/confirm', { ack: true });
};
await getState();
setInterval(getState, 1500);
setInterval(getCamera, 1300);
