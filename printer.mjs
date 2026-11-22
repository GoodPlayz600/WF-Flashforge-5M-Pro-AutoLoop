import { createConnection } from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';

export function makePrinter(ip, serialNumber, checkCode, request = fetch, identify = readMachineInfo, setHeat = setTemperatures, stopConsole = cancelOnConsole) {
  ip = typeof ip === 'string' ? ip.trim() : '';
  serialNumber = typeof serialNumber === 'string' ? serialNumber.trim() : '';
  checkCode = typeof checkCode === 'string' ? checkCode.trim() : '';
  const parts = ip.split('.').map(Number);
  const onLan = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && parts.every(n => n <= 255) &&
    (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
     (parts[0] === 192 && parts[1] === 168));
  if (!onLan || !serialNumber || !checkCode) throw new Error('Enter a local IPv4 address, serial number and LAN check code.');

  async function post(endpoint, body, headers, timeout = 7000) {
    const response = await request(`http://${ip}:8898/${endpoint}`, {
      method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`Printer rejected ${endpoint} (HTTP ${response.status}).`);
    const result = await response.json();
    if (result.code !== 0) {
      const code = Number.isInteger(result.code) ? ` (code ${result.code})` : '';
      const hint = endpoint === 'detail' ? ' Check LAN Only, printer serial number and LAN access code.' : '';
      throw new Error(`Printer rejected ${endpoint}${code}.${hint}`);
    }
    return result;
  }

  const auth = { serialNumber, checkCode };
  const normalSerial = value => String(value).trim().toUpperCase().replace(/^SN[ :_-]*/, '');
  function matchSerial(value) {
    if (value && normalSerial(value) !== normalSerial(serialNumber)) {
      throw Error('The printer reported a different serial number. Check its LAN IP and serial number.');
    }
  }
  let identity;
  return {
    async detail() {
      const result = await post('detail', JSON.stringify(auth), { 'Content-Type': 'application/json' });
      const detail = result.detail;
      if (!detail || typeof detail.status !== 'string') throw new Error('Printer status is missing.');
      matchSerial(detail.serialNumber ?? detail.sn ?? result.serialNumber);
      if (!identity) {
        const reportedModel = detail.machineType ?? detail.printerModel ?? detail.model ?? result.machineType;
        if (isProModel(reportedModel)) {
          identity = { model: 'Flashforge Adventurer 5M Pro', source: 'LAN hardware model' };
        } else if (!reportedModel && isProModel(detail.name)) {
          identity = { model: 'Flashforge Adventurer 5M Pro', source: 'LAN device name' };
        } else {
          let info;
          try { info = await identify(ip); }
          catch (error) { throw Error(`LAN connected, but model verification could not read the printer’s hardware ID. Close other printer-control apps and retry. ${error.message}`); }
          if (!isProModel(info.model)) throw Error('The hardware reports something other than an Adventurer 5M Pro. Check the printer IP.');
          if (!info.serial) throw Error('The hardware ID response omitted the printer serial number.');
          matchSerial(info.serial);
          identity = { model: 'Flashforge Adventurer 5M Pro', source: 'Hardware ID (M115)', firmware: info.firmware };
        }
      }
      return { ...detail, verifiedModel: identity.model, identitySource: identity.source,
        firmwareVersion: detail.firmwareVersion || identity.firmware };
    },
    ip,
    async clearFinished() {
      await post('control', JSON.stringify({
        ...auth, payload: { cmd: 'stateCtrl_cmd', args: { action: 'setClearPlatform' } },
      }), { 'Content-Type': 'application/json' });
    },
    async cancel() {
      await post('control', JSON.stringify({
        ...auth, payload: { cmd: 'jobCtl_cmd', args: { jobID: '', action: 'cancel' } },
      }), { 'Content-Type': 'application/json' });
    },
    async cancelViaConsole(stillActive) {
      await stopConsole(ip, stillActive);
    },
    async setHeat(bed, nozzle) {
      return setHeat(ip, bed, nozzle);
    },
    async start(bytes, jobName, autoLevel = true) {
      const body = new FormData();
      body.append('gcodeFile', new Blob([bytes], { type: 'application/octet-stream' }), jobName);
      await post('uploadGcode', body, {
        ...auth, fileSize: String(bytes.length), printNow: 'true', levelingBeforePrint: String(autoLevel),
        flowCalibration: 'false', useMatlStation: 'false', gcodeToolCnt: '0', materialMappings: 'W10=',
      }, 30000);
    },
  };
}

export function isProModel(value) {
  return /^(?:flashforge)?(?:adventurer5mpro|ad5mpro|5mpro)$/.test(
    typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '',
  );
}

export function verifyModel(detail) {
  if (!isProModel(detail.verifiedModel) && !isProModel(detail.name)) {
    throw Error('The printer must identify itself as an Adventurer 5M Pro.');
  }
}
export function verifyPrinter(detail) {
  verifyModel(detail);
  if (detail.errorCode || ['pause', 'paused', 'pausing', 'cancel', 'canceled', 'cancelled', 'error'].includes(detail.status)) {
    throw Error('Printer paused or reported a fault. Check the printer screen for runout or another cause.');
  }
}

export function verifyCooled(detail, maxBed) {
  verifyPrinter(detail);
  if (!['ready', 'completed'].includes(detail.status)) {
    throw Error(`Sweep blocked: printer state is ${detail.status}. Wait until it is ready or completed.`);
  }
  const actual = [detail.platTemp, detail.rightTemp];
  const targets = [detail.platTargetTemp, detail.rightTargetTemp];
  if ([...actual, ...targets].some(value => !Number.isFinite(value) || value < 0)) {
    throw Error('Sweep blocked: the printer reported missing or invalid bed or nozzle temperatures.');
  }
  if (targets.some(value => value !== 0)) {
    throw Error(`Sweep blocked: heater targets are bed ${targets[0]} °C and nozzle ${targets[1]} °C. Turn both off at the printer before a calibration test.`);
  }
  if (actual[1] > 50) {
    throw Error(`Sweep blocked: nozzle is ${actual[1]} °C. Wait until it is 50 °C or lower.`);
  }
  if (maxBed > 0 && actual[0] > maxBed) {
    throw Error(`Sweep blocked: bed is ${actual[0]} °C and the saved threshold is ${maxBed} °C. Wait for cooldown or set the threshold to 0 to skip the bed wait.`);
  }
}

function openConsole(ip, signal, connect) {
  const socket = connect({ host: ip, port: 8899 });
  const abort = () => socket.destroy(new Error('Sweep interrupted. Check the machine before proceeding.'));
  signal.addEventListener('abort', abort, { once: true });
  let buffer = '';
  let pending;
  let failure;
  let movementRequested = false;

  function disconnected(cause) {
    if (failure) return;
    const context = pending ? ` while waiting for ${pending.command}` : '';
    const detail = cause ? ` (${cause.message})` : '';
    const motion = movementRequested ? ' Check the toolhead at the printer before retrying. The last move may have been accepted.' : '';
    failure = Object.assign(Error(`Printer console disconnected${context}${detail}.${motion}`, { cause }), {
      code: 'PRINTER_CONSOLE_DISCONNECTED',
    });
    pending?.reject(failure);
  }

  socket.setEncoding('ascii');
  socket.on('data', data => {
    buffer += data;
    if (buffer.length > 16000) {
      const error = Error('Unexpected printer command response.');
      pending?.reject(error);
      socket.destroy();
      return;
    }
    if (pending && /(?:^|\n)ok\r?\n/i.test(buffer)) {
      const response = buffer;
      buffer = '';
      pending.resolve(response);
    }
  });
  socket.on('error', disconnected);
  socket.on('close', () => disconnected());

  function command(text) {
    signal.throwIfAborted();
    if (failure) throw failure;
    return new Promise((resolve, reject) => {
      const name = text.split(' ')[0];
      const timer = setTimeout(() => socket.destroy(Error('response timed out')), 5000);
      pending = {
        command: name,
        resolve(response) {
          clearTimeout(timer);
          pending = null;
          if (/unknown command|out of range|\berror\b|control fail/i.test(response)) reject(Error('Printer rejected the console command.'));
          else resolve(response);
        },
        reject(error) { clearTimeout(timer); pending = null; reject(error); },
      };
      movementRequested ||= name === 'G1' || name === 'G28';
      try {
        socket.write(`~${text}\r\n`);
      } catch (error) {
        disconnected(error);
      }
    });
  }

  return {
    command,
    usable: () => !failure && !signal.aborted,
    close() {
      socket.destroy();
      signal.removeEventListener('abort', abort);
    },
  };
}

async function readConsole(ip, signal, connect, read) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const console = openConsole(ip, signal, connect);
    let claimed = false;
    try {
      if (!/Control Success/i.test(await console.command('M601 S1'))) throw Error('Printer console is busy.');
      claimed = true;
      return await read(console.command);
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === 1 || error.code !== 'PRINTER_CONSOLE_DISCONNECTED') throw error;
    } finally {
      if (claimed && console.usable()) await console.command('M602').catch(() => {});
      console.close();
    }
    await wait(350, undefined, { signal });
  }
}

