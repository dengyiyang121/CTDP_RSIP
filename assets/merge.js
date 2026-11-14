/* =============================================================================
 * merge.js — 自动合并两份账本（纯函数，无 DOM）
 *
 * 目标：两台设备各改各的之后，不需要人做选择，也能得到同一份结果。
 *
 * 规则：
 *  - 追加型集合（判例、喜报、冻结、结算、事件）取并集，永不丢。
 *  - 同一条链：节点/崩塌取并集；最近一次清零之后的节点才算数；运行态取较新那台。
 *  - 同一个国策：内化天数取较大值（避免两台设备同一天结算造成双倍），
 *    其余字段取较新那台。
 *  - 删除用墓碑（deleted）传播，取并集删除，避免“删了又被另一边复活”。
 *  - 事件按时间排序后重算序号和哈希链，合并完 verify() 仍然通过。
 *  - 内容指纹排序 key 后计算，所以字段顺序不同不影响判等；sync/rev/updatedAt
 *    这些本机元数据不参与判等。
 * ========================================================================== */

import { APP_ID, fnv1a } from './core.js';

const META_KEYS = new Set(['sync', 'rev', 'updatedAt', 'lastExportAt']);

/* ---------- 指纹 ---------- */

/** 稳定序列化：对象 key 排序，数组保持顺序 */
export function stable(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** 内容指纹：本机元数据不参与，两台设备同样的内容 → 同样的指纹 */
export function stateDigest(state) {
  const o = {};
  for (const k of Object.keys(state || {})) if (!META_KEYS.has(k)) o[k] = state[k];
  return fnv1a(stable(o));
}

/** 最近一次“有内容”的动作时间，用来判断哪边更新 */
export function activityOf(state) {
  let t = state.updatedAt || 0;
  const bump = (v) => {
    if (typeof v === 'number' && v > t) t = v;
  };
  for (const e of state.events || []) bump(e.at);
  for (const w of state.wins || []) bump(w.at);
  for (const p of state.precedents || []) bump(p.at);
  for (const f of state.freezes || []) bump(f.resolvedAt || f.start);
  for (const s of Object.values(state.settlements || {})) bump(s && s.at);
  for (const c of state.chains || []) {
    for (const n of c.nodes || []) bump(n.end);
    for (const r of c.resets || []) bump(r.at);
  }
  return t || state.createdAt || 0;
}

/* ---------- 小工具 ---------- */

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const arr = (x) => (Array.isArray(x) ? x : []);
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});

function tombstones(s) {
  const d = obj(s.deleted);
  return { chains: obj(d.chains), policies: obj(d.policies) };
}

function latestReset(c) {
  let t = 0;
  for (const r of c.resets || []) if ((r.at || 0) > t) t = r.at;
  return t;
}

/** 判断 big 是否在“内容上”包含 small（用于一边明显是另一边旧版的情况） */
export function covers(big, small) {
  const ids = (list) => new Set(arr(list).map((x) => x && x.id));
  const sub = (a, b) => [...ids(b)].every((id) => ids(a).has(id));

  if (!sub(big.chains, small.chains)) return false;
  if (!sub(big.policies, small.policies)) return false;
  if (!sub(big.precedents, small.precedents)) return false;
  if (!sub(big.wins, small.wins)) return false;
  if (!sub(big.freezes, small.freezes)) return false;

  const tb = tombstones(big);
  const ts = tombstones(small);
  for (const k of ['chains', 'policies']) {
    for (const id of Object.keys(ts[k])) if (!(id in tb[k])) return false;
  }

  const smallSettled = Object.keys(small.settlements || {});
  for (const d of smallSettled) if (!(d in (big.settlements || {}))) return false;

  // 事件：按内容 key 比，不看序号/哈希
  const ek = new Set(arr(big.events).map(eventKey));
  for (const e of arr(small.events)) if (!ek.has(eventKey(e))) return false;

  // 节点和崩塌
  for (const sc of arr(small.chains)) {
    const bc = arr(big.chains).find((c) => c.id === sc.id);
    if (!bc) return false;
    const bn = new Set(arr(bc.nodes).map(nodeKey));
    for (const n of arr(sc.nodes)) if (!bn.has(nodeKey(n))) return false;
    const br = new Set(arr(bc.resets).map(resetKey));
    for (const r of arr(sc.resets)) if (!br.has(resetKey(r))) return false;
  }
  return true;
}

const nodeKey = (n) => `${n.start}|${n.end}`;
const resetKey = (r) => `${r.at}|${r.reason || ''}|${r.cleared || 0}`;

