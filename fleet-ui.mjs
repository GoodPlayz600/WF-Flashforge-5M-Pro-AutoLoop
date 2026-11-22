import { defaultModel, models } from '/models.mjs';

const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="wf-token"]').content;
const assign = $('fleet-assign');
const profile = $('fleet-profile');
let state;
let activeRequest = 0;
let profileKey;
let printersKey;
let targetsKey;
let pairingId;
let assigning = false;

function status(message, warning = false) {
  const banner = $('fleet-message');
  banner.classList.toggle('warning', warning);
  banner.hidden = !message;
  banner.textContent = message;
}

async function post(path, body) {
  activeRequest++;
  try {
    const response = await fetch('/fleet/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WF-Token': token },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    return result;
  } finally {
    activeRequest--;
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, disabled = false) {
  const control = element('button', text, 'secondary compact');
  control.type = 'button';
  control.disabled = disabled;
  control.onclick = action;
  return control;
}

async function start(id) {
  if (!state.simulation && !window.confirm('Confirm that each printer being started has an empty plate, is ready, and has a tested clearing setup for the assigned prints.')) return;
  try {
    const response = await post('start', { id, ack: true, clearingValidated: true });
    render(response);
    const { started, skipped } = response.result;
    status([started.length && `Started ${started.join(', ')}.`, ...skipped].filter(Boolean).join(' '), !!skipped.length);
  } catch (error) { status(error.message, true); }
}

const pairForm = $('fleet-pair-form');
for (const model of Object.values(models)) {
  pairForm.elements.model.add(new Option(model.name + (model.transport === 'monitor' ? ' (monitoring)' : ''), model.id));
}
function showPairingFields() {
  const tcpOnly = models[pairForm.elements.model.value]?.transport === 'monitor';
  for (const label of pairForm.querySelectorAll('[data-lan-auth]')) {
    label.hidden = tcpOnly;
    label.querySelector('input').required = !tcpOnly && !state?.simulation;
  }
}
pairForm.elements.model.onchange = showPairingFields;

function pair(printer) {
  const form = $('fleet-pair-form');
  form.reset();
  pairingId = printer?.id;
  $('fleet-pair-title').textContent = pairingId ? `Reconnect ${printer.name}` : 'Add printer';
  $('fleet-name').hidden = Boolean(pairingId);
  form.elements.name.required = !pairingId;
  form.elements.ip.required = !state?.simulation;
  form.elements.model.value = printer?.modelId ?? defaultModel;
  showPairingFields();
  $('fleet-pair-error').textContent = '';
  $('fleet-pair').showModal();
}

function renderCard(printer) {
  const card = element('article', '', 'card fleet-printer');
  const header = element('div', '', 'cardhead');
  const title = element('div');
  title.append(element('h3', printer.name), element('p', printer.connected
    ? [printer.details?.name, printer.ip, printer.details?.nozzle && `${printer.details.nozzle} nozzle`].filter(Boolean).join(' · ')
    : 'Disconnected'));
  const badge = element('span', printer.connected ? printer.details?.state || 'Connected' : 'Offline', 'pill');
  badge.dataset.tone = printer.readyToStart ? 'good' : printer.connected ? 'warn' : 'idle';
  header.append(title, badge);
  const phase = element('p', printer.problem || printer.connectionIssue || (printer.connected && !printer.canPrint ? 'Monitoring only' : printer.phase), 'fleet-phase');
  const jobs = printer.jobs.filter(job => job.queueId === 'default');
  const estimateSeconds = printer.lists.find(queue => queue.id === 'default')?.estimate.seconds;
  const summary = estimateSeconds ? ` · about ${Math.ceil(estimateSeconds / 60)} min left` : '';
  const list = element('ul', '', 'fleet-queue');
  for (const job of jobs) {
    const line = element('li');
    line.append(element('strong', job.filename), element('span', `${job.completed}/${job.copies} · ${job.state}`));
    list.append(line);
  }
  const actions = element('div', '', 'actions');
  const link = element('a', 'Open dashboard', 'button-link');
  link.href = `/printers/${printer.id}/`;
  actions.append(link);
  if (printer.connected) {
    actions.append(button('Start queue', () => void start(printer.id),
      !printer.readyToStart || !jobs.some(job => job.state === 'Queued')));
    actions.append(button('Disconnect', async () => {
      try { render(await post('disconnect', { id: printer.id })); }
      catch (error) { status(error.message, true); }
    }, printer.busy));
  } else {
    actions.append(button('Reconnect', () => pair(printer)));
  }
  card.append(header, phase, element('p', `${jobs.length} assigned ${jobs.length === 1 ? 'job' : 'jobs'}${summary}`, 'fleet-count'), list, actions);
  return card;
}

function updateAssignment() {
  const split = assign.elements.mode.value === 'split';
  $('assign-target').hidden = split;
  assign.elements.printerId.required = !split;
  $('assign-submit').disabled = assigning || !assign.elements.printerId.options.length || (split && !state.printers.some(printer => printer.readyToStart));
}

function render(next) {
  state = next;
  $('fleet-simulator').hidden = !next.simulation;
  $('fleet-empty').hidden = next.printers.length > 0;
  const connected = next.printers.filter(printer => printer.connected).length;
  $('fleet-status').textContent = `${connected}/${next.printers.length} connected`;
  $('start-fleet').disabled = !next.printers.some(printer => printer.readyToStart &&
    printer.jobs.some(job => job.queueId === 'default' && job.state === 'Queued'));

  const assignable = next.printers.filter(printer => !printer.connected || printer.canPrint);
  const nextTargetsKey = JSON.stringify(assignable.map(({ id, name }) => [id, name]));
  if (nextTargetsKey !== targetsKey) {
    targetsKey = nextTargetsKey;
    const current = assign.elements.printerId.value;
    assign.elements.printerId.replaceChildren(...assignable.map(printer => new Option(printer.name, printer.id)));
    if (assignable.some(printer => printer.id === current)) assign.elements.printerId.value = current;
  }
  updateAssignment();
  const nextProfileKey = JSON.stringify(next.profile);
  if (profileKey !== nextProfileKey) {
    profileKey = nextProfileKey;
    const { settings, clearingHeight, clearingPreset, customClearing } = next.profile;
    for (const key of ['autoLevel', 'manualClearing', 'skipCooldown', 'autoConfirmClear', 'keepWarm']) profile.elements[key].checked = settings[key];
    for (const key of ['bed', 'nozzle', 'minutes']) profile.elements[key].value = settings[key];
    profile.elements.preset.querySelector('[value="custom"]').hidden = !customClearing;
    profile.elements.preset.value = clearingPreset;
    profile.elements.height.value = clearingHeight ?? '';
    $('fleet-standby').hidden = !settings.keepWarm;
  }
  profile.elements.height.disabled = profile.elements.preset.value === 'custom';
  $('fleet-save').disabled = next.printers.some(printer => printer.busy);

  const nextPrintersKey = JSON.stringify(next.printers.map(printer => [
    printer.id, printer.connected, printer.busy, printer.readyToStart, printer.phase, printer.problem, printer.connectionIssue,
    printer.jobs, printer.details?.state, printer.details?.name, printer.details?.nozzle, printer.ip,
    Math.ceil((printer.lists[0]?.estimate.seconds || 0) / 60),
  ]));
  if (nextPrintersKey !== printersKey) {
    printersKey = nextPrintersKey;
    $('fleet-printers').replaceChildren(...next.printers.map(renderCard));
  }
}

assign.elements.mode.onchange = updateAssignment;
assign.onsubmit = async event => {
  event.preventDefault();
  if (assigning) return;
  const form = new FormData(assign);
  const file = form.get('file');
  if (file.size > 48 * 1024 * 1024) return status('Use a G-code file under 48 MiB.', true);
  assigning = true;
  updateAssignment();
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(Error('Could not read the G-code file.'));
      reader.readAsDataURL(file);
    });
    const response = await post('add', { filename: file.name, data, copies: Number(form.get('copies')),
      split: form.get('mode') === 'split', printerId: form.get('printerId') });
    render(response);
    assign.elements.file.value = '';
    status(response.result.allocations.map(entry => `${entry.name}: ${entry.copies} ${entry.copies === 1 ? 'copy' : 'copies'}`).join(' · '));
  } catch (error) { status(error.message, true); }
  finally { assigning = false; updateAssignment(); }
};