export async function readMachineInfo(ip, connect = createConnection) {
  return readConsole(ip, AbortSignal.timeout(12000), connect, async command => {
    const reply = await command('M115');
    const get = label => reply.match(new RegExp(`(?:^|\\n)${label}: *([^\\r\\n]*)`, 'i'))?.[1].trim();
    return { model: get('Machine Type'), serial: get('SN'), firmware: get('Firmware') };
  });
}

export async function cancelOnConsole(ip, stillActive, connect = createConnection) {
  const console = openConsole(ip, AbortSignal.timeout(12000), connect);
  let claimed = false;
  try {
    if (!/Control Success/i.test(await console.command('M601 S1'))) throw Error('Printer console is busy.');
    claimed = true;
    if (await stillActive()) await console.command('M26');
  } finally {
    if (claimed && console.usable()) await console.command('M602').catch(() => {});
    console.close();
  }
}

export async function setTemperatures(ip, bed, nozzle, connect = createConnection) {
  if (!Number.isInteger(bed) || bed < 0 || bed > 75 || !Number.isInteger(nozzle) || nozzle < 0 || nozzle > 170) {
    throw Error('Standby temperatures must be within 0–75 °C for the bed and 0–170 °C for the nozzle.');
  }
  const console = openConsole(ip, AbortSignal.timeout(22000), connect);
  let claimed = false;
  try {
    if (!/Control Success/i.test(await console.command('M601 S1'))) throw Error('Printer console is busy.');
    claimed = true;
    const mode = await console.command('M119');
    if (!/MachineStatus:\s*(READY|BUILDING_COMPLETED|CANCELED|CANCELLED)\b/i.test(mode) || !/MoveMode:\s*READY\b/i.test(mode)) {
      throw Error('The printer must be idle to change standby temperatures.');
    }
    await console.command(`M104 S${nozzle}`);
    await console.command(`M140 S${bed}`);
  } finally {
    if (claimed && console.usable()) await console.command('M602').catch(() => {});
    console.close();
  }
}

