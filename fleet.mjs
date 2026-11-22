import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createQueue, parseJob } from './queue.mjs';
import { verifyModel } from './printer.mjs';
import { queueStorage } from './queue-storage.mjs';

const queueId = 'default';
const eligibleStates = new Set(['ready', 'idle', 'completed', 'building_completed', 'cancel', 'canceled', 'cancelled']);

function canStart(state, simulation) {
  return state.canPrint && state.connected && !state.connectionIssue && !state.busy &&
    eligibleStates.has(state.details?.state) && (simulation || Date.now() - Date.parse(state.checkedAt) < 18000);
}
const nozzleOf = state => Number(String(state.details?.nozzle ?? '').match(/[\d.]+/)?.[0]);

export function createFleet({ simulation, singleQueue, queueOptions, directory, makeDevice }) {
  const metadata = new URL('printers.json', directory);
  const temporary = new URL('printers.tmp', directory);
  const stored = simulation || !existsSync(metadata) ? [] : JSON.parse(readFileSync(metadata, 'utf8'));
  const storage = subdir => simulation ? {} : queueStorage(new URL(subdir, directory));
  const settings = createQueue({ ...queueOptions, ...storage('settings/') });
  const printers = new Map();
  const connections = new Map();
  const pending = new Map();

  function makeQueue(id) {
    return createQueue({
      ...queueOptions, ...storage(`${id}/`), sharedProfile: () => settings.profile(),
    });
  }
  for (const { id, name, modelId } of stored) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Invalid saved fleet printer ID.');
    printers.set(id, { id, name, modelId, queue: makeQueue(id) });
  }
  function savePrinters() {
    if (simulation) return;
    const records = [...printers.values()].map(({ id, name, modelId }) => ({ id, name, modelId }));
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, JSON.stringify(records), { mode: 0o600 });
    renameSync(temporary, metadata);
  }
  function printer(id) {
    const entry = printers.get(id);
    if (!entry) throw Error('Choose an existing fleet printer.');
    return entry;
  }
  const targets = () => [...printers.values()].map(entry => ({ ...entry, state: entry.queue.state() }));

  async function connect(id, body, newQueue) {
    const entry = !newQueue && id !== 'single' ? printer(id) : null;
    const target = newQueue ?? entry?.queue ?? singleQueue;
    if (pending.has(id)) throw Error('A connection for this printer is already being checked.');
    const serial = String(body.serial ?? '').trim().toUpperCase().replace(/^SN[ :_-]*/, '');
    const device = makeDevice(id, { ...body, model: body.model ?? entry?.modelId });
    const ip = device.ip;
    const conflicts = ([key, candidate]) => key !== id && (candidate.ip === ip || (serial && candidate.serial === serial));
    if ([...pending].some(conflicts)) throw Error('This printer is already being connected in another dashboard.');
    if (target.state().busy) throw Error('Stop the current queue before reconnecting this printer.');
    pending.set(id, { ip, serial });
    try {
      const paired = [...connections].find(conflicts);
      if (paired && id !== 'single' && paired[0] !== 'single') {
        throw Error('This printer already has a fleet entry. Reconnect it there.');
      }
      const detail = await device.detail();
      verifyModel(detail);
      if (target.state().busy) throw Error('Stop the current queue before reconnecting this printer.');
      if (paired) {
        if (pending.has(paired[0])) throw Error('Wait for the other dashboard’s connection check to finish.');
        const previous = paired[0] === 'single' ? singleQueue : printer(paired[0]).queue;
        if (previous.state().busy) throw Error('Stop the other dashboard’s queue before moving this printer.');
        previous.disconnect();
        connections.delete(paired[0]);
      }
      await target.connect(device, detail);
      connections.set(id, { ip, serial });
      const modelId = target.state().modelId;
      if (entry && entry.modelId !== modelId) { entry.modelId = modelId; savePrinters(); }
      return modelId;
    } finally {
      pending.delete(id);
    }
  }

  function configure(type, body) {
    if (targets().some(({ state }) => state.busy)) {
      throw Error('Shared settings can be changed when all fleet queues are idle.');
    }
    if (type === 'combined') {
      const draft = createQueue({ ...queueOptions, saved: { lists: [structuredClone(settings.profile())] } });
      draft.configureQueue(queueId, body);
      draft.selectClearing(queueId, body.preset);
      if (body.preset !== 'custom') draft.setClearingHeight(queueId, body.height);
      settings.replaceProfile(draft.profile());
    } else if (type === 'settings') settings.configureQueue(queueId, body);
    else if (type === 'preset') settings.selectClearing(queueId, body.preset);
    else if (type === 'height') settings.setClearingHeight(queueId, body.height);
    else if (type === 'file') settings.configureClearing(queueId, body.file);
  }

  function state() {
    return {
      simulation,
      profile: settings.state().lists[0],
      printers: targets().map(({ id, name, state: current }) => ({
        id, name, ...current, modelId: current.modelId ?? printers.get(id).modelId, readyToStart: canStart(current, simulation),
      })),
    };
  }

  async function action(path, body) {
    switch (path) {
      case '/fleet/connect': {
        if (body.id) return connect(body.id, body);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 50) throw Error('Enter a printer name from 1 to 50 characters.');
        const id = randomUUID();
        const queue = makeQueue(id);
        const modelId = await connect(id, body, queue);
        printers.set(id, { id, name, modelId, queue });
        try { savePrinters(); }
        catch (error) { printers.delete(id); connections.delete(id); throw error; }
        return { id };
      }
      case '/fleet/disconnect': {
        if (pending.has(body.id)) throw Error('Wait for the connection check to finish.');
        printer(body.id).queue.disconnect();
        connections.delete(body.id);
        return;
      }
      case '/fleet/settings': return configure('combined', body);
      case '/fleet/preset': return configure('preset', body);
      case '/fleet/height': return configure('height', body);
      case '/fleet/clearing-file': return configure('file', body);
      case '/fleet/add': {
        const job = parseJob(body);
        const split = body.split === true;
        const assigned = split ? null : printer(body.printerId);
        const eligible = split ? targets().filter(({ state }) => canStart(state, simulation) && state.modelId === job.modelId && nozzleOf(state) === job.nozzle)
          : [{ ...assigned, state: assigned.queue.state() }];
        if (!eligible.length) throw Error('No idle, connected printer matches this G-code’s model and nozzle size.');
        if (assigned && (assigned.modelId ?? eligible[0].state.modelId) && (assigned.modelId ?? eligible[0].state.modelId) !== job.modelId) {
          throw Error('This G-code’s model does not match the assigned printer.');
        }
        if (!split && eligible[0].state.connected && nozzleOf(eligible[0].state) !== job.nozzle) {
          throw Error('This G-code’s nozzle size does not match the assigned printer.');
        }
        const allocations = [];
        try {
          for (const [index, entry] of eligible.entries()) {
            const copies = Math.floor(job.copies / eligible.length) + (index < job.copies % eligible.length ? 1 : 0);
            if (copies === 0) continue;
            const jobId = entry.queue.addParsed({ ...job, copies }, queueId);
            allocations.push({ id: entry.id, name: entry.name, copies, jobId, queue: entry.queue });
          }
        } catch (error) {
          for (const entry of allocations.reverse()) {
            try { entry.queue.remove(entry.jobId); }
            catch { throw Error('Assignment was interrupted. Review each printer’s queue before retrying.'); }
          }
          throw error;
        }
        return { allocations: allocations.map(({ id, name, copies }) => ({ id, name, copies })) };
      }
      case '/fleet/start': {
        if (body.ack !== true) throw Error('Confirm the plates are empty before starting.');
        const selected = body.id ? targets().filter(({ id }) => id === body.id) : targets();
        if (body.id && !selected.length) throw Error('Choose an existing fleet printer.');
        const started = [];
        const skipped = [];
        for (const entry of selected) {
          if (!entry.state.jobs.some(job => job.queueId === queueId && job.state === 'Queued')) continue;
          try {
            if (!canStart(entry.state, simulation)) throw Error('Printer is offline or busy.');
            entry.queue.start(true, queueId, body.clearingValidated);
            started.push(entry.name);
          } catch (error) { skipped.push(`${entry.name}: ${error.message}`); }
        }
        if (!started.length && !skipped.length) throw Error('Add an assignment to a production queue first.');
        return { started, skipped };
      }
      default: throw Error('Fleet action not found.');
    }
  }

  return { action, configure, connect, state, queue: id => printer(id).queue, queues: () => [...printers.values()].map(entry => entry.queue) };
}