for (let height = 0; height <= 200; height += 5) $('fleet-height').add(new Option(`${height || 0.2} mm`, String(height)));
profile.elements.keepWarm.onchange = () => { $('fleet-standby').hidden = !profile.elements.keepWarm.checked; };
profile.elements.preset.onchange = () => { profile.elements.height.disabled = profile.elements.preset.value === 'custom'; };
profile.onsubmit = async event => {
  event.preventDefault();
  const values = new FormData(profile);
  try {
    const response = await post('settings', {
      autoLevel: values.has('autoLevel'), manualClearing: values.has('manualClearing'),
      skipCooldown: values.has('skipCooldown'), autoConfirmClear: values.has('autoConfirmClear'),
      keepWarm: values.has('keepWarm'), bed: Number(values.get('bed')), nozzle: Number(values.get('nozzle')),
      minutes: Number(values.get('minutes')), preset: values.get('preset'),
      height: values.get('height') ? Number(values.get('height')) : null,
    });
    render(response);
    status('Shared settings saved.');
  } catch (error) { status(error.message, true); }
};

$('add-printer').onclick = () => pair();
$('start-fleet').onclick = () => void start();
$('fleet-pair-close').onclick = () => $('fleet-pair').close();
$('fleet-pair-form').onsubmit = async event => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.target));
  try {
    render(await post('connect', { ...payload, id: pairingId }));
    event.target.elements.code.value = '';
    $('fleet-pair').close();
    status('Printer connected.');
  } catch (error) { $('fleet-pair-error').textContent = error.message; }
};

async function refresh() {
  if (activeRequest) return;
  try {
    const response = await fetch('/fleet/state', { cache: 'no-store' });
    if (!response.ok) throw Error('Could not reach the local AutoLoop server.');
    const next = await response.json();
    if (!activeRequest) render(next);
  } catch (error) { status(error.message, true); }
}
await refresh();
setInterval(refresh, 1800);