function axisPosition(response) {
  const match = response.match(/X:\s*([+-]?\d+(?:\.\d+)?)\s+Y:\s*([+-]?\d+(?:\.\d+)?)\s+Z:\s*([+-]?\d+(?:\.\d+)?)/i);
  if (!match) throw Error('Could not read X, Y and Z from the printer’s position reply (M114).');
  return match.slice(1).map(Number);
}

function motionStatus(reply) {
  const mode = reply.match(/MoveMode:\s*(\w+)/i)?.[1].toUpperCase();
  const machine = reply.match(/MachineStatus:\s*(\w+)/i)?.[1].toUpperCase();
  if (!mode || !machine) throw Error('Printer did not report its motion mode.');
  return { mode, machine };
}

const describeAxes = values => values.map((v, i) => `${'XYZ'[i]}${v.toFixed(2)}`).join(' ');

// The 5M Pro can report slightly over +110 at its homed XY endstops.
const reportedXYMin = -110;
const reportedXYMax = 110.5;
const reportedXYAllowed = value => value >= reportedXYMin && value <= reportedXYMax;

export async function readMotionStatus(ip, signal, connect = createConnection) {
  return readConsole(ip, signal, connect, async command => {
    const status = motionStatus(await command('M119'));
    return { ...status, position: axisPosition(await command('M114')) };
  });
}

