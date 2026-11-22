import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { verifyPrinter, verifyCooled, verifyModel } from './printer.mjs';
import { injectRaisedSweep } from './inject.mjs';
import { validateClearingCommands } from './clearing.mjs';
import { estimateQueue, remainingSeconds, slicedSeconds } from './estimates.mjs';
import { raisedSweepPreset, sweepPlan } from './sweep.mjs';

export function parseJob({ filename, data, copies, sweep, raised }) {
  if (typeof filename !== 'string' || !/\.gcode$/i.test(filename) ||
      typeof data !== 'string' || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data) ||
      !Number.isSafeInteger(copies) || copies < 1) throw Error('Choose a sliced .gcode file and a positive whole copy count.');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > 48 * 1024 * 1024) throw Error('Use a G-code file under 48 MiB.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const model = /^;\s*printer_model\s*=\s*(.+)$/im.exec(text)?.[1].trim();
  const nozzle = Number(/^;\s*nozzle_diameter\s*=\s*([\d.]+)/im.exec(text)?.[1]);
  const height = Number(/^;\s*max_z_height\s*:\s*([\d.]+)/im.exec(text)?.[1]);
  if (!model || !/^Flashforge Adventurer 5M Pro$/i.test(model) || ![0.25, 0.4, 0.6, 0.8].includes(nozzle) ||
      /LOOPER AUTO-EJECT|SIMULATION ONLY|RAM EJECT/i.test(text)) {
    throw Error('Use original text G-code exported for the Flashforge Adventurer 5M Pro from Flash Studio or Orca.');
  }
  return { filename, bytes, nozzle, estimatedSeconds: slicedSeconds(text), height: Number.isFinite(height) && height > 0 ? height : null, copies, sweep: sweep === true, raised: raised === true };
}

const printActive = new Set(['heating', 'printing', 'pausing', 'paused']);
const printStopped = new Set(['ready', 'idle', 'cancel', 'canceled', 'cancelled', 'completed', 'building_completed']);
const endPrompt = new Set(['completed', 'building_completed', 'cancel', 'canceled', 'cancelled']);
const idle = new Set(['ready', 'idle']);
const cancellationPending = new Set(['canceling', 'cancelling', 'stopping']);
const idleForHeat = new Set(['ready', 'completed']);
const defaultSettings = { autoLevel: false, keepWarm: false, manualClearing: false, bed: 50, nozzle: 0, minutes: 5 };