function eventKey(e) {
  const { seq, h, ...rest } = e || {};
  return `${e && e.at}|${e && e.type}|${stable(rest)}`;
}

function isBlank(s) {
  const events = arr(s.events).filter((e) => e && e.type !== 'app.seen');
  const nodes = arr(s.chains).reduce((n, c) => n + arr(c.nodes).length, 0);
  const resets = arr(s.chains).reduce((n, c) => n + arr(c.resets).length, 0);
  const tb = tombstones(s);
  const deletes = Object.keys(tb.chains).length + Object.keys(tb.policies).length;
  return (
    events.length === 0 &&
    nodes === 0 &&
    resets === 0 &&
    deletes === 0 &&
    arr(s.precedents).length === 0 &&
    arr(s.wins).length === 0
  );
}

/* ---------- 事件合并 ---------- */

export function mergeEvents(a, b) {
  const map = new Map();
  for (const e of [...arr(a), ...arr(b)]) {
    if (!e || typeof e !== 'object') continue;
    const k = eventKey(e);
    if (!map.has(k)) map.set(k, e);
  }
  let list = [...map.values()].sort((x, y) => {
    const dt = (x.at || 0) - (y.at || 0);
    if (dt) return dt;
    const kx = eventKey(x);
    const ky = eventKey(y);
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
  // 旧账本有 2 万条上限；合并后超出就保留最近的，再整体重算哈希，保证 verify() 通过
  if (list.length > 20000) list = list.slice(list.length - 20000);

  let prev = '00000000';
  return list.map((e, i) => {
    const { seq, h, ...rest } = e;
    const ev = { seq: i + 1, ...rest };
    ev.h = fnv1a(prev + JSON.stringify({ ...ev, h: undefined }));
    prev = ev.h;
    return ev;
  });
}

/* ---------- 实体合并 ---------- */

function dedupe(list, key) {
  const map = new Map();
  for (const x of arr(list)) {
    if (!x) continue;
    const k = key(x);
    if (!map.has(k)) map.set(k, x);
  }
  return [...map.values()];
}

function mergeChain(a, b, newerIsA) {
  const newer = newerIsA ? a : b;
  const c = clone(newer || a || b);
  const resetAt = Math.max(latestReset(a), latestReset(b));

  let nodes = dedupe([...arr(a.nodes), ...arr(b.nodes)], nodeKey)
    .filter((n) => (n.end || 0) > resetAt)
    .sort((x, y) => (x.start || 0) - (y.start || 0) || (x.end || 0) - (y.end || 0));
  // 合并后按当前一轮的顺序重新编号，保证两台设备算出来的 #n 一致
  nodes = nodes.map((n, i) => ({ ...n, n: i + 1 }));

  const resets = dedupe([...arr(a.resets), ...arr(b.resets)], resetKey).sort((x, y) => (x.at || 0) - (y.at || 0));

  c.id = a.id || b.id;
  c.createdAt = Math.min(a.createdAt || 0, b.createdAt || 0) || a.createdAt || b.createdAt || 0;
  c.nodes = nodes;
  c.resets = resets;
  c.running = newer.running || null;
  c.aux = newer.aux || null;
  c.pending = newer.pending || null;
  c.name = newer.name != null ? newer.name : a.name || b.name || '';
  c.anchor = newer.anchor != null ? newer.anchor : a.anchor || b.anchor || '';
  c.auxSignal = newer.auxSignal != null ? newer.auxSignal : a.auxSignal || b.auxSignal || '';
  c.auxSignal2 = newer.auxSignal2 != null ? newer.auxSignal2 : a.auxSignal2 || b.auxSignal2 || '';
  c.minutes = newer.minutes || a.minutes || b.minutes || 60;
  c.tier = newer.tier || a.tier || b.tier || 'normal';
  c.kind = newer.kind || a.kind || b.kind || 'assault';
  return c;
}

function mergePolicy(a, b, newerIsA) {
  const newer = newerIsA ? a : b;
  const p = clone(newer || a || b);
  p.id = a.id || b.id;
  p.createdAt = Math.min(a.createdAt || 0, b.createdAt || 0) || a.createdAt || b.createdAt || 0;
  p.daysLit = Math.max(a.daysLit || 0, b.daysLit || 0);
  // 这些字段以较新那台为准；缺失时回退到另一边
  for (const k of ['title', 'type', 'cond', 'trigger', 'parentId', 'state', 'level', 'childrenOpen', 'isGroup', 'quota', 'clearedAt', 'lastEval']) {
    p[k] = newer[k] !== undefined ? newer[k] : a[k] !== undefined ? a[k] : b[k];
  }
  return p;
}

function mergeSettlement(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newer = (a.at || 0) >= (b.at || 0) ? a : b;
  return {
    ...newer,
    brokenIds: [...new Set([...arr(a.brokenIds), ...arr(b.brokenIds)])],
    at: Math.max(a.at || 0, b.at || 0),
  };
}

function mergeFreeze(a, b) {
  const newer = (a.resolvedAt || a.start || 0) >= (b.resolvedAt || b.start || 0) ? a : b;
  const f = clone(newer);
  f.ids = [...new Set([...arr(a.ids), ...arr(b.ids)])];
  f.start = Math.min(a.start || Infinity, b.start || Infinity);
  f.deadline = Math.max(a.deadline || 0, b.deadline || 0);
  const resolved = [a, b].filter((x) => x.resolvedAt).sort((x, y) => x.resolvedAt - y.resolvedAt).pop();
  f.resolvedAt = resolved ? resolved.resolvedAt : null;
  f.result = resolved ? [...new Set([...arr(a.result), ...arr(b.result)])] : newer.result || [];
  f.note = newer.note || a.note || b.note || '';
  return f;
}

/* ---------- 主合并 ---------- */

function mergeContent(a, b) {
  const newerIsA = compare(a, b) >= 0;
  const newer = newerIsA ? a : b;

  const out = {
    app: APP_ID,
    v: Math.max(a.v || 0, b.v || 0, newer.v || 0),
    createdAt: Math.min(a.createdAt || 0, b.createdAt || 0) || a.createdAt || b.createdAt || 0,
    settings: { ...obj(a.settings), ...obj(b.settings), ...obj(newer.settings) },
    lastPolicyDay: maxDay(a.lastPolicyDay, b.lastPolicyDay),
    seen: !!(a.seen || b.seen),
    rev: Math.max(a.rev || 0, b.rev || 0),
    updatedAt: Math.max(activityOf(a), activityOf(b)),
    lastExportAt: Math.max(a.lastExportAt || 0, b.lastExportAt || 0),
    sync: null,
  };

  const tb = tombstones(a);
  const tr = tombstones(b);
  out.deleted = { chains: { ...tb.chains, ...tr.chains }, policies: { ...tb.policies, ...tr.policies } };

  // 链
  const chainMap = new Map();
  for (const c of arr(a.chains)) chainMap.set(c.id, c);
  for (const c of arr(b.chains)) {
    if (!chainMap.has(c.id)) chainMap.set(c.id, c);
    else chainMap.set(c.id, { __pair: [chainMap.get(c.id), c] });
  }
  out.chains = [];
  for (const v of chainMap.values()) {
    let c;
    if (v && v.__pair) {
      const [x, y] = v.__pair;
      c = mergeChain(x, y, newerIsA);
    } else c = clone(v);
    if (!(c.id in out.deleted.chains)) out.chains.push(c);
  }
  out.chains.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0) || String(x.id).localeCompare(String(y.id)));

  // 国策
  const polMap = new Map();
  for (const p of arr(a.policies)) polMap.set(p.id, p);
  for (const p of arr(b.policies)) {
    if (!polMap.has(p.id)) polMap.set(p.id, p);
    else polMap.set(p.id, { __pair: [polMap.get(p.id), p] });
  }
  out.policies = [];
  for (const v of polMap.values()) {
    let p;
    if (v && v.__pair) {
      const [x, y] = v.__pair;
      p = mergePolicy(x, y, newerIsA);
    } else p = clone(v);
    if (!(p.id in out.deleted.policies)) out.policies.push(p);
  }
  out.policies.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0) || String(x.id).localeCompare(String(y.id)));

  // 判例 / 喜报：并集
  const pcMap = new Map();
  for (const p of [...arr(a.precedents), ...arr(b.precedents)]) if (!pcMap.has(p.id)) pcMap.set(p.id, p);
  out.precedents = [...pcMap.values()].sort((x, y) => (x.at || 0) - (y.at || 0) || String(x.id).localeCompare(String(y.id)));

  const winMap = new Map();
  for (const w of [...arr(a.wins), ...arr(b.wins)]) if (!winMap.has(w.id)) winMap.set(w.id, w);
  out.wins = [...winMap.values()].sort((x, y) => (y.at || 0) - (x.at || 0) || String(x.id).localeCompare(String(y.id)));

  // 冻结
  const fzMap = new Map();
  for (const f of arr(a.freezes)) fzMap.set(f.id, f);
  for (const f of arr(b.freezes)) {
    if (!fzMap.has(f.id)) fzMap.set(f.id, f);
    else fzMap.set(f.id, mergeFreeze(fzMap.get(f.id), f));
  }
  out.freezes = [...fzMap.values()].sort((x, y) => (x.start || 0) - (y.start || 0));

  // 结算
  out.settlements = {};
  const dates = new Set([...Object.keys(obj(a.settlements)), ...Object.keys(obj(b.settlements))]);
  for (const d of [...dates].sort()) {
    out.settlements[d] = mergeSettlement(a.settlements && a.settlements[d], b.settlements && b.settlements[d]);
  }

  // 事件
  out.events = mergeEvents(a.events, b.events);

  return out;
}