export async function diagnoseHomingStatus({ ip, baseline, signal, verify, connect = createConnection, sleep = wait }) {
  const console = openConsole(ip, signal, connect);
  const { command } = console;
  let claimed = false;
  async function sample() {
    await verify();
    const { machine, mode } = motionStatus(await command('M119'));
    if (machine !== 'READY' || !['READY', 'HOMING', 'MOVING'].includes(mode)) {
      throw Error(`Diagnostic stopped: motion console reports ${machine} / ${mode}.`);
    }
    return { mode, position: axisPosition(await command('M114')) };
  }
  const near = (a, b, tolerance) => a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
  async function waitForStablePosition() {
    let previous;
    let report;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt > 0) await sleep(450, undefined, { signal });
      report = await sample();
      if (report.mode !== 'MOVING' && previous && near(previous.position, report.position, 0.05)) return report;
      previous = report.mode === 'MOVING' ? undefined : report;
    }
    throw Error(`The touchscreen jog did not settle. Last report ${describeAxes(report.position)} (${report.mode}). No LAN move was sent.`);
  }
  try {
    await verify();
    if (!/Control Success/i.test(await command('M601 S1'))) throw Error('Printer console is busy.');
    claimed = true;
    const current = await waitForStablePosition();
    const [x, y, z] = current.position;
    const outside = ['X', 'Y'].filter((_, index) => !reportedXYAllowed(current.position[index]));
    if (outside.length) {
      throw Error(`Printer reported ${describeAxes(current.position)}. ${outside.join(' and ')} outside the reported position range of ${reportedXYMin} to ${reportedXYMax} mm. No LAN move was sent.`);
    }
    if (z < 40 || z > 220) {
      throw Error(`Printer reported ${describeAxes(current.position)}. Z must be between 40 and 220 mm. No LAN move was sent.`);
    }
    const expectedX = baseline[0] + (baseline[0] > 0 ? -10 : 10);
    const jogInstructions = 'Click Read X/Y/Z once, jog only X 10 mm inward on the touchscreen, then run the diagnostic.';
    if (near(current.position, baseline, 0.05)) {
      throw Error(`LAN position stayed at ${describeAxes(baseline)}. Expected the touchscreen jog to reach about X${expectedX.toFixed(2)}. ${jogInstructions} No LAN move was sent.`);
    }
    if (Math.abs(x) >= Math.abs(baseline[0]) || Math.abs(x - expectedX) > 0.5 ||
        Math.abs(y - baseline[1]) > 0.1 || Math.abs(z - baseline[2]) > 0.1) {
      throw Error(`Stored baseline ${describeAxes(baseline)}. Current position ${describeAxes(current.position)}. Expected about X${expectedX.toFixed(2)} with Y and Z unchanged. ${jogInstructions} No LAN move was sent.`);
    }
    const target = [Math.round((x + (x > 0 ? -5 : 5)) * 1000) / 1000, y, z];
    await verify();
    await command('G90');
    await command(`G1 X${target[0]} F300`);
    await sleep(1400, undefined, { signal });
    let stable = 0;
    let report;
    for (let attempt = 0; attempt < 12; attempt++) {
      report = await sample();
      stable = report.mode !== 'MOVING' && near(report.position, target, 0.4) ? stable + 1 : 0;
      if (stable >= 2) return { machine: 'READY', ...report };
      await sleep(500, undefined, { signal });
    }
    throw Error(`LAN X move unverified. Expected ${describeAxes(target)}. Last report ${describeAxes(report.position)} / ${report.mode}. This diagnostic sent only one X move.`);
  } finally {
    if (claimed && console.usable()) await command('M602').catch(() => {});
    console.close();
  }
}

