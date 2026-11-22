import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { liveCameraFrames, readCameraFrame } from './camera.mjs';
import { makePrinter, readMotionStatus, runMotion, diagnoseHomingStatus } from './printer.mjs';
import { createQueue, parseJob } from './queue.mjs';
import { queueStorage } from './queue-storage.mjs';
import { defaultModel, selectedModel } from './models.mjs';
import { createFleet } from './fleet.mjs';
import { validateClearingCommands } from './clearing.mjs';
import { raisedSweepPreset } from './sweep.mjs';

const simulation = process.argv.includes('--simulate');
const port = Number(process.env.WF_PORT ?? 5174);
const origin = `http://127.0.0.1:${port}`;
const token = randomUUID();
function simulatedPrinter(id, modelId) {
  const model = selectedModel(modelId);
  let simulatedJob;
  let poll = 0;
  let simulatedState;
  let heat = [0, 0];
  return {
    ip: `simulated-${id}`,
    async detail() {
      const status = simulatedState ?? (!simulatedJob ? 'ready' : poll++ < 3 ? 'printing' : 'completed');
      return { name: model.label, modelId: model.id, verifiedModel: model.label, firmwareVersion: 'Simulator', nozzleModel: '0.4',
        status, printFileName: simulatedJob, printProgress: status === 'completed' ? 1 : 0.4,
        printLayer: 100, targetPrintLayer: 100, platTemp: 28, rightTemp: 34, platTargetTemp: heat[0], rightTargetTemp: heat[1] };
    },
    async clearFinished() { simulatedJob = null; simulatedState = null; },
    async cancel() { simulatedState = 'cancelled'; heat = [0, 0]; },
    async setHeat(bed, nozzle) { heat = [bed, nozzle]; },
    async start(_bytes, filename) { simulatedJob = filename; simulatedState = null; poll = 0; },
  };
}

const dataDir = new URL('./local-data/', import.meta.url);
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
const queueOptions = simulation ? {
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
} : { motion: runMotion, inspectMotion: readMotionStatus, diagnoseHoming: diagnoseHomingStatus, defaultClearing, slowClearing };
const singleQueue = createQueue({ ...queueOptions, ...(simulation ? {} : queueStorage(dataDir)) });
const fleet = createFleet({
  simulation, singleQueue, queueOptions, directory: new URL('fleet/', dataDir),
  makeDevice: (id, body) => simulation ? simulatedPrinter(id, body.model ?? defaultModel)
    : makePrinter(body.ip, body.serial, body.code, undefined, undefined, undefined, undefined, body.model ?? defaultModel),
});

if (!simulation) setInterval(() => {
  void Promise.allSettled([singleQueue.refresh(), ...fleet.queues().map(queue => queue.refresh())]);
}, 4500).unref();

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/fleet': ['fleet.html', 'text/html; charset=utf-8'],
  '/fleet.mjs': ['fleet-ui.mjs', 'text/javascript; charset=utf-8'],
  '/models.mjs': ['models.mjs', 'text/javascript; charset=utf-8'],
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
  const rawPath = request.url.split('?')[0];
  const scope = /^\/printers\/([a-f0-9-]{36})(\/.*)$/.exec(rawPath);
  const path = scope?.[2] ?? rawPath;
  try {
    if (request.method === 'GET' && !scope && path === '/fleet/state') return respond(response, 200, fleet.state());
    if (!scope && path.startsWith('/fleet/')) {
      if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['x-wf-token'] !== token) {
        return respond(response, 403, { error: 'Open the local fleet page to use these controls.' });
      }
      const body = await json(request);
      const result = await fleet.action(path, body);
      return respond(response, 200, { ...fleet.state(), result });
    }
    const queue = scope ? fleet.queue(scope[1]) : singleQueue;
    if (request.method === 'GET' && Object.hasOwn(staticFiles, path)) {
      const [name, type] = staticFiles[path];
      let content = await readFile(new URL(name, import.meta.url), 'utf8');
      if (path === '/' || path === '/fleet') content = content.replace('SERVER_TOKEN', token);
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
      case '/connect': await fleet.connect(scope?.[1] ?? 'single', body); break;
      case '/refresh': await queue.refresh(true); break;
      case '/create-queue': selectedQueue = queue.createList(body.name); break;
      case '/rename-queue': queue.renameList(body.id, body.name); break;
      case '/clearing-file': if (scope) fleet.configure('file', body); else queue.configureClearing(body.id, body.file); break;
      case '/test-clearing-height': queue.testClearingHeight(body.id, body.height, body.ack); break;
      case '/clearing-height': if (scope) fleet.configure('height', body); else queue.setClearingHeight(body.id, body.height); break;
      case '/clearing-preset': if (scope) fleet.configure('preset', body); else queue.selectClearing(body.id, body.preset); break;
      case '/queue-settings': if (scope) fleet.configure('settings', body); else queue.configureQueue(body.id, body); break;
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
  const queues = [singleQueue, ...fleet.queues()];
  await Promise.allSettled(queues.map(queue => queue.shutdown()));
  const warnings = queues.map(queue => queue.state().warmIssue).filter(Boolean);
  for (const warning of warnings) console.error(warning);
  process.exit(warnings.length ? 1 : 0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
