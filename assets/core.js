/* =============================================================================
 * core.js — 纯逻辑层（无 DOM 依赖）
 * 事件溯源：所有状态变更都写一条事件，事件带 hash 链（篡改可检测）
 * 可在 node 里直接 import 做测试
 * ========================================================================== */

export const APP_ID = 'ctdp-rsip';
export const VERSION = 1;
export const STORAGE_KEY = 'ctdp.state.v1';
export const HABIT_TARGET_DAYS = 21;

/* ---------- 小工具 ---------- */

export const uid = (p = 'id') =>
  p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const pad2 = (n) => String(n).padStart(2, '0');

/** FNV-1a 32bit：够用的“防手滑”哈希，不是密码学 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 以 dayStart 点为界的“作战日”，深夜算前一天 */
export function dayKey(ts = Date.now(), dayStart = 4) {
  const d = new Date(ts);
  d.setHours(d.getHours() - dayStart);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fmtClock(ms) {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(ss)}` : `${pad2(m)}:${pad2(ss)}`;
}

export function fmtHM(ts) {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDate(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

export function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

/* ---------- 初始状态 ---------- */

export function blankState() {
  return {
    app: APP_ID,
    v: VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings: { dayStart: 4, auxMinutes: 15, secondSignal: true, ritual: true, sound: true },
    rev: 0,
    chains: [],
    precedents: [],
    policies: [],
    settlements: {},
    freezes: [],
    wins: [],
    events: [],
    lastPolicyDay: null,
    deleted: { chains: {}, policies: {} },
    sync: { sha: null, at: 0, rev: 0 },
    seen: false,
  };
}

/** 首次启动的起步包：预设三被动 + 一链，全部可改 */
export function seedState() {
  const s = blankState();
  const cid = uid('ch');
  s.chains.push({
    id: cid,
    name: '突击',
    anchor: '深呼吸三次，戴上降噪耳机',
    auxSignal: '打一个响指',
    auxSignal2: '连打三次响指',
    minutes: 60,
    tier: 'elite',
    kind: 'assault',
    nodes: [],
    resets: [],
    running: null,
    aux: null,
    createdAt: Date.now(),
  });
  const mk = (title, type, cond, trigger, parentId = null, extra = {}) => ({
    id: uid('pl'),
    title,
    type,
    cond,
    trigger,
    parentId,
    state: 'lit',
    daysLit: 0,
    level: 0,
    childrenOpen: true,
    createdAt: Date.now(),
    ...extra,
  });
  const p1 = mk('先发制人', 'passive', '起床后 30 分钟内不使用娱乐类 App', '起床', null);
  const p2 = mk('夜幕降临', 'mech', '23:00–07:00 屏幕黑白（系统自动化，此处只做结算）', '23:00', p1.id);
  const p3 = mk('快速打扫', 'semi', '在家吃完饭立刻洗碗', '吃完饭', p2.id);
  const p4 = mk('水密隔舱', 'mech', '生病/出差/突发事件可冻结，到期一次性补', '不可抗力', null);
  s.policies = [p1, p2, p3, p4];
  return s;
}

/* ---------- 选择器 ---------- */

export const policyById = (state, id) => state.policies.find((p) => p.id === id) || null;
export const chainById = (state, id) => state.chains.find((c) => c.id === id) || null;

export const childrenOf = (state, id) =>
  state.policies.filter((p) => p.parentId === id);

export function descendantIds(state, id) {
  const out = [];
  const walk = (pid) => {
    for (const c of state.policies) {
      if (c.parentId === pid) {
        out.push(c.id);
        walk(c.id);
      }
    }
  };
  walk(id);
  return out;
}

export function depthOf(state, p) {
  let d = 0;
  let cur = p;
  const seen = new Set();
  while (cur && cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = policyById(state, cur.parentId);
    d++;
  }
  return d;
}

/** 主链下一个节点编号：#1 起 */
export const nextN = (c) => (c ? c.nodes.length + 1 : 0);

export const isRunning = (c) => !!(c && c.running);

export function elapsedOf(c, now = Date.now()) {
  if (!c || !c.running) return 0;
  return now - c.running.start;
}

export const habitPct = (p) => clamp(((p.daysLit || 0) / HABIT_TARGET_DAYS) * 100, 0, 100);

/** 树形展开顺序（深度优先，父在前） */
export function treeOrder(state) {
  const out = [];
  const roots = state.policies.filter((p) => !p.parentId || !policyById(state, p.parentId));
  const walk = (p, d) => {
    out.push({ p, depth: d });
    if (p.childrenOpen === false) return;
    const kids = state.policies.filter((k) => k.parentId === p.id);
    kids.sort((a, b) => a.createdAt - b.createdAt).forEach((k) => walk(k, d + 1));
  };
  roots.sort((a, b) => a.createdAt - b.createdAt).forEach((p) => walk(p, 0));
  return out;
}

/** 相似判例（按汉字二元组重合度） */
export function similarPrecedents(state, chainId, behavior, limit = 3) {
  const q = String(behavior || '').replace(/\s/g, '');
  if (q.length < 2) return [];
  const grams = new Set();
  for (let i = 0; i < q.length - 1; i++) grams.add(q.slice(i, i + 2));
  const scored = state.precedents
    .filter((p) => p.chainId === chainId || p.scope === 'global')
    .map((p) => {
      const t = String(p.behavior).replace(/\s/g, '');
      let hit = 0;
      for (let i = 0; i < t.length - 1; i++) if (grams.has(t.slice(i, i + 2))) hit++;
      const score = hit / Math.max(1, grams.size) + (t.includes(q) || q.includes(t) ? 0.5 : 0);
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function stats(state) {
  let nodes = 0;
  let ms = 0;
  for (const c of state.chains) {
    nodes += c.nodes.length;
    for (const n of c.nodes) ms += Math.max(0, n.end - n.start);
  }
  return {
    nodes,
    hours: ms / 3600000,
    longest: state.chains.reduce((m, c) => Math.max(m, c.nodes.length), 0),
    resets: state.chains.reduce((m, c) => m + c.resets.length, 0),
    precedents: state.precedents.length,
    lit: state.policies.filter((p) => p.state === 'lit').length,
    stock: state.policies.filter((p) => p.state === 'stock').length,
    wins: state.wins.length,
    freezes: state.freezes.filter((f) => !f.resolvedAt).length,
  };
}

/* ---------- 账本 ---------- */

export class Ledger {
  constructor(state, { save = null } = {}) {
    this.state = state;
    this._save = save;
  }

  static load(raw, opts) {
    let st = null;
    try {
      st = raw ? JSON.parse(raw) : null;
    } catch (e) {
      st = null;
    }
    if (!st || st.app !== APP_ID) st = seedState();
    // 兼容旧字段
    st.settings = { dayStart: 4, auxMinutes: 15, secondSignal: true, ritual: true, sound: true, ...(st.settings || {}) };
    st.rev = st.rev || 0;
    st.updatedAt = st.updatedAt || st.createdAt || Date.now();
    st.deleted = st.deleted && typeof st.deleted === 'object' ? st.deleted : { chains: {}, policies: {} };
    st.deleted.chains = st.deleted.chains && typeof st.deleted.chains === 'object' ? st.deleted.chains : {};
    st.deleted.policies = st.deleted.policies && typeof st.deleted.policies === 'object' ? st.deleted.policies : {};
    st.sync = st.sync || { sha: null, at: 0, rev: 0 };
    for (const c of st.chains) {
      c.nodes = c.nodes || [];
      c.resets = c.resets || [];
      c.running = c.running || null;
      c.aux = c.aux || null;
      c.pending = c.pending || null;
      c.auxSignal = c.auxSignal || '';
      c.auxSignal2 = c.auxSignal2 || '';
    }
    for (const key of ['precedents', 'policies', 'freezes', 'wins', 'events']) st[key] = st[key] || [];
    st.settlements = st.settlements || {};
    return new Ledger(st, opts);
  }

  save() {
    if (this._save) this._save(JSON.stringify(this.state));
  }

  _log(type, payload = {}) {
    const ev = { seq: this.state.events.length + 1, at: Date.now(), type, ...payload };
    const prev = this.state.events[this.state.events.length - 1];
    ev.h = fnv1a((prev ? prev.h : '00000000') + JSON.stringify({ ...ev, h: undefined }));
    this.state.events.push(ev);
    if (this.state.events.length > 20000) {
      // 裁掉最老的 2000 条后必须重算序号/哈希，否则 verify() 会误报“账本被改过”
      this.state.events.splice(0, 2000);
      let prevHash = '00000000';
      for (let i = 0; i < this.state.events.length; i++) {
        const e = this.state.events[i];
        e.seq = i + 1;
        e.h = fnv1a(prevHash + JSON.stringify({ ...e, h: undefined }));
        prevHash = e.h;
      }
    }
    return ev;
  }

  _commit(type, payload) {
    this.state.rev = (this.state.rev || 0) + 1;
    this.state.updatedAt = Date.now();
    this._log(type, payload);
    this.save();
  }

  /** 本地直接改完状态后调用：落盘并打上时间戳，但不新增事件 */
  touch() {
    this.state.updatedAt = Date.now();
    this.save();
  }

  /* ----- 主链 ----- */

  addChain({
    name,
    anchor,
    auxSignal = '',
    auxSignal2 = '',
    minutes = 60,
    tier = 'normal',
    kind = 'assault',
  }) {
    const c = {
      id: uid('ch'),
      name: String(name || '').trim() || '未命名链',
      anchor: String(anchor || '').trim(),
      auxSignal: String(auxSignal || '').trim(),
      auxSignal2: String(auxSignal2 || '').trim(),
      minutes: clamp(Number(minutes) || 60, 1, 600),
      tier,
      kind,
      nodes: [],
      resets: [],
      running: null,
      aux: null,
      createdAt: Date.now(),
    };
    this.state.chains.push(c);
    this._commit('chain.create', { id: c.id, name: c.name });
    return c;
  }

  updateChain(id, patch) {
    const c = chainById(this.state, id);
    if (!c) return false;
    Object.assign(c, patch);
    this._commit('chain.update', { id, patch });
    return true;
  }

  /** 删除主链：写墓碑，防止另一台设备同步时把它复活 */
  deleteChain(id) {
    const c = chainById(this.state, id);
    if (!c) return false;
    this.state.deleted = this.state.deleted || { chains: {}, policies: {} };
    this.state.deleted.chains[id] = Date.now();
    this.state.chains = this.state.chains.filter((x) => x.id !== id);
    this._commit('chain.delete', { id });
    return true;
  }

  start(id, now = Date.now()) {
    const c = chainById(this.state, id);
    if (!c || c.running) return false;
    c.running = { start: now, n: nextN(c), kind: c.kind };
    c.aux = null;
    c.pending = null;
    this._commit('chain.start', { id, n: c.running.n });
    return true;
  }

  /** 完成一个节点；未满时长需 force */
  complete(id, { force = false, now = Date.now() } = {}) {
    const c = chainById(this.state, id);
    if (!c || !c.running) return { ok: false, reason: 'not-running' };
    const target = c.minutes * 60000;
    const took = now - c.running.start;
    if (took < target && !force) return { ok: false, reason: 'short', left: target - took };
    const n = { n: c.nodes.length + 1, start: c.running.start, end: now, kind: c.running.kind };
    c.nodes.push(n);
    c.running = null;
    this._commit('chain.complete', { id, n: n.n, took });
    return { ok: true, n: n.n };
  }

  /** 中断 → 立即进入判定；这里只负责收起 running，不判 */
  pause(id, now = Date.now()) {
    const c = chainById(this.state, id);
    if (!c || !c.running) return null;
    const info = { start: c.running.start, end: now, took: now - c.running.start };
    c.running = null;
    c.pending = info; // 悬置：等一个判决，不判就一直挂在那里
    this._commit('chain.pause', { id, took: info.took });
    return info;
  }

  /* ----- 预约（辅助链） ----- */

  arm(id, now = Date.now()) {
    const c = chainById(this.state, id);
    if (!c) return false;
    const win = (this.state.settings.auxMinutes || 15) * 60000;
    // 二次信号：只有这一条链设了「即时启动信号」才启用
    c.aux = { armedAt: now, dueAt: now + win, firedAt: null, stage2: false, second: !!c.auxSignal2 };
    this._commit('aux.arm', { id, dueAt: c.aux.dueAt });
    return true;
  }

  disarm(id) {
    const c = chainById(this.state, id);
    if (!c || !c.aux) return false;
    c.aux = null;
    this._commit('aux.disarm', { id });
    return true;
  }

  fireAux(id, now = Date.now()) {
    const c = chainById(this.state, id);
    if (!c || !c.aux) return false;
    c.aux = null;
    return this.start(id, now);
  }

  /* ----- 判定（下必为例） ----- */

  /**
   * decision: 'allow' | 'deny'
   * allow → 写入永久判例，链保持
   * deny  → 链清零，回到 #1
   */
  judge({ chainId, behavior, decision, note = '', now = Date.now() }) {
    const c = chainById(this.state, chainId);
    if (!c) return { ok: false, reason: 'no-chain' };
    const text = String(behavior || '').trim() || '未描述的行为';
    c.pending = null;
    this.state.precedents.push({
      id: uid('pc'),
      chainId,
      behavior: text,
      decision,
      note,
      at: now,
    });
    if (decision === 'allow') {
      this._commit('judgement.allow', { chainId, behavior: text });
      return { ok: true, reset: false };
    }
    const cleared = c.nodes.length;
    c.resets.push({ at: now, reason: text, cleared });
    c.nodes = [];
    c.running = null;
    c.aux = null;
    this._commit('judgement.deny', { chainId, behavior: text, cleared });
    return { ok: true, reset: true, cleared };
  }

  /** 无判例的直接清零（例如超时未启动） */
  reset(chainId, reason = '未说明', now = Date.now()) {
    const c = chainById(this.state, chainId);
    if (!c) return false;
    const cleared = c.nodes.length;
    c.resets.push({ at: now, reason, cleared });
    c.nodes = [];
    c.running = null;
    c.aux = null;
    c.pending = null;
    this._commit('chain.reset', { chainId, reason, cleared });
    return true;
  }

  /* ----- 国策树 ----- */

  addPolicy({ title, type = 'passive', cond = '', trigger = '', parentId = null, isGroup = false, quota = 0, now = Date.now() }) {
    const today = dayKey(now, this.state.settings.dayStart);
    if (this.state.lastPolicyDay === today) {
      return { ok: false, reason: 'daily-limit' };
    }
    const p = {
      id: uid('pl'),
      title: String(title || '').trim() || '未命名国策',
      type,
      cond: String(cond || '').trim(),
      trigger: String(trigger || '').trim(),
      parentId: parentId || null,
      state: 'lit',
      daysLit: 0,
      level: 0,
      childrenOpen: true,
      isGroup,
      quota: isGroup ? clamp(Number(quota) || 1, 1, 20) : 0,
      createdAt: now,
    };
    this.state.policies.push(p);
    this.state.lastPolicyDay = today;
    this._commit('policy.create', { id: p.id, title: p.title, parentId: p.parentId });
    return { ok: true, policy: p };
  }

  levelUp(id) {
    const p = policyById(this.state, id);
    if (!p) return false;
    p.level = (p.level || 0) + 1;
    this._commit('policy.levelup', { id, level: p.level });
    return true;
  }

  levelDown(id) {
    const p = policyById(this.state, id);
    if (!p) return false;
    p.level = Math.max(0, (p.level || 0) - 1);
    this._commit('policy.leveldown', { id, level: p.level });
    return true;
  }

  /** 熄灭并级联；内化进度（daysLit）保留在国策库里 */
  extinguish(id, reason = 'manual') {
    const p = policyById(this.state, id);
    if (!p) return [];
    const ids = [id, ...descendantIds(this.state, id)];
    const hit = [];
    for (const pid of ids) {
      const q = policyById(this.state, pid);
      if (q && q.state !== 'stock') {
        q.state = 'stock';
        q.clearedAt = Date.now();
        hit.push(pid);
      }
    }
    this._commit('policy.extinguish', { id, reason, ids: hit });
    return hit;
  }

  /** 从国策库重新点亮（不恢复子节点，需手动） */
  restore(id) {
    const p = policyById(this.state, id);
    if (!p) return false;
    p.state = 'lit';
    p.clearedAt = null;
    this._commit('policy.restore', { id });
    return true;
  }

  /** 删除国策（连后代）：写墓碑，防止另一台设备同步时复活 */
  deletePolicy(id) {
    const p = policyById(this.state, id);
    if (!p) return false;
    const ids = [id, ...descendantIds(this.state, id)];
    this.state.deleted = this.state.deleted || { chains: {}, policies: {} };
    const now = Date.now();
    for (const pid of ids) this.state.deleted.policies[pid] = now;
    this.state.policies = this.state.policies.filter((x) => !ids.includes(x.id));
    this._commit('policy.delete', { ids });
    return ids;
  }

  /** 日结算：默认全亮，只报“崩了”的 */
  settle(date, brokenIds = [], note = '') {
    for (const id of brokenIds) {
      const p = policyById(this.state, id);
      if (p && (p.state === 'lit' || p.state === 'frozen')) this.extinguish(id, 'settle');
    }
    // 国策组：亮着的成员数不足配额 → 组灭并级联
    const groups = this.state.policies.filter((p) => p.isGroup && p.state === 'lit');
    groups.sort((a, b) => depthOf(this.state, b) - depthOf(this.state, a));
    for (const g of groups) {
      const kids = childrenOf(this.state, g.id);
      const lit = kids.filter((k) => k.state === 'lit' || k.state === 'frozen').length;
      const quota = g.quota || Math.max(1, kids.length - 1);
      if (kids.length > 0 && lit < quota) this.extinguish(g.id, 'group-quota');
    }
    for (const p of this.state.policies) {
      if (p.state === 'lit') {
        p.daysLit = (p.daysLit || 0) + 1;
        p.lastEval = date;
      }
    }
    this.state.settlements[date] = { brokenIds, note, at: Date.now() };
    this._commit('settle', { date, brokenIds });
    return true;
  }

  /* ----- 水密隔舱 ----- */

  freeze({ scopeIds = null, days = 1, note = '', now = Date.now() } = {}) {
    const end = now + days * 86400000;
    const ids = scopeIds && scopeIds.length
      ? scopeIds.flatMap((id) => [id, ...descendantIds(this.state, id)])
      : this.state.policies.map((p) => p.id);
    for (const id of ids) {
      const p = policyById(this.state, id);
      if (p && p.state === 'lit') p.state = 'frozen';
    }
    const f = { id: uid('fz'), ids, start: now, deadline: end, note, resolvedAt: null };
    this.state.freezes.push(f);
    this._commit('freeze.start', { id: f.id, ids, deadline: end });
    return f;
  }

  resolveFreeze(id, brokenIds = [], now = Date.now()) {
    const f = this.state.freezes.find((x) => x.id === id);
    if (!f || f.resolvedAt) return false;
    for (const pid of f.ids) {
      const p = policyById(this.state, pid);
      if (!p || p.state !== 'frozen') continue;
      if (brokenIds.includes(pid)) {
        p.state = 'stock';
        p.clearedAt = now;
      } else {
        p.state = 'lit';
        p.daysLit = (p.daysLit || 0) + 1;
      }
    }
    f.resolvedAt = now;
    f.result = brokenIds;
    this._commit('freeze.resolve', { id, brokenIds });
    return true;
  }

  /* ----- 赢麻了 ----- */

  addWin({ title, grade = 'small', date = null, now = Date.now() }) {
    const w = {
      id: uid('wn'),
      date: date || dayKey(now, this.state.settings.dayStart),
      title: String(title || '').trim() || '无名之日',
      grade,
      at: now,
    };
    this.state.wins.unshift(w);
    this._commit('win.log', { id: w.id, title: w.title, grade });
    return w;
  }

  /* ----- 完整性 ----- */

  verify() {
    let prev = '00000000';
    for (let i = 0; i < this.state.events.length; i++) {
      const ev = this.state.events[i];
      const want = fnv1a(prev + JSON.stringify({ ...ev, h: undefined }));
      if (want !== ev.h) return { ok: false, index: i, seq: ev.seq };
      prev = ev.h;
    }
    return { ok: true, count: this.state.events.length };
  }

  /* ----- 导出 ----- */

  toJSON() {
    return JSON.stringify(this.state, null, 2);
  }

  exportMarkdown(now = Date.now()) {
    const st = this.state;
    const s = stats(st);
    const L = [];
    L.push(`# 作战档案 · ${fmtDate(now)}`);
    L.push('');
    L.push(`> 主链 ${st.chains.length} 条 · 节点 ${s.nodes} · 累计 ${s.hours.toFixed(1)}h · 判例 ${s.precedents} · 点亮国策 ${s.lit}`);
    L.push('');
    L.push('## 主链');
    for (const c of st.chains) {
      const tier = c.tier === 'elite' ? '精锐' : '普通';
      L.push(`- **${c.name}**（${tier}）→ #${nextN(c)}${c.anchor ? ` · 锚点：${c.anchor}` : ''}`);
      L.push(`  - 节点 ${c.nodes.length} · 崩塌 ${c.resets.length}${c.resets.length ? ` · 最近：${c.resets[c.resets.length - 1].reason}` : ''}`);
    }
    L.push('');
    L.push('## 国策树');
    for (const { p, depth } of treeOrder(st)) {
      const mark = p.state === 'lit' ? '▣' : p.state === 'frozen' ? '▨' : '▢';
      const typeMap = { passive: '被动', semi: '半被动', active: '主动', mech: '机制' };
      L.push(`${'  '.repeat(depth)}- ${mark} ${p.title}（${typeMap[p.type] || '被动'}${p.level ? ` +${p.level}` : ''}）· ${p.daysLit || 0} 天`);
      if (p.cond) L.push(`${'  '.repeat(depth + 1)}  - ${p.cond}`);
    }
    L.push('');
    if (st.precedents.length) {
      L.push('## 判例（下必为例）');
      for (const p of st.precedents.slice(-30)) {
        const c = chainById(st, p.chainId);
        L.push(`- ${fmtHM(p.at)} ${p.decision === 'allow' ? '准' : '驳'}｜${p.behavior}｜${c ? c.name : '—'}`);
      }
      L.push('');
    }
    if (st.wins.length) {
      L.push('## 赢麻了');
      for (const w of st.wins.slice(0, 20)) {
        const g = { small: '小赢', mid: '中赢', big: '大赢' }[w.grade] || '小赢';
        L.push(`- ${w.date}（${g}）${w.title}`);
      }
      L.push('');
    }
    L.push('---');
    L.push(`生成于 ${fmtHM(now)} · 账本事件 ${st.events.length} 条 · 哈希链${this.verify().ok ? '完整' : '异常'}`);
    return L.join('\n');
  }
}
