/* =============================================================================
 * sound.js — 到点提示音
 * 用 WebAudio 现场合成，不带音频文件；起链时按绝对时间排程，
 * 即使之后切到后台，只要音频上下文还活着就会响。
 * ========================================================================== */

let ctx = null;
let master = null;
const groups = new Map(); // tag -> [oscillator]

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.32;
  master.connect(ctx.destination);
  return ctx;
}

/** 必须在用户手势里调用一次，否则移动端不允许出声 */
export function unlock() {
  const c = ensure();
  if (!c) return false;
  if (c.state === 'suspended') c.resume().catch(() => {});
  return c.state === 'running';
}

export function ready() {
  return !!ctx && ctx.state === 'running';
}

/** 音频上下文是否已经建过（没建就不排程，免得浏览器报警） */
export function has() {
  return !!ctx;
}

function tone(at, freq, dur, type, gain) {
  const c = ensure();
  if (!c) return null;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g);
  g.connect(master);
  o.start(at);
  o.stop(at + dur + 0.03);
  return o;
}

/** 三种提示音：done（结链）、due（预约到点）、tick（第二段提醒） */
function playAt(kind, at) {
  const nodes = [];
  if (kind === 'done') {
    nodes.push(tone(at, 659.25, 0.16, 'sine', 0.5));
    nodes.push(tone(at + 0.15, 880, 0.18, 'sine', 0.5));
    nodes.push(tone(at + 0.33, 1174.66, 0.3, 'sine', 0.42));
  } else if (kind === 'due') {
    for (let i = 0; i < 3; i++) nodes.push(tone(at + i * 0.18, 523.25, 0.1, 'square', 0.16));
  } else {
    nodes.push(tone(at, 880, 0.1, 'triangle', 0.3));
  }
  return nodes.filter(Boolean);
}

export function chime(kind = 'done') {
  const c = ensure();
  if (!c) return;
  unlock();
  if (c.state !== 'running') return;
  playAt(kind, c.currentTime + 0.02);
}

/**
 * 预约一个将来会响的提示音
 * @returns {boolean} 是否排程成功（音频未解锁时返回 false）
 */
export function schedule(kind, delaySec, tag) {
  if (!ctx) return false;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  cancel(tag);
  const nodes = playAt(kind, ctx.currentTime + Math.max(0.05, delaySec));
  if (nodes.length) groups.set(tag, nodes);
  return true;
}

export function cancel(tag) {
  const nodes = groups.get(tag);
  if (!nodes) return;
  for (const n of nodes) {
    try {
      n.stop();
    } catch (e) {
      /* 已经停了 */
    }
  }
  groups.delete(tag);
}

export function cancelAll() {
  for (const tag of [...groups.keys()]) cancel(tag);
}