function maxDay(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return String(a) >= String(b) ? a : b;
}

function compare(a, b) {
  const aa = activityOf(a);
  const ab = activityOf(b);
  if (aa !== ab) return aa > ab ? 1 : -1;
  const da = stateDigest(a);
  const db = stateDigest(b);
  if (da === db) return 0;
  return da > db ? 1 : -1;
}

/** 账本“内容量”：用来判断第一次配置时哪边更值得保留 */
export function contentScore(s) {
  const nodes = arr(s.chains).reduce((n, c) => n + arr(c.nodes).length, 0);
  const resets = arr(s.chains).reduce((n, c) => n + arr(c.resets).length, 0);
  const tb = tombstones(s);
  return (
    nodes * 10 +
    resets * 4 +
    arr(s.precedents).length * 4 +
    arr(s.wins).length * 4 +
    Object.keys(s.settlements || {}).length * 2 +
    arr(s.freezes).length * 2 +
    arr(s.policies).length * 0.5 +
    (Object.keys(tb.chains).length + Object.keys(tb.policies).length) * 2
  );
}

/**
 * 第一次配置同步（还没有上次同步指纹）时的判断。
 * 和日常合并的区别：如果一边明显更“满”（例如旧云端只有一个空壳），
 * 直接采用它，不把两套种子国策并在一起。
 */