export async function runMotion({ ip, points, probeX = false, homeRetry = false, onHome = () => {}, onWait = () => {}, signal, verify, connect = createConnection, sleep = wait }) {
  const console = openConsole(ip, signal, connect);
  const { command } = console;
  let loggedIn = false;

  async function readMode(allowHoming = false, waitingForIdle = false) {
    const { mode, machine } = motionStatus(await command('M119'));
    const allowed = ['READY', 'BUILDING_COMPLETED'];
    if (allowHoming || (waitingForIdle && (machine === 'HOMING' || mode === 'HOMING'))) allowed.push('BUSY', 'HOMING');
    if (!allowed.includes(machine)) throw Error(`Printer reported ${machine} / ${mode} in the motion console. The operation stopped.`);
    return { machine, mode, idle: ['READY', 'BUILDING_COMPLETED'].includes(machine) && mode === 'READY' };
  }

  async function readPosition() {
    return axisPosition(await command('M114'));
  }

  async function waitForIdle() {
    let stable = 0;
    let status;
    let position;
    let lastWaitMode;
    let sawHoming = false;
    const start = Date.now();
    const regularWaitMs = 12000;
    const homingWaitMs = 45000;
    for (let attempt = 0; attempt < (sawHoming ? 90 : 24) &&
        Date.now() - start < (sawHoming ? homingWaitMs : regularWaitMs); attempt++) {
      status = await readMode(false, true);
      sawHoming ||= status.machine === 'HOMING' || status.mode === 'HOMING';
      const next = await readPosition();
      const unchanged = position && next.every((value, axis) => Math.abs(value - position[axis]) <= 0.05);
      stable = status.idle ? (unchanged ? stable + 1 : 1) : 0;
      position = next;
      if (stable >= 2) return position;
      const waitMode = sawHoming ? 'homing' : 'idle';
      if (lastWaitMode !== waitMode) {
        lastWaitMode = waitMode;
        onWait(waitMode);
      }
      await sleep(500, undefined, { signal });
    }
    const last = `${status.machine} / ${status.mode}, last position ${describeAxes(position)}`;
    if (status.mode === 'HOMING' || status.machine === 'HOMING') {
      throw Error(`Printer still reports homing after the wait (${last}). No movement or homing command was sent. Check the touchscreen for a prompt, then use Read X/Y/Z.`);
    }
    throw Error(`Printer never confirmed idle (${last}). Check the touchscreen, then use Read X/Y/Z.`);
  }

  async function home() {
    await verify();
    const before = await waitForIdle();
    await verify();
    onHome();
    await command('G28');
    let started = false;
    let stable = 0;
    const deadline = Date.now() + 45000;
    for (let attempt = 0; attempt < 90 && Date.now() < deadline; attempt++) {
      await sleep(500, undefined, { signal });
      const status = await readMode(true);
      const position = await readPosition();
      started ||= !status.idle || position.some((value, axis) => Math.abs(value - before[axis]) > 0.4);
      // This model parks at its positive XY endstops with the bed at Z220 after homing.
      const atHome = position[0] >= 109 && position[0] <= 110.5 &&
        position[1] >= 109 && position[1] <= 110.5 && Math.abs(position[2] - 220) <= 0.4;
      stable = status.idle && atHome && started ? stable + 1 : 0;
      if (stable >= 2) return position;
    }
    throw Error('Homing was requested but could not be verified. Check the printer before trying another move.');
  }

  function positionAllowed(position) {
    return position.slice(0, 2).every(reportedXYAllowed) && position[2] >= 1 && position[2] <= 220;
  }

  async function execute(current) {
    if (!positionAllowed(current)) {
      const error = Error(`Printer reported an invalid starting position (${describeAxes(current)}). Prepare a homed position with clearance at the touchscreen first.`);
      error.canHomeRetry = true;
      throw error;
    }
    let path = points;
    if (probeX) {
      if (current[2] < 40) throw Error('Bring Z to at least 40 mm of clearance at the printer before the 5 mm X test.');
      const x = Math.round((current[0] + (current[0] > 0 ? -5 : 5)) * 1000) / 1000;
      path = [{ x, feed: 300 }];
    }
    await command('G90');
    for (let index = 0; index < path.length; index++) {
      const original = path[index];
      const step = index === 0 && !probeX ? { ...original, z: Math.max(original.z, current[2]) } : original;
      signal.throwIfAborted();
      await verify();
      const target = ['x', 'y', 'z'].map((axis, index) => step[axis] ?? current[index]);
      const words = ['x', 'y', 'z'].filter(axis => step[axis] !== undefined).map(axis => `${axis.toUpperCase()}${step[axis]}`);
      const move = `G1 ${words.join(' ')} F${step.feed}`;
      await command(move);
      const distance = Math.hypot(...target.map((value, index) => value - current[index]));
      // ACK may mean queued, so wait at least the ideal travel time, then verify idle and position.
      await sleep(Math.ceil(distance * 60000 / step.feed), undefined, { signal });
      let reported;
      let idle;
      let stableReads = 0;
      const deadline = Date.now() + 12000;
      for (let attempt = 0; attempt < 18 && Date.now() < deadline; attempt++) {
        ({ idle } = await readMode());
        reported = await readPosition();
        const reached = reported.every((value, axis) => Math.abs(value - target[axis]) <= 0.4);
        stableReads = idle && reached ? stableReads + 1 : 0;
        if (stableReads >= 2) break;
        await sleep(350, undefined, { signal });
      }
      if (stableReads < 2) {
        const error = Error(`${probeX ? '5 mm X test' : 'Sweep'} stopped at step ${index + 1} of ${path.length}: ${move}. Expected ${describeAxes(target)}; printer reported ${reported ? describeAxes(reported) : 'no position'}. No further moves were sent.`);
        error.canHomeRetry = (probeX || index <= 1) && idle && reported &&
          reported.every((value, axis) => Math.abs(value - current[axis]) <= 0.05);
        throw error;
      }
      current = reported;
    }
    return current;
  }

  try {
    await verify();
    if (!/Control Success/i.test(await command('M601 S1'))) throw Error('Printer did not grant motion control.');
    loggedIn = true;
    const current = await waitForIdle();
    await verify();
    try {
      return await execute(current);
    } catch (error) {
      if (!homeRetry || !error.canHomeRetry) throw error;
      return await execute(await home());
    }
  } finally {
    if (loggedIn && console.usable()) await command('M602').catch(() => {});
    console.close();
  }
}
