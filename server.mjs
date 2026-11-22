import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { liveCameraFrames, readCameraFrame } from './camera.mjs';
import { makePrinter, readMotionStatus, runMotion, diagnoseHomingStatus } from './printer.mjs';
import { createQueue, parseJob } from './queue.mjs';
import { validateClearingCommands } from './clearing.mjs';
import { raisedSweepPreset } from './sweep.mjs';

const simulation = process.argv.includes('--simulate');
const port = Number(process.env.WF_PORT ?? 5174);
const origin = `http://127.0.0.1:${port}`;
const token = randomUUID();
let simulatedJob;
let poll = 0;
let simulatedState;
let heat = [0, 0];
const demo = {
  ip: 'simulated',
  async detail() {
    const status = simulatedState ?? (!simulatedJob ? 'ready' : poll++ < 3 ? 'printing' : 'completed');
    return { name: 'Flashforge Adventurer 5M Pro', firmwareVersion: 'Simulator', nozzleModel: '0.4',
      status, printFileName: simulatedJob, printProgress: status === 'completed' ? 1 : 0.4,
      printLayer: 100, targetPrintLayer: 100, platTemp: 28, rightTemp: 34, platTargetTemp: heat[0], rightTargetTemp: heat[1] };
  },
  async clearFinished() { simulatedJob = null; simulatedState = null; },
  async cancel() { simulatedState = 'cancelled'; heat = [0, 0]; },
  async setHeat(bed, nozzle) { heat = [bed, nozzle]; },
  async start(_bytes, filename) { simulatedJob = filename; simulatedState = null; poll = 0; },
};

const dataDir = new URL('./local-data/', import.meta.url);
const savedFile = new URL('queues.json', dataDir);
const pendingFile = new URL('queues.tmp', dataDir);
const storageIds = new Set();
let saved;

function jobFile(id) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Invalid job storage ID.');
  return new URL(`${id}.gcode`, dataDir);
}
if (!simulation && existsSync(savedFile)) {
  try {
    saved = JSON.parse(readFileSync(savedFile, 'utf8'));
    for (const job of saved.jobs) {
      job.bytes = readFileSync(jobFile(job.id));
      storageIds.add(job.id);
    }
  } catch {
    throw Error('Could not read the saved queue or its G-code. Preserve local-data for recovery before starting AutoLoop.');
  }
}
function persist({ lists, jobs, parameters, contactMeasured }) {
  mkdirSync(dataDir, { recursive: true });
  const live = new Set(jobs.map(job => job.id));
  const entries = jobs.map(({ bytes, ...job }) => {
    if (!storageIds.has(job.id)) {
      const temporary = new URL(`${job.id}.writing`, dataDir);
      writeFileSync(temporary, bytes, { mode: 0o600 });
      renameSync(temporary, jobFile(job.id));
      storageIds.add(job.id);
    }
    return job;
  });
  writeFileSync(pendingFile, JSON.stringify({ lists, jobs: entries, parameters, contactMeasured }), { mode: 0o600 });
  renameSync(pendingFile, savedFile);
  for (const id of storageIds) {
    if (live.has(id)) continue;
    try { unlinkSync(jobFile(id)); } catch { /* Queue is saved. A leftover local file can be removed separately. */ }
    storageIds.delete(id);
  }
}
function bundledClearing(path, filename) {
  const job = parseJob({
    filename, copies: 1,
    data: readFileSync(new URL(path, import.meta.url)).toString('base64'),
  });
  validateClearingCommands(job.bytes);
  return job;
}
const defaultClearing = bundledClearing('./default-clearing.gcode', 'WF_5M_Pro_Quick_Single_Layer_Sweep_Z4.gcode');
const slowClearing = bundledClearing('./slow-clearing.gcode', 'WF_5M_Pro_Single_Layer_Sweep_Z0p2_15mms.gcode');
const queue = createQueue(simulation ? {
  defaultClearing, slowClearing, verifyPlateClear: async () => true,
  motion: async ({ signal, points, verify, probeX }) => {
    if (probeX) { await verify(); return [20, 50, 45]; }
    for (const _point of points) {
      signal.throwIfAborted();
      await verify();
    }
  },
  diagnoseHoming: async () => ({ mode: 'HOMING', machine: 'READY', position: [10, 50, 45] }),
  inspectMotion: async () => ({ mode: 'READY', machine: 'READY', position: [25, 50, 45] }),
  sleep: () => new Promise(resolve => setTimeout(resolve, 15)),
} : { motion: runMotion, inspectMotion: readMotionStatus, diagnoseHoming: diagnoseHomingStatus, defaultClearing, slowClearing, saved, persist });

