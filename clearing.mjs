const moveLimits = { X: [-109, 109], Y: [-110, 109], Z: [0.2, 220], E: [-5, 0], F: [1, 24000] };

export function validateClearingCommands(bytes) {
  if (bytes.length > 256 * 1024) throw Error('Use a clearing G-code file under 256 KiB.');
  let absolute = false;
  let relativeExtrusion = false;
  let retracted = 0;
  let xyMoves = 0;
  for (const raw of bytes.toString('utf8').split(/\r?\n/)) {
    const line = raw.split(';')[0].trim().toUpperCase();
    if (!line) continue;
    if (line === 'G90') absolute = true;
    else if (line === 'M83') relativeExtrusion = true;
    else if (/^G[01] (?:[XYZEF][+-]?(?:\d+(?:\.\d*)?|\.\d+)(?: +|$))+$/.test(line)) {
      if (!absolute) throw Error('Clearing moves must follow G90 absolute positioning.');
      const axes = new Set();
      for (const word of line.split(/ +/).slice(1)) {
        const axis = word[0];
        const value = Number(word.slice(1));
        const [min, max] = moveLimits[axis];
        if (axes.has(axis) || value < min || value > max) throw Error(`Clearing move is outside its allowed range: ${line}`);
        axes.add(axis);
        if (axis === 'E') {
          retracted -= value;
          if (!relativeExtrusion || retracted > 5) throw Error('Clearing files allow at most 5 mm of relative retraction and no forward feed.');
        }
      }
      if (axes.has('X') || axes.has('Y')) xyMoves++;
    } else if (/^G21$|^M73 P\d{1,3}(?: R\d+)?$|^M10[49] S(?:\d{1,2}|1\d{2}|2[0-3]\d|240)$|^M1[49]0 S(?:\d|[1-7]\d|80)$/.test(line)) {
      continue;
    } else {
      throw Error(`Unsupported clearing command: ${line}`);
    }
  }
  if (!xyMoves) throw Error('The clearing file has no XY motion.');
}

export function clearingAtHeight(preset, height, modelHeight) {
  const z = height === 0 ? 0.2 : height;
  const travel = Math.max(12, z + 10, modelHeight ? Math.ceil(modelHeight + 10) : 0);
  if (travel > moveLimits.Z[1]) {
    throw Error('This print is too tall to leave 10 mm of travel clearance for an adjustable sweep.');
  }

  const source = preset.bytes.toString('latin1');
  const work = /^;Z:(\d+(?:\.\d+)?)\r?$/m.exec(source)?.[1];
  if (!work) throw Error('Could not read the bundled clearing height.');
  let travelMoves = 0;
  let workMoves = 0;
  const output = source.replace(/^G1 Z(\d+(?:\.\d+)?) F600(?=\r?$)/gm, (line, previous) => {
    if (previous === '12') {
      travelMoves++;
      return `G1 Z${travel} F600`;
    }
    if (previous === work) {
      workMoves++;
      return `G1 Z${z} F600`;
    }
    return line;
  });
  if (!workMoves || travelMoves !== workMoves + 1) throw Error('Could not adjust all clearing passes.');
  const estimatedSeconds = Number.isFinite(preset.estimatedSeconds)
    ? Math.max(1, Math.ceil(preset.estimatedSeconds + 2 * workMoves * ((travel - z) - (12 - Number(work))) / 10))
    : null;
  const withHeight = output
    .replace(/^;Z:[^\r\n]+/m, `;Z:${z}`)
    .replace(/^;HEIGHT:[^\r\n]+/m, `;HEIGHT:${z}`)
    .replace(/^; max_z_height:[^\r\n]+/m, `; max_z_height: ${travel.toFixed(2)}`);
  const bytes = Buffer.from(estimatedSeconds === null ? withHeight : withHeight
    .replace(/^M73 P0 R\d+/m, `M73 P0 R${Math.ceil(estimatedSeconds / 60)}`)
    .replace(/^; estimated motion time, excluding heat-up = [^\r\n]+/m, `; estimated motion time, excluding heat-up = ${estimatedSeconds}s`), 'latin1');
  validateClearingCommands(bytes);
  return { ...preset, bytes, estimatedSeconds };
}
