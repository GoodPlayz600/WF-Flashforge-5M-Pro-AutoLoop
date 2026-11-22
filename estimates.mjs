export function slicedSeconds(source) {
  const text = typeof source === 'string' ? source : source.toString('utf8');
  const comment = /^;[ \t]*estimated (?:printing time \(normal mode\)|motion time, excluding heat-up)[ \t]*=[ \t]*([^\r\n]+)/im.exec(text)?.[1].trim();
  if (comment && /^(?:\d+\s*[dhms]\s*)+$/i.test(comment)) {
    const seconds = { d: 86400, h: 3600, m: 60, s: 1 };
    const total = [...comment.matchAll(/(\d+)\s*([dhms])/gi)]
      .reduce((sum, [, count, unit]) => sum + Number(count) * seconds[unit.toLowerCase()], 0);
    if (Number.isSafeInteger(total) && total > 0) return total;
  }
  const total = Number(/^;[ \t]*TIME:[ \t]*(\d+)[ \t]*\r?$/im.exec(text)?.[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

export function remainingSeconds(detail, sliced) {
  if (Number.isFinite(detail?.estimatedTime) && detail.estimatedTime > 0) return detail.estimatedTime;
  if (sliced === null || sliced === undefined) return null;
  const reported = detail?.printProgress;
  const progress = Number.isFinite(reported) ? Math.max(0, Math.min(1, reported)) : 0;
  return sliced * (1 - progress);
}

export function estimateQueue(jobs, { clearing, clearingSeconds, activeJob, progress, runningJob }) {
  let seconds = 0;
  let unknown = 0;
  function add(count, estimate) {
    if (estimate === null || estimate === undefined) unknown += count;
    else seconds += count * estimate;
  }
  for (const job of jobs) {
    const active = job.id === activeJob;
    if (!active && job.state !== 'Queued') continue;
    const copies = Math.max(0, job.copies - job.completed);
    if (active && runningJob === 'print' && copies) {
      add(1, remainingSeconds(progress, job.estimatedSeconds));
      add(copies - 1, job.estimatedSeconds);
    } else {
      add(copies, job.estimatedSeconds);
    }
    if (clearing) {
      add(copies, clearingSeconds);
      if (active && ['Cooling', 'Preparing to clear'].includes(job.state)) add(1, clearingSeconds);
      if (active && job.state === 'Clearing') add(1, remainingSeconds(progress, clearingSeconds));
    }
  }
  return { seconds, unknown };
}