if (!simulation) setInterval(() => { void queue.refresh(); }, 4500).unref();

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/ui.mjs': ['ui.mjs', 'text/javascript; charset=utf-8'],
  '/sweep.mjs': ['sweep.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

async function json(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw Error('JSON request required.');
  const buffers = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65 * 1024 * 1024) throw Error('Upload is too large.');
    buffers.push(chunk);
  }
  return JSON.parse(Buffer.concat(buffers));
}

function respond(response, code, data) {
  response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (request.headers.host !== `127.0.0.1:${port}`) return respond(response, 403, { error: 'Open the exact local URL shown by the launcher.' });
  const path = request.url.split('?')[0];
  try {
    if (request.method === 'GET' && Object.hasOwn(staticFiles, path)) {
      const [name, type] = staticFiles[path];
      let content = await readFile(new URL(name, import.meta.url), 'utf8');
      if (path === '/') content = content.replace('SERVER_TOKEN', token);
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(content);
      return;
    }
    if (request.method === 'GET' && path === '/camera' && request.headers['x-wf-token'] === token) {
      if (simulation) return respond(response, 409, { error: 'The simulator has no physical camera.' });
      const source = queue.cameraSource();
      const client = new AbortController();
      response.on('close', () => client.abort());
      const { signal } = client;
      async function sendFrame(frame, live) {
        if (queue.cameraSource().ip !== source.ip) throw Error('Printer changed. Refresh the camera.');
        if (!response.headersSent) response.writeHead(200, {
          'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store',
        });
        const body = JSON.stringify({ jpeg: frame.toString('base64'), live }) + '\n';
        if (!response.write(body)) await once(response, 'drain', { signal });
      }
      try {
        for await (const { frame, live } of liveCameraFrames(source, signal)) await sendFrame(frame, live);
        while (!signal.aborted) {
          await sendFrame(await readCameraFrame(source, fetch, signal), false);
          await wait(400, undefined, { signal });
        }
      } catch (error) {
        if (!signal.aborted) {
          if (!response.headersSent) return respond(response, 502, { error: error.message });
          response.end(JSON.stringify({ error: error.message }) + '\n');
        }
      }
      return;
    }
    if (request.method === 'GET' && path === '/state') return respond(response, 200, { ...queue.state(), simulation });
    if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['x-wf-token'] !== token) {
      return respond(response, 403, { error: 'Open the local page to use the printer controls.' });
    }
    const body = await json(request);
    let selectedQueue;
    switch (path) {
      case '/connect': await queue.connect(simulation ? demo : makePrinter(body.ip, body.serial, body.code)); break;
      case '/refresh': await queue.refresh(true); break;
      case '/create-queue': selectedQueue = queue.createList(body.name); break;
      case '/rename-queue': queue.renameList(body.id, body.name); break;
      case '/clearing-file': queue.configureClearing(body.id, body.file); break;
      case '/clearing-preset': queue.selectClearing(body.id, body.preset); break;
      case '/queue-settings': queue.configureQueue(body.id, body); break;
      case '/cancel-print': await queue.cancelPrint(); break;
      case '/edit': queue.edit(body.id, body.copies, body.sweep, body.raised); break;
      case '/move': queue.move(body.id, body.direction); break;
      case '/pause-next': queue.pauseNext(); break;
      case '/add': queue.add(body); break;
      case '/remove': queue.remove(body.id); break;
      case '/configure': queue.configure(body, body.contactMeasured === true); break;
      case '/raised-preset': queue.configure(raisedSweepPreset); break;
      case '/probe-x': queue.probeX(body.ack, body.homeRetry === true); break;
      case '/diagnose-jog': queue.diagnoseJog(body.ack); break;
      case '/read-axes': queue.readAxes(); break;
      case '/test': queue.test(body.air === true, body.ack, body.homeRetry === true); break;
      case '/start': queue.start(body.ack, body.id, body.clearingValidated); break;
      case '/confirm': await queue.confirm(body.ack); break;
      case '/stop': queue.stop(); break;
      default: return respond(response, 404, { error: 'Action not found.' });
    }
    respond(response, 200, { ...queue.state(), simulation, selectedQueue });
  } catch (error) {
    respond(response, 400, { error: error.message });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`${simulation ? 'Simulator' : '5M Pro AutoLoop'} ready at ${origin}/ — Ctrl+C closes the server.`));

async function shutdown() {
  server.close();
  await queue.shutdown();
  const warning = queue.state().warmIssue;
  if (warning) console.error(warning);
  process.exit(warning ? 1 : 0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