export function createQueue({ motion, inspectMotion, diagnoseHoming, sleep = wait, saved = {}, persist = () => {}, defaultClearing, slowClearing, verifyPlateClear = async () => false }) {
  const lists = (saved.lists ?? [{ id: 'default', name: 'Production queue' }]).map(entry => {
    if (!defaultClearing || !entry.settings || Object.hasOwn(entry.settings, 'manualClearing')) return entry;
    return { ...entry, settings: { ...entry.settings, autoLevel: false, manualClearing: false } };
  });
  const jobs = (saved.jobs ?? []).map(job => ({
    ...job,
    bytes: job.bytes,
    estimatedSeconds: Object.hasOwn(job, 'estimatedSeconds') ? job.estimatedSeconds : slicedSeconds(job.bytes),
    state: ['Queued', 'Done'].includes(job.state) ? job.state : 'Interrupted — inspect printer before re-adding',
  }));
  let pauseAfterCopy = false;
  let activeQueue;
  let checkedAt = null;
  let connectionIssue = '';
  let inflight;
  const checkpoint = () => persist({ lists, jobs, parameters: plan.parameters, contactMeasured });
  const list = id => {
    const match = lists.find(entry => entry.id === (id ?? 'default'));
    if (!match) throw Error('Select an existing queue first.');
    return match;
  };
  const queueName = value => {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 50) throw Error('Use a queue name between 1 and 50 characters.');
    return name;
  };
  let printer;
  let details;
  let running;
  let pendingClear;
  let clearanceProof;
  let airProof;
  let contactProof;
  let plan = sweepPlan(saved.parameters ?? raisedSweepPreset);
  let contactMeasured = !!saved.parameters && saved.contactMeasured === true;
  let controller;
  let phase = 'Connect a printer';
  let problem = '';
  let activeJob;
  let motionReading;
  let jogBaseline;
  let ownedPrint;
  let uploading;
  let cancelling = false;
  let warmUntil = null;
  let warmIssue = '';
  const settingsFor = entry => ({ ...defaultSettings, ...entry.settings });
  const presets = { fast: defaultClearing, slow: slowClearing };
  function clearingSelection(entry) {
    if (Object.hasOwn(presets, entry.clearingPreset) && presets[entry.clearingPreset]) return entry.clearingPreset;
    return entry.clearing ? 'custom' : 'fast';
  }
  function clearingFor(entry) {
    const selection = clearingSelection(entry);
    if (selection !== 'custom') return presets[selection];
    const job = parseJob({ ...entry.clearing, copies: 1 });
    validateClearingCommands(job.bytes);
    return job;
  }
  const isFileClearing = Boolean(defaultClearing);
  const legacyClearingEstimates = new WeakMap();
  function clearingEstimate(entry) {
    const selection = clearingSelection(entry);
    if (selection !== 'custom') return presets[selection]?.estimatedSeconds ?? null;
    const file = entry.clearing;
    if (Object.hasOwn(file, 'estimatedSeconds')) return file.estimatedSeconds;
    if (!legacyClearingEstimates.has(file)) legacyClearingEstimates.set(file, slicedSeconds(Buffer.from(file.data, 'base64')));
    return legacyClearingEstimates.get(file);
  }


  function requireIdle() {
    if (running || cancelling) throw Error('Stop or finish the current operation first.');
  }
  function requirePrinter() {
    if (!printer) throw Error('Connect your printer first.');
  }
  function requireAck(value) {
    if (value !== true) throw Error('Confirm the setup on the printer first.');
  }

  async function readStatus() {
    requirePrinter();
    if (inflight) return inflight;
    const source = printer;
    inflight = source.detail().then(next => {
      if (source === printer) {
        details = next;
        checkedAt = new Date().toISOString();
        connectionIssue = '';
      }
      return next;
    }).catch(error => {
      if (source === printer) connectionIssue = error.message;
      throw error;
    }).finally(() => { inflight = null; });
    return inflight;
  }

  async function update() {
    const detail = await readStatus();
    verifyPrinter(detail);
    return detail;
  }

  function startTask(task) {
    jogBaseline = null;
    const signal = (controller = new AbortController()).signal;
    problem = '';
    warmIssue = '';
    running = Promise.resolve().then(() => task(signal)).catch(error => {
      problem = signal.aborted ? 'Stopped. Check the printer before restarting.' : error.message;
      phase = 'Stopped';
      if (activeJob) {
        activeJob.state = 'Stopped — inspect printer before re-adding';
        try { checkpoint(); } catch { problem += ' Queue could not be saved.'; }
      }
    }).finally(() => {
      if (pendingClear) pendingClear = null;
      running = null;
      controller = null;
      activeJob = null;
      ownedPrint = null;
      uploading = null;
      activeQueue = null;
      pauseAfterCopy = false;
    });
  }

  async function cooled(maxBed, signal) {
    const initial = await update();
    signal.throwIfAborted();
    if (initial.platTargetTemp !== 0 || initial.rightTargetTemp !== 0) await setAndCheckHeat(0, 0);
    const deadline = Date.now() + 45 * 60 * 1000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const d = await update();
      if (!['completed', 'ready'].includes(d.status)) throw Error('Printer is no longer idle after the print.');
      if (!Number.isFinite(d.platTemp) || !Number.isFinite(d.rightTemp) ||
          d.platTargetTemp !== 0 || d.rightTargetTemp !== 0) {
        throw Error('Both heater targets must be off after the job. Check the sliced end G-code and printer screen.');
      }
      if ((maxBed === null || d.platTemp <= maxBed) && d.rightTemp <= 50) {
        verifyCooled(d, maxBed);
        return;
      }
      await sleep(3000, undefined, { signal });
    }
    throw Error('The printer did not cool to the specified temperatures in time.');
  }

  async function waitForPrint(filename, signal, clearing = false) {
    const startDeadline = Date.now() + 120000;
    const endDeadline = Date.now() + 48 * 3600000;
    let started = false;
    while (Date.now() < endDeadline) {
      signal.throwIfAborted();
      const d = await update();
      const matches = d.printFileName === filename;
      const active = ['heating', 'printing'].includes(d.status);
      if (matches && active) {
        started = true;
        phase = clearing ? (d.status === 'heating' ? 'Heating for clearing job' : 'Running clearing G-code')
          : d.status === 'heating' ? 'Heating' : 'Printing';
      }
      if (active && !matches) throw Error('Printer is running a different file.');
      if (started && matches && d.status === 'completed' && d.printProgress >= 1 &&
          (clearing || (d.targetPrintLayer > 0 && d.printLayer >= d.targetPrintLayer))) return;
      if (started && (!matches || (!active && d.status !== 'completed'))) {
        throw Error('The active job disappeared or changed status without reporting a successful completion.');
      }
      if (!started && Date.now() > startDeadline) throw Error('Printer did not confirm the requested job started.');
      await sleep(2500, undefined, { signal });
    }
    throw Error('Timed out waiting for confirmed completion.');
  }

  async function acknowledgeEndPrompt(expectedFile, signal) {
    let detail = await readStatus();
    if (idle.has(detail.status)) return detail;
    if (!endPrompt.has(detail.status) ||
        (expectedFile && detail.printFileName && detail.printFileName !== expectedFile)) {
      throw Error('The printer state changed. Check the touchscreen before continuing.');
    }
    signal?.throwIfAborted();
    await printer.clearFinished();
    for (let check = 0; check < 6; check++) {
      detail = await readStatus();
      if (idle.has(detail.status)) return detail;
      if (!endPrompt.has(detail.status) ||
          (expectedFile && detail.printFileName && detail.printFileName !== expectedFile)) break;
      await sleep(500, undefined, { signal });
    }
    throw Error(`Printer still reports ${detail.status} after acknowledgement. Clear the prompt at the touchscreen before continuing.`);
  }

  async function startFile(bytes, filename, autoLevel, signal, clearing = false) {
    signal.throwIfAborted();
    ownedPrint = filename;
    uploading = printer.start(bytes, filename, autoLevel);
    try { await uploading; } finally { uploading = null; }
    await waitForPrint(filename, signal, clearing);
    ownedPrint = null;
  }

  function awaitClear(signal, keepWarm = false) {
    signal.throwIfAborted();
    phase = keepWarm ? 'Standby heat on. Check the plate, then confirm it is clear' : 'Check the plate, then confirm it is clear';
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      pendingClear = () => { signal.removeEventListener('abort', abort); pendingClear = null; resolve(); };
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  async function setAndCheckHeat(bed, nozzle) {
    const before = await readStatus();
    if (!idleForHeat.has(before.status)) throw Error('Printer is not idle. Check its heaters at the printer.');
    await printer.setHeat(bed, nozzle);
    for (let check = 0; check < 4; check++) {
      const detail = await readStatus();
      if (!idleForHeat.has(detail.status)) throw Error('Printer started another operation. Check its heaters.');
      if (detail.platTargetTemp === bed && detail.rightTargetTemp === nozzle) return;
      await sleep(500);
    }
    throw Error('Printer did not confirm both standby heater targets. Check the printer screen.');
  }

  async function warmWhileWaiting(settings, signal) {
    let timer;
    let off;
    const disableWarmth = () => off ??= setAndCheckHeat(0, 0).catch(error => {
      warmIssue = `Heater shutdown could not be verified. Turn the heaters off at the printer. ${error.message}`;
      throw Error(warmIssue);
    }).finally(() => { warmUntil = null; });
    try {
      await setAndCheckHeat(settings.bed, settings.nozzle);
      signal.throwIfAborted();
      warmUntil = Date.now() + settings.minutes * 60000;
      timer = setTimeout(() => {
        void disableWarmth().then(() => {
          if (pendingClear) phase = 'Standby timer ended. Confirm the plate is clear to continue.';
        }).catch(() => {
          if (pendingClear && controller) controller.abort();
        });
      }, settings.minutes * 60000);
      await awaitClear(signal, true);
    } finally {
      clearTimeout(timer);
      await disableWarmth();
    }
  }

  async function performSweep(currentPlan, signal, air = false, homeRetry = false) {
    phase = air ? 'Running raised clearance test' : 'Sweeping from back to front';
    await motion({
      ip: printer.ip, points: currentPlan.points, signal, homeRetry: air && homeRetry,
      onHome: () => { phase = 'Homing once, then retrying the raised test'; },
      onWait: mode => { if (mode === 'homing') phase = 'Waiting for the printer to finish homing'; },
      verify: async () => verifyCooled(await update(), currentPlan.parameters.cooled),
    });
  }

  return {
    state() {
      const ownedProgress = ownedPrint && details?.printFileName === ownedPrint && printActive.has(details.status)
        ? details : null;
      const runningJob = ownedPrint ? (activeJob?.state === 'Clearing' ? 'clearing' : 'print') : null;
      const selectedList = activeQueue ? list(activeQueue) : null;
      const activeEstimate = runningJob === 'clearing' && selectedList
        ? clearingEstimate(selectedList) : activeJob?.estimatedSeconds;
      const activeSeconds = !connectionIssue && details && printActive.has(details.status)
        ? remainingSeconds(details, ownedProgress ? activeEstimate : null) : null;
      return {
        lists: lists.map(entry => {
          const settings = settingsFor(entry);
          const current = entry.id === activeQueue;
          return {
            id: entry.id, name: entry.name, settings,
            clearingPreset: clearingSelection(entry),
            clearingFilename: clearingSelection(entry) === 'custom' ? entry.clearing?.filename : presets[clearingSelection(entry)]?.filename,
            customClearing: Boolean(entry.clearing),
            estimate: estimateQueue(jobs.filter(job => job.queueId === entry.id), {
              clearing: isFileClearing && !settings.manualClearing,
              clearingSeconds: clearingEstimate(entry),
              activeJob: current ? activeJob?.id : null,
              runningJob: current ? runningJob : null,
              progress: current && !connectionIssue ? ownedProgress : null,
            }),
          };
        }),
        activeSeconds,
        activeQueue, pauseAfterCopy, plan, motionReading, jogBaselineAvailable: Boolean(jogBaseline && jogBaseline.expires > Date.now()), checkedAt, connectionIssue, warmUntil, warmIssue, cancelling,
        canAcknowledgeEnd: !running && !cancelling && endPrompt.has(details?.status),
        canCancel: Boolean(printer && (ownedPrint || printActive.has(details?.status))),
        ip: printer?.ip ?? null,
        connected: Boolean(printer), busy: Boolean(running || cancelling), phase, problem, waiting: Boolean(pendingClear),
        contactMeasured, testedAir: airProof, testedContact: contactProof, contactAwaitingConfirmation: clearanceProof,
        details: details && {
          name: details.name, model: details.verifiedModel, identitySource: details.identitySource, firmware: details.firmwareVersion, nozzle: details.nozzleModel,
          bed: details.platTemp, bedTarget: details.platTargetTemp, nozzleTemp: details.rightTemp, nozzleTarget: details.rightTargetTemp, state: details.status, progress: details.printProgress,
        },
        jobs: jobs.map(({ id, queueId, filename, state, copies, completed, sweep, raised, height }) => ({ id, queueId, filename, state, copies, completed, sweep, raised, height })),
      };
    },
    async connect(next) {
      requireIdle();
      const d = await next.detail();
      requireIdle();
      verifyModel(d);
      printer = next;
      jogBaseline = null;
      motionReading = null;
      details = d;
      checkedAt = new Date().toISOString();
      connectionIssue = '';
      airProof = false;
      contactProof = false;
      clearanceProof = false;
      problem = '';
      phase = 'Connected';
    },
    async refresh(force = false) {
      if (!printer || (running && !pendingClear && !force)) return;
      await readStatus().catch(() => {});
    },
    cameraSource() {
      requirePrinter();
      return { ip: printer.ip, reported: details?.cameraStreamUrl };
    },
    createList(name) {
      requireIdle();
      const entry = { id: randomUUID(), name: queueName(name) };
      lists.push(entry);
      checkpoint();
      return entry.id;
    },
    renameList(id, name) {
      requireIdle();
      list(id).name = queueName(name);
      checkpoint();
    },
    configureQueue(id, configuration) {
      requireIdle();
      const { bed, nozzle, minutes } = configuration;
      if (!Number.isInteger(bed) || bed < 0 || bed > 75 ||
          !Number.isInteger(nozzle) || nozzle < 0 || nozzle > 170 ||
          !Number.isInteger(minutes) || minutes < 1 || minutes > 15) {
        throw Error('Use a bed target of 0–75 °C, a nozzle target of 0–170 °C, and a 1–15 minute standby timer.');
      }
      if (configuration.keepWarm === true && bed === 0 && nozzle === 0) throw Error('Set at least one standby temperature.');
      list(id).settings = { autoLevel: configuration.autoLevel === true, keepWarm: configuration.keepWarm === true, manualClearing: configuration.manualClearing === true, bed, nozzle, minutes };
      checkpoint();
    },
    configureClearing(id, file) {
      requireIdle();
      const entry = list(id);
      if (file) {
        const job = parseJob({ ...file, copies: 1 });
        validateClearingCommands(job.bytes);
        entry.clearing = { filename: job.filename, data: job.bytes.toString('base64'), estimatedSeconds: job.estimatedSeconds };
        entry.clearingPreset = 'custom';
      } else {
        delete entry.clearing;
        entry.clearingPreset = 'fast';
      }
      checkpoint();
    },
    selectClearing(id, preset) {
      requireIdle();
      const entry = list(id);
      if (!(preset === 'custom' ? entry.clearing : Object.hasOwn(presets, preset) && presets[preset])) {
        throw Error('Choose an available clearing file.');
      }
      entry.clearingPreset = preset;
      checkpoint();
    },
    add(source) {
      const job = parseJob(source);
      jobs.push({ ...job, queueId: list(source.queueId).id, id: randomUUID(), state: 'Queued', completed: 0 });
      checkpoint();
    },
    edit(id, copies, sweep, raised) {
      requireIdle();
      const job = jobs.find(item => item.id === id && item.state === 'Queued');
      if (!job || !Number.isSafeInteger(copies) || copies <= job.completed) {
        throw Error('Enter a whole copy count greater than the copies already finished.');
      }
      job.copies = copies;
      job.sweep = sweep === true;
      job.raised = raised === true;
      checkpoint();
    },
    move(id, direction) {
      requireIdle();
      const index = jobs.findIndex(item => item.id === id);
      if (index < 0 || ![-1, 1].includes(direction)) return;
      for (let next = index + direction; next >= 0 && next < jobs.length; next += direction) {
        if (jobs[next].queueId !== jobs[index].queueId || jobs[next].state !== 'Queued') continue;
        if (jobs[index].state !== 'Queued') return;
        [jobs[index], jobs[next]] = [jobs[next], jobs[index]];
        checkpoint();
        return;
      }
    },
    remove(id) {
      requireIdle();
      const index = jobs.findIndex(job => job.id === id);
      if (index >= 0) {
        jobs.splice(index, 1);
        checkpoint();
      }
    },
    configure(parameters, measured = false) {
      requireIdle();
      const next = sweepPlan(parameters);
      if (JSON.stringify(plan?.parameters) !== JSON.stringify(next.parameters)) {
        airProof = false;
        contactProof = false;
        clearanceProof = false;
      }
      if (contactMeasured !== measured) {
        contactProof = false;
        clearanceProof = false;
      }
      plan = next;
      contactMeasured = measured === true;
      checkpoint();
      return next;
    },
    readAxes() {
      requirePrinter();
      requireIdle();
      motionReading = null;
      phase = 'Reading axis position';
      startTask(async signal => {
        motionReading = await inspectMotion(printer.ip, signal);
        jogBaseline = { reading: motionReading, expires: Date.now() + 120000 };
        phase = 'Axis position received from the printer';
      });
    },
    diagnoseJog(acknowledged) {
      requirePrinter(); requireIdle(); requireAck(acknowledged);
      if (!jogBaseline || jogBaseline.expires <= Date.now()) throw Error('Click Read X/Y/Z before jogging from the touchscreen.');
      const { position } = jogBaseline.reading;
      jogBaseline = null;
      startTask(async signal => {
        phase = 'Checking the touchscreen jog and LAN motion';
        motionReading = await diagnoseHoming({
          ip: printer.ip, baseline: position, signal,
          verify: async () => {
            const detail = await update();
            if (detail.status !== 'ready') throw Error('The printer must report Ready for the diagnostic.');
            verifyCooled(detail, null);
          },
        });
        phase = motionReading.mode === 'HOMING'
          ? 'LAN X move verified. The printer still reports HOMING.'
          : 'LAN X move verified. The printer now reports READY.';
      });
    },
    probeX(acknowledged, homeRetry = false) {
      requirePrinter(); requireIdle(); requireAck(acknowledged);
      motionReading = null;
      phase = 'Testing a 5 mm X move';
      startTask(async signal => {
        const position = await motion({
          ip: printer.ip, probeX: true, signal, homeRetry,
          onHome: () => { phase = 'Homing once, then retrying the 5 mm X test'; },
          onWait: mode => { if (mode === 'homing') phase = 'Waiting for the printer to finish homing'; },
          verify: async () => verifyCooled(await update(), null),
        });
        motionReading = { position, machine: 'Idle', mode: '5 mm X move verified' };
        phase = 'Printer reported the requested 5 mm X move';
      });
    },
    test(air, acknowledged, homeRetry = false) {
      requirePrinter(); requireIdle(); requireAck(acknowledged);
      if (!air && !contactMeasured) throw Error('Enter and confirm the measured contact height before testing contact.');
      if (!plan || (!air && !airProof)) throw Error('Save the path and pass the raised test before contact testing.');
      clearanceProof = false;
      contactProof = false;
      if (air) airProof = false;
      startTask(async signal => {
        await performSweep(sweepPlan(plan.parameters, air), signal, air, homeRetry);
        if (air) {
          airProof = true;
          phase = 'Raised test complete. Review the clearances before a contact test.';
        } else {
          clearanceProof = true;
          phase = 'Contact test complete. Verify that the part exited and the plate is empty.';
        }
      });
    },
    async confirm(acknowledged) {
      if (pendingClear) pendingClear();
      else if (!running && clearanceProof) {
        clearanceProof = false;
        contactProof = true;
        phase = 'Contact test confirmed for this session and sweep path';
      } else {
        requirePrinter(); requireIdle(); requireAck(acknowledged);
        if (!endPrompt.has(details?.status)) throw Error('No plate confirmation is pending.');
        const expectedFile = details.printFileName;
        startTask(async signal => {
          phase = 'Acknowledging print prompt';
          await acknowledgeEndPrompt(expectedFile, signal);
          phase = 'Printer is ready. Plate confirmed clear.';
        });
        await running;
      }
    },
    stop() { controller?.abort(); },
    async shutdown() {
      controller?.abort();
      await running;
    },
    async cancelPrint() {
      requirePrinter();
      if (cancelling) throw Error('Cancellation is already being checked.');
      cancelling = true;
      const expected = ownedPrint ?? details?.printFileName;
      const pendingUpload = uploading;
      const task = running;
      controller?.abort();
      try {
        phase = 'Checking printer cancellation';
        const active = detail => printActive.has(detail.status) || cancellationPending.has(detail.status);
        function verifyTarget(detail) {
          if (!expected || detail.printFileName !== expected) {
            throw Error('Active file changed or could not be identified. Check the printer before cancelling.');
          }
        }
        async function finish(detail, sent) {
          await task;
          phase = ['completed', 'building_completed'].includes(detail.status) ? 'Job already completed. Queue stopped.'
            : sent ? 'Printer confirmed the job stopped. Queue stopped.' : 'Printer reports no active job. Queue stopped.';
          problem = '';
        }

        if (pendingUpload) await pendingUpload.catch(() => {});
        let detail = await readStatus();
        if (pendingUpload && !active(detail)) {
          for (let check = 0; check < 5 && !active(detail); check++) {
            await sleep(1000);
            detail = await readStatus();
          }
        }
        if (printStopped.has(detail.status)) {
          if (pendingUpload) throw Error('Upload was in flight and the printer never reported an active job. Check the printer for a delayed start.');
          return await finish(detail, false);
        }
        if (!active(detail)) throw Error(`Printer reported ${detail.status} instead of an active or stopped job.`);
        verifyTarget(detail);

        let commandIssue;
        if (!cancellationPending.has(detail.status)) {
          try { await printer.cancel(); }
          catch (error) { commandIssue = error.message; }
        }

        async function observe(checks) {
          for (let check = 0; check < checks; check++) {
            detail = await readStatus();
            if (printStopped.has(detail.status)) return true;
            if (active(detail)) verifyTarget(detail);
            await sleep(1000);
          }
          return false;
        }

        if (await observe(5)) return await finish(detail, true);
        if (printActive.has(detail.status) && printer.cancelViaConsole) {
          phase = 'Requesting stop through the printer console';
          try {
            await printer.cancelViaConsole(async () => {
              detail = await readStatus();
              if (!printActive.has(detail.status)) return false;
              verifyTarget(detail);
              return true;
            });
          } catch (error) { commandIssue = error.message; }
        }
        if (await observe(15)) return await finish(detail, true);
        const issue = commandIssue ? ` ${commandIssue}` : '';
        throw Error(`Printer did not confirm cancellation. Last reported state: ${detail.status}.${issue}`);
      } catch (error) {
        await task;
        problem = `${error.message} Use Cancel on the printer touchscreen if it is still running.`;
        phase = 'Cancellation unconfirmed';
        throw Error(problem);
      } finally { cancelling = false; }
    },
    pauseNext() {
      if (!activeQueue) throw Error('No queue is active.');
      pauseAfterCopy = !pauseAfterCopy;
    },
    start(acknowledged, id, clearingValidated) {
      requirePrinter(); requireIdle(); requireAck(acknowledged);
      const selected = list(id);
      const queue = jobs.filter(job => job.queueId === selected.id && job.completed < job.copies && job.state === 'Queued');
      if (!queue.length) throw Error('Add a new job first. Stopped jobs require manual review before re-adding.');
      const settings = settingsFor(selected);
      const clearing = isFileClearing && !settings.manualClearing ? clearingFor(selected) : null;
      if (clearing && clearingValidated !== true) {
        throw Error('Confirm that this clearing file was tested with your printer and the queued parts.');
      }
      if (clearing && queue.some(job => job.nozzle !== clearing.nozzle)) {
        throw Error('The clearing file nozzle profile must match every queued print.');
      }
      const prepared = new Map();
      for (const job of isFileClearing ? [] : queue) {
        if (job.raised && job.sweep) throw Error('Select one clearing mode per job.');
        if (job.raised) prepared.set(job.id, injectRaisedSweep(job.bytes, plan.parameters, job.height));
        if (job.sweep && (!plan || !contactMeasured || !contactProof || !job.height || plan.parameters.lift < job.height + 10)) {
          throw Error('Sweep jobs need a confirmed contact test and travel Z at least 10 mm above the model height.');
        }
      }
      activeQueue = selected.id;
      startTask(async signal => {
        for (const [jobIndex, job] of queue.entries()) {
          activeJob = job;
          for (let copy = job.completed; copy < job.copies; copy++) {
            job.state = 'Preparing';
            checkpoint();
            let d = await readStatus();
            if (!idle.has(d.status) && !endPrompt.has(d.status)) throw Error('Printer must be idle before the next print.');
            if (Number(d.nozzleModel?.match(/[\d.]+/)?.[0]) !== job.nozzle) throw Error('File nozzle size does not match the printer.');
            if (endPrompt.has(d.status)) d = await acknowledgeEndPrompt(d.printFileName, signal);
            verifyPrinter(d);
            signal.throwIfAborted();
            const filename = `wf-${job.id.slice(0, 8)}-${copy + 1}.gcode`;
            phase = !isFileClearing && job.raised ? 'Sending G-code with a raised sweep' : 'Sending the original G-code';
            job.state = !isFileClearing && job.raised ? 'Printing with raised test' : 'Printing';
            await startFile(prepared.get(job.id) ?? job.bytes, filename, settings.autoLevel, signal);
            job.completed++;
            checkpoint();
            let finishedFile = filename;
            if (clearing) {
              job.state = 'Cooling';
              phase = 'Waiting for the plate and nozzle to cool';
              await cooled(plan.parameters.cooled, signal);
              await acknowledgeEndPrompt(filename, signal);
              finishedFile = filename.replace(/\.gcode$/, '-clear.gcode');
              job.state = 'Clearing';
              phase = 'Sending separate clearing G-code';
              await startFile(clearing.bytes, finishedFile, false, signal, true);
            } else if (!isFileClearing && job.sweep) {
              job.state = 'Cooling';
              phase = plan.parameters.cooled === null ? 'Waiting for nozzle cooldown' : 'Waiting for measured cooldown';
              await cooled(plan.parameters.cooled, signal);
              job.state = 'Sweeping';
              await performSweep(plan, signal);
            }
            job.state = 'Plate check';
            const moreCopies = copy + 1 < job.copies || jobIndex + 1 < queue.length;
            if (!clearing || await verifyPlateClear({ filename: finishedFile, signal }) !== true) {
              if (settings.keepWarm && moreCopies && !pauseAfterCopy) await warmWhileWaiting(settings, signal);
              else await awaitClear(signal);
            }
            signal.throwIfAborted();
            await acknowledgeEndPrompt(finishedFile, signal);
            job.state = job.completed >= job.copies ? 'Done' : 'Queued';
            checkpoint();
            if (pauseAfterCopy) {
              phase = 'Paused between copies. Start this queue again when the plate is clear.';
              return;
            }
          }
        }
        phase = 'Queue complete';
      });
    },
  };
}
