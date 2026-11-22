export const raisedSweepPreset = Object.freeze({
  left: -90, right: 90, back: 95, front: -105, pitch: 20,
  contact: 10, lift: 50, speed: 300, cooled: 30,
});

export function sweepPlan(params, air = false) {
  const limits = {
    left: [-109, 109], right: [-109, 109], back: [-109, 109], front: [-109, 109],
    pitch: [10, 100], contact: [1, 40], lift: [25, 205], speed: [60, 900],
  };
  const s = {};
  for (const [key, [low, high]] of Object.entries(limits)) {
    const value = params?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
      throw Error(`${key} must be between ${low} and ${high}.`);
    }
    s[key] = Math.round(value * 100) / 100;
  }
  const cooled = params?.cooled ?? null;
  if (cooled !== null && (!Number.isFinite(cooled) || cooled < 0)) {
    throw Error('Enter a nonnegative bed cooldown threshold or leave it blank.');
  }
  s.cooled = cooled === 0 ? null : cooled;
  if (s.right < s.left || s.back <= s.front || s.lift < s.contact + 15) {
    throw Error('Use left ≤ right, back Y > front Y, and travel Z at least 15 mm above contact Z.');
  }
  const lanes = [s.left];
  const laneCount = Math.ceil((s.right - s.left) / s.pitch);
  for (let i = 1; i <= laneCount; i++) lanes.push(Math.round((s.left + (s.right - s.left) * i / laneCount) * 100) / 100);
  const workingZ = air ? s.lift - 5 : s.contact;
  const points = [{ z: s.lift, feed: 600 }];
  for (const x of lanes) {
    points.push(
      { x, y: s.back, feed: 1200 },
      { z: workingZ, feed: 300 },
      { y: s.front, feed: s.speed },
      { z: s.lift, feed: 600 },
    );
  }
  return { parameters: s, lanes, points };
}
