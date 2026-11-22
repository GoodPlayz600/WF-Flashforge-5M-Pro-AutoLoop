const moveLimits = { X: [-109, 109], Y: [-109, 109], Z: [0.2, 220], E: [-5, 0], F: [1, 24000] };

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
