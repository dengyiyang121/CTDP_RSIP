/* =============================================================================
 * sound.js — 到点提示音
 * 用 WebAudio 现场合成，不带音频文件；起链时按绝对时间排程，
 * 即使之后切到后台，只要音频上下文还活着就会响。
 *
 * 0.5.1：加大音量、换成更尖锐的方波；加压缩器防破音；
 *         预约/任务都排「剩 30 秒」和「到点」两声；加 keep-alive 与
 *         resume watchdog，尽量避免切后台后排程失效。
 * ========================================================================== */

let ctx = null;
let master = null;
let keep = null;
const groups = new Map(); // tag -> [oscillator]
const timers = new Map(); // tag -> watchdog timer
const MAX_TIMEOUT = 2147483000;

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();

  master = ctx.createGain();
  master.gain.value = 0.95;

  // 方波叠起来容易削波；阈值放在 -6 dB，只削峰，不把整体音量压小
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -6;
  comp.knee.value = 0;
  comp.ratio.value = 12;
  comp.attack.value = 0.003;
  comp.release.value = 0.2;

  master.connect(comp);
  comp.connect(ctx.destination);
  return ctx;
}

/** 一个几乎听不见的低频振荡，用来让音频上下文保持活着 */
function startKeepAlive() {
  if (keep || !ctx) return;
  try {
    keep = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.00005;
    keep.frequency.value = 20;
    keep.connect(g);
    g.connect(master);
    keep.start();
  } catch (e) {
    keep = null;
  }
}

/** 必须在用户手势里调用一次，否则移动端不允许出声 */
export function unlock() {
  const c = ensure();
  if (!c) return false;
  if (c.state !== 'running') c.resume().catch(() => {});
  startKeepAlive();
  return c.state === 'running';
}

export function resume() {
  if (!ctx) return false;
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  return ctx.state === 'running';
}

export function ready() {
  return !!ctx && ctx.state === 'running';
}

/** 音频上下文是否已经建过（没建就不排程，免得浏览器报警） */
export function has() {
  return !!ctx;
}

/** 调试 / 测试：当前音频状态和已排程的 tag */
export function state() {
  return { has: !!ctx, ready: ready(), state: ctx ? ctx.state : 'none', master: master ? master.gain.value : 0 };
}
export function pending() {
  return [...groups.keys()];
}

function tone(at, freq, dur, type, gain, endFreq = 0) {
  const c = ensure();
  if (!c) return null;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (endFreq > 0) o.frequency.exponentialRampToValueAtTime(endFreq, at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.006); // 短促起音，听起来更“尖”
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g);
  g.connect(master);
  o.start(at);
  o.stop(at + dur + 0.03);
  return o;
}

/**
 * 四种提示音：
 *  warn  剩 30 秒：两短一高
 *  due   预约到点：高低交替五声，最急
 *  done  结链：上行三音，响亮但不刺耳
 *  tick  兼容旧调用（等同 warn）
 */
function playAt(kind, at) {
  const nodes = [];
  if (kind === 'done') {
    nodes.push(tone(at, 880, 0.12, 'square', 0.5));
    nodes.push(tone(at, 1760, 0.12, 'sine', 0.32));
    nodes.push(tone(at + 0.14, 1174.66, 0.14, 'square', 0.55));
    nodes.push(tone(at + 0.3, 1567.98, 0.34, 'square', 0.55));
    nodes.push(tone(at + 0.3, 783.99, 0.34, 'sine', 0.36));
  } else if (kind === 'due') {
    for (let i = 0; i < 5; i++) {
      const f = i % 2 ? 1318.51 : 1760;
      nodes.push(tone(at + i * 0.16, f, 0.11, 'square', 0.6));
      nodes.push(tone(at + i * 0.16, f / 2, 0.11, 'sawtooth', 0.22));
    }
  } else {
    // warn / tick
    nodes.push(tone(at, 1567.98, 0.09, 'square', 0.55));
    nodes.push(tone(at + 0.12, 1567.98, 0.09, 'square', 0.55));
    nodes.push(tone(at + 0.24, 2093, 0.2, 'square', 0.6, 2350));
  }
  return nodes.filter(Boolean);
}

function cleanup(tag) {
  const t = timers.get(tag);
  if (t) {
    clearTimeout(t);
    timers.delete(tag);
  }
}

function stopNodes(tag) {
  const nodes = groups.get(tag);
  cleanup(tag);
  cleanup(tag + ':gc');
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

export function chime(kind = 'done') {
  const c = ensure();
  if (!c) return false;
  if (c.state !== 'running') c.resume().catch(() => {});
  startKeepAlive();
  playAt(kind, c.currentTime + 0.02);
  return true;
}

/**
 * 预约一个将来会响的提示音
 * @returns {boolean} 是否排程成功（音频未解锁时返回 false）
 */
export function schedule(kind, delaySec, tag) {
  if (!ctx) return false;
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  stopNodes(tag);

  const delay = Math.max(0.05, Number(delaySec) || 0);
  const at = ctx.currentTime + delay;
  const nodes = playAt(kind, at);
  if (!nodes.length) return false;

  groups.set(tag, nodes);
  startKeepAlive();

  // watchdog：如果到点时上下文被系统挂起了，主动 resume，让排好的音立刻补响
  const ms = Math.min(MAX_TIMEOUT, Math.max(0, (at - ctx.currentTime) * 1000 + 50));
  const t = setTimeout(() => {
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }, ms);
  timers.set(tag, t);

  // 响完之后把 tag 清掉，避免无限堆积
  const g = setTimeout(() => {
    if (groups.get(tag) === nodes) groups.delete(tag);
    timers.delete(tag);
  }, Math.min(MAX_TIMEOUT, ms + 5000));
  timers.set(tag + ':gc', g);

  return true;
}

export function cancel(tag) {
  stopNodes(tag);
}

export function cancelAll() {
  for (const tag of [...groups.keys()]) stopNodes(tag);
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
