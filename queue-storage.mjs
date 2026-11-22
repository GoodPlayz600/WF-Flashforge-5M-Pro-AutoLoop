import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';

export function queueStorage(dataDir) {
  const savedFile = new URL('queues.json', dataDir);
  const pendingFile = new URL('queues.tmp', dataDir);
  const storageIds = new Set();
  let saved;

  function jobFile(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Invalid job storage ID.');
    return new URL(`${id}.gcode`, dataDir);
  }
  if (existsSync(savedFile)) {
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
  return { saved, persist };
}
