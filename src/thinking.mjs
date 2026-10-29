// The Harness decides which thinking levels exist for the run. Pi only
// announces a level the member picked (`thinking_level_select`), so a level the
// Harness does not allow is put back: to the one before when that is allowed,
// else to the nearest allowed one (spike I4).
import { nearestLevel } from './manifest.mjs';

export function createThinkingGuard(pi, { allowed, log = () => {} }) {
  let busy = false;
  const correct = level => {
    const list = allowed();
    return !Array.isArray(list) || list.length === 0 || list.includes(level) ? level : nearestLevel(level, list);
  };
  // Sets a level the Harness chose (the run's effort); never recursed into.
  const force = level => {
    const target = correct(level);
    busy = true;
    try { if (pi.getThinkingLevel() !== target) pi.setThinkingLevel(target); } finally { busy = false; }
    return target;
  };
  const onSelect = event => {
    if (busy) return;
    const list = allowed();
    if (!Array.isArray(list) || list.length === 0 || list.includes(event.level)) return;
    const back = list.includes(event.previousLevel) ? event.previousLevel : nearestLevel(event.level, list);
    busy = true;
    try { pi.setThinkingLevel(back); } finally { busy = false; }
    log({ kind: 'thinking_reverted', asked: event.level, now: back });
  };
  return { force, onSelect, correct };
}
