import { sweepPlan } from './sweep.mjs';

export function injectRaisedSweep(bytes, parameters, modelHeight) {
  const plan = sweepPlan(parameters, true);
  if (!modelHeight || parameters.lift - 5 < modelHeight + 10) {
    throw Error('For an inline raised test, set Travel Z at least 15 mm above the sliced model height.');
  }

  // Match the recognized Flashforge Orca shutdown tail so we can raise Z before
  // the original park move. Leave the startup, sliced model and metadata intact.
  const source = bytes.toString('latin1');
  const tail = /(^; filament end gcode\r?\nG1 E-3 F3600\r?\n)G0 X50 Y50 F30000\r?\nM104 S0(?:[ \t]*;[^\r\n]*)?\r?\n(M73 P100 R0\r?\n; EXECUTABLE_BLOCK_END\s*)$/m.exec(source);
  if (!tail || tail.index + tail[0].length !== source.length ||
      /^G91\b|^G92[^;\r\n]*\b[XYZ]-?[\d.]/m.test(source) ||
      source.includes('WF INLINE RAISED SWEEP')) {
    throw Error('Inline raised testing requires an original 5M Pro Orca or Orca-Flashforge file with the supported shutdown sequence.');
  }

  const newline = tail[1].includes('\r\n') ? '\r\n' : '\n';
  const motion = plan.points.map(point => {
    const axes = ['x', 'y', 'z'].filter(axis => point[axis] !== undefined);
    return ['G1', ...axes.map(axis => axis.toUpperCase() + point[axis]), 'F' + point.feed].join(' ');
  });
  const injected = [
    '; WF INLINE RAISED SWEEP',
    'M104 S0',
    'M140 S0',
    'G90',
    'G21',
    ...motion,
    'G0 X50 Y50 F3000',
  ].join(newline);
  const result = Buffer.from(source.slice(0, tail.index) + tail[1] + injected + newline + tail[2], 'latin1');
  if (result.length > 48 * 1024 * 1024) throw Error('Generated G-code exceeds the 48 MiB upload limit.');
  return result;
}