export function bootstrapStates(local, remote) {
  const dl = stateDigest(local);
  const dr = stateDigest(remote);
  if (dl === dr) return { state: local, action: 'same' };

  if (isBlank(local) && isBlank(remote)) {
    return compare(local, remote) >= 0
      ? { state: local, action: 'local' }
      : { state: remote, action: 'remote' };
  }
  if (isBlank(remote) && !isBlank(local)) return { state: local, action: 'local' };
  if (isBlank(local) && !isBlank(remote)) return { state: remote, action: 'remote' };

  if (covers(local, remote) && !covers(remote, local)) return { state: local, action: 'local' };
  if (covers(remote, local) && !covers(local, remote)) return { state: remote, action: 'remote' };

  const sl = contentScore(local);
  const sr = contentScore(remote);
  const hi = Math.max(sl, sr);
  const lo = Math.min(sl, sr);
  // 差距足够大才“选大的”，否则老老实实合并
  if (hi >= 8 && hi >= lo * 2.5) {
    return sl > sr ? { state: local, action: 'local' } : { state: remote, action: 'remote' };
  }
  return mergeStates(local, remote);
}

/**
 * 合并本地与云端。返回 { state, action }：
 *  - same   两边内容一样
 *  - local  本机已包含云端（或云是空壳），用本机
 *  - remote 云端已包含本机（或是空设备），用云端
 *  - merged 两边各有新内容，已自动合并
 */
export function mergeStates(local, remote) {
  const dl = stateDigest(local);
  const dr = stateDigest(remote);
  if (dl === dr) return { state: local, action: 'same' };

  // 两边都还是空壳（两套不同的种子）：别把两套国策并在一起，选较新的一套
  if (isBlank(local) && isBlank(remote)) {
    return compare(local, remote) >= 0
      ? { state: local, action: 'local' }
      : { state: remote, action: 'remote' };
  }

  // 空壳（刚装好、只有 app.seen）不配覆盖真账本
  if (isBlank(remote) && !isBlank(local)) return { state: local, action: 'local' };
  if (isBlank(local) && !isBlank(remote)) return { state: remote, action: 'remote' };

  // 一边是另一边的旧版（内容包含关系）
  const cl = covers(local, remote);
  const cr = covers(remote, local);
  if (cl && !cr) return { state: local, action: 'local' };
  if (cr && !cl) return { state: remote, action: 'remote' };

  const out = mergeContent(local, remote);
  const d = stateDigest(out);
  if (d === dl) return { state: local, action: 'local' };
  if (d === dr) return { state: remote, action: 'remote' };
  return { state: out, action: 'merged' };
}
