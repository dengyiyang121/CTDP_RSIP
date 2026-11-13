/* =============================================================================
 * ui.js — 视图与交互（无框架，无构建）
 * ========================================================================== */

import * as C from './core.js';
import { layoutTree, edgePath } from './tree.js';
import * as S from './sound.js';
import * as G from './sync.js';

const APP_VERSION = '0.4.0';

/* ---------------- 元素 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const els = {
  view: $('#view'),
  dock: $('#dock'),
  dockwrap: $('#dockwrap'),
  overlay: $('#overlay'),
  sheet: $('#sheet'),
  toast: $('#toast'),
  date: $('#today'),
  seal: $('#seal'),
  emblem: $('#emblem'),
  tabs: [...document.querySelectorAll('.tabs button')],
};

/* ---------------- 存储 ---------------- */
let storage = null;
try {
  const k = '__ctdp_probe__';
  localStorage.setItem(k, '1');
  localStorage.removeItem(k);
  storage = localStorage;
} catch (e) {
  storage = null;
}

let st;
const led = C.Ledger.load(storage ? storage.getItem(C.STORAGE_KEY) : null, {
  save: (s) => {
    try {
      if (!storage) throw new Error('no storage');
      storage.setItem(C.STORAGE_KEY, s);
    } catch (e) {
      toast('本地存储写入失败，请到「档案」导出备份');
    }
  },
});
st = led.state;

const ui = { tab: 'chains', q: '', treeMode: 'map', zoom: 0, treeInit: false };

/* ---------------- 小工具 ---------------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TYPE = { passive: '被动', semi: '半被动', active: '主动', mech: '机制' };
const GRADE = { small: '小赢', mid: '中赢', big: '大赢' };

/* ---------------- 声音 ---------------- */

document.addEventListener(
  'pointerdown',
  () => {
    S.unlock();
    rescheduleAll();
  },
  { once: true, capture: true }
);

/** 给某条链排好提示音：结链一声，预约到点一串 */
function scheduleChainSound(id) {
  const c = C.chainById(st, id);
  if (!c) return;
  S.cancel('ch:' + id);
  S.cancel('aux:' + id);
  S.cancel('aux2:' + id);
  if (!st.settings.sound) return;
  const now = Date.now();
  if (c.running) {
    S.schedule('done', (c.minutes * 60000 - (now - c.running.start)) / 1000, 'ch:' + id);
  }
  if (c.aux) {
    const left = c.aux.dueAt - now;
    if (left > 0) {
      if (c.aux.second && c.auxSignal2) S.schedule('tick', (left - 30000) / 1000, 'aux2:' + id);
      S.schedule('due', left / 1000, 'aux:' + id);
    }
  }
}

function cancelChainSounds(id) {
  S.cancel('ch:' + id);
  S.cancel('aux:' + id);
  S.cancel('aux2:' + id);
}

function rescheduleAll() {
  for (const c of st.chains) scheduleChainSound(c.id);
}

/* ---------------- 云同步 ---------------- */

let syncCfg = G.loadCfg();
let syncTimer = null;
let syncConflict = false;

const syncInfo = () => st.sync || { sha: null, at: 0, rev: 0 };
const isDirty = () => (st.rev || 0) > (syncInfo().rev || 0);

function markSynced(sha) {
  st.sync = { sha, at: Date.now(), rev: st.rev || 0 };
  led.save();
}

function syncLine() {
  if (!G.configured(syncCfg)) {
    return '未配置。配好后手机和电脑共用一份账本；数据放在你自己的私有仓库里。';
  }
  const info = syncInfo();
  if (syncConflict) return '⚠ 云端和本地都改过，需要手动选一次（点「拉取」或「上传」）。';
  if (!info.at) return '已配置，还没同步过。先点「上传」把本机账本推上去。';
  const when = C.fmtHM(info.at);
  return isDirty() ? `本地有改动未上传 · 上次同步 ${when}` : `已同步 · ${when}${info.sha ? ' · ' + info.sha.slice(0, 7) : ''}`;
}

function applyRemote(text, sha) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error('云端文件不是合法 JSON');
  }
  if (!obj || obj.app !== C.APP_ID) throw new Error('云端文件不是本应用的账本');
  const fresh = C.Ledger.load(JSON.stringify(obj), { save: led._save });
  led.state = fresh.state;
  st = led.state;
  st.sync = { sha, at: Date.now(), rev: st.rev || 0 };
  led.save();
  syncConflict = false;
  render();
}

async function doPull({ silent = false, force = false } = {}) {
  if (!G.configured(syncCfg)) return false;
  try {
    const remote = await G.pull(syncCfg);
    if (!remote) {
      if (!silent) toast('云端还没有文件，先「上传」一次');
      return false;
    }
    const revRemote = (() => {
      try {
        return JSON.parse(remote.text).rev || 0;
      } catch (e) {
        return -1;
      }
    })();
    if (!force && revRemote <= (st.rev || 0)) {
      markSynced(remote.sha);
      if (!silent) toast('云端没有更新的版本');
      render();
      return true;
    }
    applyRemote(remote.text, remote.sha);
    if (!silent) toast('已拉取云端账本');
    return true;
  } catch (e) {
    if (!silent) toast(e.message || '拉取失败');
    return false;
  }
}

async function doPush({ silent = false, force = false } = {}) {
  if (!G.configured(syncCfg)) return false;
  try {
    const info = syncInfo();
    let res = await G.push(syncCfg, JSON.stringify(st), info.sha, `账本 ${new Date().toLocaleString('zh-CN')}`);
    if (res.conflict && force) {
      // 显式“上传本机”时，用远端当前 sha 再推一次
      const remote = await G.pull(syncCfg);
      res = await G.push(syncCfg, JSON.stringify(st), remote ? remote.sha : null, '账本（覆盖云端）');
    }
    if (res.conflict) {
      syncConflict = true;
      if (!silent) toast('云端已经变了，先拉取对比');
      render();
      return false;
    }
    markSynced(res.sha);
    syncConflict = false;
    if (!silent) toast('已上传');
    render();
    return true;
  } catch (e) {
    if (!silent) toast(e.message || '上传失败');
    return false;
  }
}

/** 用 #sync=<base64url>&mode=push|pull 一条链接完成配置（片段不会发到服务器） */
function b64urlDecode(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4 ? '='.repeat(4 - (b.length % 4)) : '';
  const bin = atob(b + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function applySyncHash() {
  const hash = location.hash || '';
  const m = /[#&]sync=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return false;
  try {
    const cfg = JSON.parse(b64urlDecode(m[1]));
    if (!cfg || !cfg.repo || !cfg.token) throw new Error('bad');
    G.saveCfg({ ...G.DEF, ...cfg });
    syncCfg = G.loadCfg();
    const mode = /[#&]mode=(push|pull)/.exec(hash);
    history.replaceState(null, '', location.pathname + location.search);
    render();
    toast(`云同步已配置：${cfg.repo}`);
    if (mode) {
      setTimeout(() => {
        if (mode[1] === 'push') doPush({ force: true });
        else doPull({});
      }, 600);
    }
    return true;
  } catch (e) {
    toast('配置链接无效');
    return false;
  }
}

/** 改动后 20 秒自动推一次；开机时若本地干净就自动拉 */
function autoSyncSoon() {
  if (!G.configured(syncCfg)) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (G.configured(syncCfg) && isDirty() && !syncConflict) doPush({ silent: true });
  }, 20000);
}

async function bootSync() {
  if (!G.configured(syncCfg)) return;
  if (!isDirty()) await doPull({ silent: true });
  rescheduleAll();
}

let toastTimer = null;
let flashTimer = null;
function toast(msg) {
  const flash = document.getElementById('sheet-flash');
  if (flash && !els.overlay.hidden) {
    flash.textContent = msg;
    flash.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flash.classList.remove('show'), 2200);
    return;
  }
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

/* ---------------- 弹层 ---------------- */

let lastFocus = null;

function openSheet({ title, body, onMount, focus = null }) {
  lastFocus = document.activeElement;
  els.sheet.innerHTML = `
    <div class="sheet-head">
      <h2 id="sheet-title">${esc(title)}</h2>
      <button class="x" data-act="close" aria-label="关闭">✕</button>
    </div>
    <div class="sheet-flash" id="sheet-flash" aria-live="polite"></div>
    <div class="sheet-body">${body}</div>`;
  els.overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  document.body.classList.add('sheet-open');
  els.toast.classList.remove('show');
  if (onMount) onMount(els.sheet);
  requestAnimationFrame(() => {
    const f = focus ? els.sheet.querySelector(focus) : null;
    if (f) f.focus({ preventScroll: true });
    else {
      els.sheet.setAttribute('tabindex', '-1');
      els.sheet.focus({ preventScroll: true });
    }
  });
}

function closeSheet() {
  if (els.overlay.hidden) return;
  els.overlay.hidden = true;
  els.sheet.innerHTML = '';
  document.body.style.overflow = '';
  document.body.classList.remove('sheet-open');
  if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.overlay.hidden) {
    e.preventDefault();
    closeSheet();
  }
});
/* 只有“按下”和“松开”都在遮罩上才关。
   否则从弹层里按下、拖到窗外松开，浏览器会把 click 派发到共同祖先（遮罩），
   正在填的表单就被误关了。 */
let backdropArmed = false;
els.overlay.addEventListener('pointerdown', (e) => {
  backdropArmed = e.target === els.overlay;
});
els.overlay.addEventListener('pointerup', (e) => {
  const onBackdrop = e.target === els.overlay;
  if (backdropArmed && onBackdrop) closeSheet();
  backdropArmed = false;
});
els.overlay.addEventListener('pointercancel', () => {
  backdropArmed = false;
});

/* ---------------- 像素纹章 ---------------- */

const FLAG = [
  '11111111000',
  '11111111110',
  '11111111111',
  '11111111110',
  '11111111000',
  '10000000000',
  '10000000000',
  '10000000000',
  '10000000000',
  '10000000000',
  '10000000000',
  '10000000000',
];

function paintEmblem() {
  const svg = els.emblem;
  if (!svg) return;
  let out = '';
  FLAG.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== '1') return;
      const fill = x === 0 ? '#8a8574' : '#c9a227';
      out += `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`;
    });
  });
  svg.innerHTML = out;
}

/* ---------------- 渲染：主链 ---------------- */

function segs(n, total = 12) {
  const k = Math.min(n, total);
  let out = '';
  for (let i = 0; i < total; i++) out += `<i class="${i < k ? 'on' : ''}"></i>`;
  return `<div class="seg" aria-hidden="true">${out}</div>`;
}

function chainCard(c, now) {
  const n = C.nextN(c);
  const total = c.nodes.reduce((a, x) => a + Math.max(0, x.end - x.start), 0) / 3600000;
  const lastAt = Math.max(
    c.nodes.length ? c.nodes[c.nodes.length - 1].end : 0,
    c.resets.length ? c.resets[c.resets.length - 1].at : 0,
    c.createdAt
  );
  const days = Math.floor((now - lastAt) / 86400000);
  const last = c.nodes.length
    ? days <= 0
      ? '今天已练'
      : `上次 ${days} 天前`
    : c.resets.length
    ? '崩后待起'
    : '未开张';

  const head = `
    <div class="chain-head">
      <div class="chain-title">
        <span class="tier ${c.tier === 'elite' ? 'elite' : ''}">${c.tier === 'elite' ? '精锐' : '普通'}</span>
        <h2>${esc(c.name)}</h2>
      </div>
      <div class="chain-n mono" aria-label="下一个节点编号 ${n}">#${n}</div>
    </div>`;

  if (c.running) {
    const el = now - c.running.start;
    const done = el >= c.minutes * 60000;
    return `<article class="card" data-chain="${c.id}">
      ${head}
      <div class="run">
        <div class="run-top">
          <div class="run-clock mono ${done ? 'done' : ''}" data-clock="${c.id}" role="timer" aria-live="off">${C.fmtClock(el)}</div>
          <span class="run-sub"><span class="led"></span>${done ? '可结' : '进行中'}</span>
        </div>
        <div class="run-sub">目标 ${c.minutes}:00 · ${C.fmtHM(c.running.start)} 起链 · 第 #${c.running.n} 节</div>
        ${segs(c.nodes.length)}
        <div class="btnrow">
          <button class="btn primary" id="done-${c.id}" data-act="complete" data-id="${c.id}">完成</button>
          <button class="btn danger" data-act="interrupt" data-id="${c.id}">中断</button>
        </div>
      </div>
    </article>`;
  }

  const aux = c.aux
    ? (() => {
        const left = c.aux.dueAt - now;
        const over = left <= 0;
        const sig = (c.aux.stage2 && c.auxSignal2 ? c.auxSignal2 : c.auxSignal) || '打一个响指';
        const label = over ? '预约超时 · 该判了' : c.aux.stage2 ? `即时信号 · ${sig}` : `预约中 · ${sig}`;
        return `<div class="aux ${over ? 'overdue' : ''}" data-aux="${c.id}">
          <div class="aux-top">
            <span class="aux-label">${esc(label)}</span>
            <span class="aux-time mono" data-clock="aux-${c.id}">${over ? '00:00' : C.fmtClock(left)}</span>
          </div>
          <div class="aux-goal">坐下标志 · ${esc(c.anchor || '（未设锚点）')}</div>
          <div class="btnrow" style="margin-top:8px">
            <button class="btn primary" data-act="fire" data-id="${c.id}">已就位，开始</button>
            <button class="btn ghost" data-act="disarm" data-id="${c.id}">作废</button>
          </div>
        </div>`;
      })()
    : '';

  const pending = c.pending
    ? `<div class="note" style="border-color:var(--rust-dim);margin-top:10px;display:flex;gap:10px;align-items:center;justify-content:space-between">
         <span>有一次未判的中断 · 用时 ${C.fmtClock(c.pending.took)}</span>
         <button class="btn danger" data-act="judge" data-id="${c.id}">现在判</button>
       </div>`
    : '';

  return `<article class="card" data-chain="${c.id}">
    ${head}
    ${c.anchor ? `<p class="anchor">${esc(c.anchor)}</p>` : `<p class="anchor" style="color:var(--faint)">未设神圣座位</p>`}
    ${segs(c.nodes.length)}
    <div class="chain-meta">
      <span>累计 ${total.toFixed(1)}h</span>
      <span>崩塌 ${c.resets.length}</span>
      <span>${last}</span>
    </div>
    ${aux}
    ${pending}
    <div class="btnrow">
      ${
        c.aux
          ? ''
          : `<button class="btn primary" data-act="start" data-id="${c.id}">开始</button>
             <button class="btn" data-act="arm" data-id="${c.id}">预约</button>`
      }
      <button class="btn danger" data-act="judge" data-id="${c.id}">判定</button>
      <button class="btn icon" data-act="chmenu" data-id="${c.id}" aria-label="链设置">⋯</button>
    </div>
  </article>`;
}

function viewChains() {
  const now = Date.now();
  const today = C.dayKey(now, st.settings.dayStart);
  const todays = st.chains.flatMap((c) => c.nodes).filter((n) => C.dayKey(n.end, st.settings.dayStart) === today);
  const h = todays.reduce((a, n) => a + Math.max(0, n.end - n.start), 0) / 3600000;
  const settled = st.settlements[today];
  const lit = st.policies.filter((p) => p.state === 'lit').length;

  const hero = `
    <section class="section">
      <div class="sec-head">战况<span class="spacer"></span><span class="hint">${settled ? '今日已结算' : '今日未结算'}</span></div>
      <div class="stats cols-3">
        <div class="stat"><b>${todays.length}</b><span>今日节点</span></div>
        <div class="stat"><b>${h.toFixed(1)}<small>h</small></b><span>今日专注</span></div>
        <div class="stat"><b>${lit}</b><span>点亮国策</span></div>
      </div>
      ${
        settled
          ? ''
          : `<div class="note" style="margin-top:10px;display:flex;gap:12px;align-items:center;justify-content:space-between">
               <span>今日尚未结算。国策不会自动灭，也不会自动变好。</span>
               <button class="btn" data-act="settle">结算</button>
             </div>`
      }
    </section>`;

  const list = st.chains.length
    ? st.chains.map((c) => chainCard(c, now)).join('')
    : `<div class="empty">还没有链。<br>一条链 = 一个锚点 + 一小时。</div>`;

  return `${hero}
    <section class="section">
      <div class="sec-head">主链<span class="spacer"></span><span class="hint">${st.chains.length} 条</span></div>
      ${list}
    </section>`;
}

/* ---------------- 渲染：国策树 ---------------- */

function policyRow(p, depth) {
  const mark = p.state === 'lit' ? '▣' : p.state === 'frozen' ? '▨' : '▢';
  const kids = C.childrenOf(st, p.id);
  const litKids = kids.filter((k) => k.state === 'lit').length;
  const tag = p.isGroup ? `组 ${litKids}/${kids.length}` : TYPE[p.type] || '被动';
  const pct = C.habitPct(p);
  const stateWord = p.state === 'lit' ? '点亮' : p.state === 'frozen' ? '冻结' : '在库';
  const aria = `${p.title}，${tag}，${stateWord}，${p.daysLit || 0} 天`;
  return `<div class="node ${p.state}" data-d="${depth}" style="--d:${depth}" role="listitem" aria-label="${esc(aria)}">
    <div class="node-line">
      <span class="node-mark" aria-hidden="true">${mark}</span>
      <span class="node-title">${esc(p.title)}</span>
      <span class="tag ${p.type === 'active' ? 'active' : ''}">${esc(tag)}</span>
      ${p.level ? `<span class="lv">+${p.level}</span>` : ''}
      <button class="node-more" data-act="pmenu" data-id="${p.id}" aria-label="${esc(p.title)} 操作">⋯</button>
    </div>
    ${p.cond ? `<div class="node-sub">${esc(p.cond)}</div>` : ''}
    <div class="node-sub" style="margin-top:2px">${p.daysLit || 0} 天 · 内化 ${Math.round(pct)}%</div>
    <div class="habit" aria-hidden="true"><i style="width:${pct}%"></i></div>
  </div>`;
}

function treeOpts() {
  const w = document.documentElement.clientWidth;
  const tb = w < 620;
  return {
    direction: tb ? 'TB' : 'LR',
    pad: 16,
    nodeW: w < 420 ? (tb ? 118 : 124) : 136,
    gapX: tb ? 24 : 44,
    gapY: tb ? 32 : 14,
  };
}

/** 首次进入时自动缩到能看全；不超过 1，也不小于 0.8 */
function autoZoom(L) {
  const avail = document.documentElement.clientWidth - 34;
  return Math.max(0.8, Math.min(1, Math.round((avail / Math.max(1, L.width)) * 100) / 100));
}

function treeMap() {
  const L = layoutTree(st.policies, treeOpts());
  const zoom = ui.zoom || autoZoom(L);
  const edges = L.edges
    .map((e) => `<path class="tedge ${e.state}" d="${edgePath(e)}" marker-end="url(#tarrow)" />`)
    .join('');
  const nodes = L.nodes
    .map(({ p, x, y }) => {
      const kids = C.childrenOf(st, p.id);
      const litKids = kids.filter((k) => k.state === 'lit').length;
      const meta = p.isGroup
        ? `组 ${litKids}/${kids.length}`
        : `${TYPE[p.type] || '被动'}${p.level ? ` +${p.level}` : ''} · ${p.daysLit || 0}天`;
      const word = p.state === 'lit' ? '点亮' : p.state === 'frozen' ? '冻结' : '在库';
      return `<div class="tnode ${p.state}${p.isGroup ? ' grp' : ''}" style="left:${x}px;top:${y}px;width:${L.nodeW}px;height:${L.nodeH}px">
        <i class="tstrip ${p.type}" aria-hidden="true"></i>
        <button class="tnode-main" data-act="pnode" data-id="${p.id}" aria-label="${esc(p.title)}，${meta}，${word}">
          <span class="t-title">${esc(p.title)}</span>
          <span class="t-meta">${esc(meta)}</span>
        </button>
        ${p.state === 'lit' ? `<button class="tnode-add" data-act="p-add" data-id="${p.id}" aria-label="在「${esc(p.title)}」下加子节点">+</button>` : ''}
      </div>`;
    })
    .join('');
  return `
    <div class="treebar">
      <span class="thint">拖动 · <b>+</b> 接子节点</span>
      <div class="ttools">
        <button class="tbtn" data-act="zoom" data-v="-1" aria-label="缩小">−</button>
        <button class="tbtn" data-act="zoom" data-v="0" aria-label="原始大小">1:1</button>
        <button class="tbtn" data-act="zoom" data-v="1" aria-label="放大">+</button>
        <button class="tbtn" data-act="fit" aria-label="缩放到完整显示">适配</button>
        <button class="tbtn" data-act="tree-list">列表</button>
      </div>
    </div>
    <div class="treeframe ${L.dir === 'TB' ? 'tb' : ''}">
      <div class="treeview" id="treeview">
        <div class="tcanvas ${L.dir === 'TB' ? 'tb' : ''}" style="width:${Math.round(L.width * zoom)}px;height:${Math.round(L.height * zoom)}px">
          <div class="tscale" style="width:${L.width}px;height:${L.height}px;transform:scale(${zoom})">
            <svg class="tedges" width="${L.width}" height="${L.height}" aria-hidden="true">
              <defs>
                <marker id="tarrow" viewBox="0 0 6 6" refX="5.5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0 0 L6 3 L0 6 Z" fill="#4b4938" />
                </marker>
              </defs>
              ${edges}
            </svg>
            ${nodes}
          </div>
        </div>
      </div>
      <span class="tfade" aria-hidden="true"></span>
    </div>`;
}

function treeList() {
  const rows = C.treeOrder(st);
  return `
    <div class="treebar">
      <span class="thint">列表 · 缩进即层级</span>
      <div class="ttools"><button class="tbtn" data-act="tree-map">地图</button></div>
    </div>
    <div class="tree" role="list">${rows.map((r) => policyRow(r.p, r.depth)).join('')}</div>`;
}

function viewTree() {
  const now = Date.now();
  const today = C.dayKey(now, st.settings.dayStart);
  const settled = st.settlements[today];
  const rows = C.treeOrder(st);
  const litN = rows.filter((r) => r.p.state === 'lit').length;
  const stockN = rows.filter((r) => r.p.state === 'stock').length;
  const frozenN = rows.filter((r) => r.p.state === 'frozen').length;
  const openFreeze = st.freezes.filter((f) => !f.resolvedAt);
  const dueFreeze = openFreeze.find((f) => f.deadline <= now);

  const banner = [
    !settled && litN
      ? `<div class="note" style="margin:0 0 10px;display:flex;gap:12px;align-items:center;justify-content:space-between">
           <span>今日尚未结算。</span><button class="btn" data-act="settle">结算</button></div>`
      : '',
    dueFreeze
      ? `<div class="warn" style="margin:0 0 10px">水密隔舱已到期（${C.fmtHM(dueFreeze.deadline)}）。该解冻结算了。
           <div class="btnrow"><button class="btn" data-act="unfreeze" data-id="${dueFreeze.id}">解冻结算</button></div></div>`
      : '',
    openFreeze.length && !dueFreeze
      ? `<div class="note" style="margin:0 0 10px;display:flex;gap:12px;align-items:center;justify-content:space-between">
           <span>冻结中 · ${openFreeze.length} 舱 · 最近到期 ${C.fmtHM(Math.min(...openFreeze.map((f) => f.deadline)))}</span>
           <button class="btn" data-act="unfreeze" data-id="${openFreeze[0].id}">提前解冻</button>
         </div>`
      : '',
  ].join('');

  const body = !rows.length
    ? `<div class="empty">树是空的。<br>从一个「不做事」的被动国策开始最稳。</div>`
    : ui.treeMode === 'list'
    ? treeList()
    : treeMap();

  return `
    <section class="section">
      <div class="sec-head">国策树<span class="spacer"></span>
        <button class="btn" data-act="freeze" style="min-height:30px;padding:0 9px;font-size:11px">水密隔舱</button>
      </div>
      <div class="chain-meta" style="margin:0 0 10px">
        <span>点亮 ${litN}</span><span>冻结 ${frozenN}</span><span>在库 ${stockN}</span>
      </div>
      ${banner}
      ${body}
      <details class="manual">
        <summary>规则备忘</summary>
        <p>· 每天最多点亮一个国策；崩掉一个，它和所有子节点一起退回库，但<i>内化天数不丢</i>。<br>
           · 结算默认全部保持点亮，你只勾「崩了」的。<br>
           · 连线从父节点指向子节点；虚线＝在库或冻结。<br>
           · 生病/出差用「水密隔舱」冻结，到期一次补齐。</p>
      </details>
    </section>`;
}

/* ---------------- 渲染：判例 ---------------- */

function viewPrecedents() {
  const list = [...st.precedents].sort((a, b) => b.at - a.at);
  const items = list
    .map((p) => {
      const c = C.chainById(st, p.chainId);
      const txt = `${p.behavior} ${c ? c.name : ''} ${p.note || ''}`;
      return `<div class="pc" data-s="${esc(txt.toLowerCase())}">
        <span class="verdict ${p.decision}">${p.decision === 'allow' ? '准' : '驳'}</span>
        <div style="flex:1;min-width:0">
          <p class="pc-b">${esc(p.behavior)}</p>
          <p class="pc-m">${esc(c ? c.name : '已删链')} · ${C.fmtHM(p.at)} · ${p.decision === 'allow' ? '永久放行' : '判为失败'}</p>
          ${p.note ? `<p class="pc-m" style="color:var(--dim)">${esc(p.note)}</p>` : ''}
        </div>
      </div>`;
    })
    .join('');

  return `
    <section class="section">
      <div class="sec-head">判例<span class="spacer"></span><span class="hint">${list.length} 条</span></div>
      <input class="search" id="pq" type="search" placeholder="搜判例…" value="${esc(ui.q)}" aria-label="搜索判例">
      <div style="margin-top:4px" id="plist">
        ${list.length ? items : `<div class="empty" style="margin-top:12px">还没有判例。<br>判定时「允许」一次，就自动立一条，永久生效。</div>`}
      </div>
      ${
        list.length
          ? `<div class="note" style="margin-top:12px">下必为例：一条「允许」就等于承诺以后同样情况一律允许。所以按下去之前，先看清代价。</div>`
          : ''
      }
    </section>`;
}

/* ---------------- 渲染：档案 ---------------- */

function viewArchive() {
  const s = C.stats(st);
  const wins = st.wins.slice(0, 12);
  const expDays = st.lastExportAt ? Math.floor((Date.now() - st.lastExportAt) / 86400000) : null;
  const backupTip =
    expDays === null
      ? '还没导出过。数据只在这台设备上，清缓存就没了。'
      : expDays >= 7
      ? `上次导出 ${expDays} 天前了。建议导一份。`
      : `上次导出：${expDays === 0 ? '今天' : expDays + ' 天前'}`;
  return `
    <section class="section">
      <div class="sec-head">统计<span class="spacer"></span><span class="hint">自 ${C.fmtDate(st.createdAt)}</span></div>
      <div class="stats">
        <div class="stat"><b>${s.nodes}</b><span>节点</span></div>
        <div class="stat"><b>${s.hours.toFixed(1)}<small>h</small></b><span>累计专注</span></div>
        <div class="stat"><b>${s.longest}</b><span>最长链</span></div>
        <div class="stat"><b>${s.resets}</b><span>崩塌</span></div>
        <div class="stat"><b>${s.precedents}</b><span>判例</span></div>
        <div class="stat"><b>${s.lit}</b><span>点亮</span></div>
        <div class="stat"><b>${s.stock}</b><span>在库</span></div>
        <div class="stat"><b>${s.wins}</b><span>喜报</span></div>
      </div>
    </section>

    <section class="section">
      <div class="sec-head">赢麻了<span class="spacer"></span><button class="btn ghost" data-act="win" style="min-height:32px;padding:0 8px">记一笔</button></div>
      ${
        wins.length
          ? wins
              .map(
                (w) => `<div class="win">
                  <span class="g ${w.grade}">${GRADE[w.grade] || '小赢'}</span>
                  <span class="t">${esc(w.title)}</span>
                  <span class="d">${esc(w.date)}</span>
                </div>`
              )
              .join('')
          : `<div class="empty">今天有什么值得一提的？<br>把最大的那件拿来命名这一天。</div>`
      }
    </section>

    <section class="section">
      <div class="sec-head">云同步<span class="spacer"></span><span class="hint">${G.configured(syncCfg) ? '已配置' : '未配置'}</span></div>
      <div class="note">${esc(syncLine())}</div>
      <div class="btnrow" style="margin-top:10px">
        <button class="btn" data-act="sync-pull" ${G.configured(syncCfg) ? '' : 'disabled'}>拉取</button>
        <button class="btn" data-act="sync-push" ${G.configured(syncCfg) ? '' : 'disabled'}>上传</button>
      </div>
      <div class="btnrow">
        <button class="btn ghost wide" data-act="sync-open">${G.configured(syncCfg) ? '设置 / 断开' : '配置云同步（GitHub 私有仓库）'}</button>
      </div>
    </section>

    <section class="section">
      <div class="sec-head">账本</div>
      <div class="btnrow" style="margin-top:0">
        <button class="btn" data-act="export-md">导出 Markdown</button>
        <button class="btn" data-act="export-json">导出 JSON</button>
      </div>
      <div class="btnrow">
        <button class="btn" data-act="import">导入备份</button>
        <button class="btn" data-act="verify">校验哈希链</button>
      </div>
      <p class="tip" style="color:var(--faint);font-size:12px;margin-top:10px">${backupTip}</p>
    </section>

    <section class="section">
      <div class="sec-head">设置</div>
      <div class="btnrow" style="margin-top:0">
        <button class="btn" data-act="settings">规则参数</button>
        <button class="btn ghost" data-act="intro">重看说明</button>
      </div>
      <div class="btnrow">
        <button class="btn ghost wide" data-act="force-update">强制更新（清缓存并重载）</button>
      </div>
    </section>

    <section class="section">
      <div class="sec-head">关于</div>
      <div class="note">
        方法与原文：<b>《如何提高自制力？》</b> edmond，知乎。<br>
        版本 ${APP_VERSION} · 本工具只做账本与判例，不催促、不评分。<br>
        数据全部在本机，随时可导出离开。
      </div>
    </section>`;
}

/* ---------------- 渲染中枢 ---------------- */

function renderDock() {
  const today = C.dayKey(Date.now(), st.settings.dayStart);
  const settled = st.settlements[today];
  let html = '';
  if (ui.tab === 'chains') {
    html = `<button class="btn primary" data-act="new-chain">新建作战链</button>`;
  } else if (ui.tab === 'policies') {
    html = `<button class="btn" data-act="settle">结算</button>
            <button class="btn primary" data-act="new-policy">点亮国策</button>`;
  } else if (ui.tab === 'archive') {
    html = `<button class="btn primary" data-act="export-md">导出 Markdown</button>`;
  }
  els.dock.innerHTML = html;
  const hidden = !html;
  els.dockwrap.hidden = hidden;
  document.documentElement.style.setProperty('--dock-h', hidden ? '0px' : '64px');
}

function render() {
  st = led.state;
  els.date.textContent = C.fmtDate();
  const v = led.verify();
  els.seal.textContent = v.ok ? '完整' : '异常';
  els.seal.classList.toggle('bad', !v.ok);
  els.seal.title = v.ok ? `哈希链完整 · ${v.count} 条事件` : `第 ${v.seq} 条事件起异常`;
  els.tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab)));

  if (ui.tab === 'chains') els.view.innerHTML = viewChains();
  else if (ui.tab === 'policies') els.view.innerHTML = viewTree();
  else if (ui.tab === 'precedents') els.view.innerHTML = viewPrecedents();
  else els.view.innerHTML = viewArchive();

  renderDock();
  afterRender();
}

function afterRender() {
  if (ui.tab === 'precedents') {
    const q = $('#pq');
    if (q) {
      q.addEventListener('input', () => {
        ui.q = q.value;
        const needle = q.value.trim().toLowerCase();
        document.querySelectorAll('#plist .pc').forEach((el) => {
          el.style.display = !needle || el.dataset.s.includes(needle) ? '' : 'none';
        });
      });
    }
  }
  if (ui.tab === 'policies' && ui.treeMode !== 'list') {
    const tv = $('#treeview');
    if (tv) {
      // 只有真溢出时才显示右缘渐隐，否则会压暗最右一列
      const fade = document.querySelector('.tfade');
      if (fade) fade.style.display = tv.scrollWidth > tv.clientWidth + 2 ? 'block' : 'none';
    }
    if (tv && !ui.treeInit) {
      ui.treeInit = true;
      requestAnimationFrame(() => {
        tv.scrollLeft = 0; // 从根开始看，右边自己拖
      });
    }
  }
}

/* ---------------- 计时器 ---------------- */

function tick() {
  if (ui.tab !== 'chains') return;
  const now = Date.now();
  for (const c of st.chains) {
    if (c.running) {
      const el = now - c.running.start;
      const node = document.querySelector(`[data-clock="${c.id}"]`);
      if (node) {
        node.textContent = C.fmtClock(el);
        node.classList.toggle('done', el >= c.minutes * 60000);
      }
    }
    if (c.aux) {
      const left = c.aux.dueAt - now;
      // 二次信号：剩 30 秒时把提示切到「即时启动信号」
      if (left <= 30000 && left > 0 && c.aux.second && !c.aux.stage2) {
        c.aux.stage2 = true;
        if (ui.tab === 'chains') render();
        return;
      }
      const node = document.querySelector(`[data-clock="aux-${c.id}"]`);
      if (node) {
        node.textContent = left > 0 ? C.fmtClock(left) : '00:00';
        const box = node.closest('.aux');
        if (box) box.classList.toggle('overdue', left <= 0);
        const label = box && box.querySelector('.aux-label');
        if (label) {
          const sig = (c.aux.stage2 && c.auxSignal2 ? c.auxSignal2 : c.auxSignal) || '打一个响指';
          label.textContent = left <= 0 ? '预约超时 · 该判了' : c.aux.stage2 ? `即时信号 · ${sig}` : `预约中 · ${sig}`;
        }
      }
      if (left <= 0 && !c.aux.notified) {
        c.aux.notified = true;
        toast('预约到点：现在去触发锚点');
      }
    }
  }
}
setInterval(tick, 1000);

/* ---------------- 流程：起链 ---------------- */

function openRitual(id) {
  const c = C.chainById(st, id);
  if (!c) return;
  if (!st.settings.ritual) {
    const n = C.nextN(c);
    if (led.start(id)) {
      render();
      toast(`第 #${n} 节起链`);
    }
    return;
  }
  openSheet({
    title: '起链',
    body: `
      <p class="tip" style="margin-top:0">神圣座位 · 锚点</p>
      <div class="note" style="font-size:16px;color:var(--ink);border-color:var(--brass-dim)">${esc(c.anchor || '（还没设锚点）')}</div>
      <p class="tip">一旦触发，就必须以最好的状态完成 ${c.minutes} 分钟。中途破戒，走判定，没有第三种。</p>
      <div class="btnrow">
        <button class="btn primary wide" data-act="start-go" data-id="${id}">已就位 · 开始</button>
      </div>
      <div class="btnrow">
        <button class="btn ghost wide" data-act="close">再等等</button>
      </div>`,
  });
}

function openComplete(id) {
  const c = C.chainById(st, id);
  if (!c || !c.running) return;
  const el = Date.now() - c.running.start;
  const target = c.minutes * 60000;
  if (el >= target) {
    const r = led.complete(id);
    if (r.ok) {
      closeSheet();
      render();
      toast(`第 #${r.n} 节入档`);
    }
    return;
  }
  openSheet({
    title: '未满时长',
    body: `
      <p class="tip" style="margin-top:0">还差 <b class="mono">${C.fmtClock(target - el)}</b>。按规则，现在结束不算完成。</p>
      <div class="kv"><span class="k">已用</span><span class="v">${C.fmtClock(el)}</span></div>
      <div class="kv"><span class="k">目标</span><span class="v">${c.minutes}:00</span></div>
      <div class="btnrow">
        <button class="btn primary wide" data-act="close">继续专注</button>
      </div>
      <div class="btnrow">
        <button class="btn danger" data-act="interrupt" data-id="${id}">中断 · 走判定</button>
        <button class="btn ghost" data-act="force-done" data-id="${id}">仍算完成</button>
      </div>`,
  });
}

/* ---------------- 流程：判定 ---------------- */

function matchHTML(chainId, behavior) {
  const ms = C.similarPrecedents(st, chainId, behavior);
  if (!ms.length) return `<p class="tip" style="color:var(--faint)">没有相似判例——这一判就是先例。</p>`;
  return (
    `<p class="tip" style="margin-bottom:6px">相似判例</p>` +
    ms
      .map(
        (m) => `<p class="match ${m.p.decision}">
          ${m.p.decision === 'allow' ? '准' : '驳'} · <b>${esc(m.p.behavior)}</b> · ${C.fmtHM(m.p.at)}
        </p>`
      )
      .join('')
  );
}

function openJudge(chainId, preset = '') {
  const c = C.chainById(st, chainId);
  if (!c) return;
  const chips = ['看手机', '回微信', '刷视频', '离开座位', '接电话', '走神', '做别的事'];
  openSheet({
    title: `判定 · ${c.name}`,
    body: `
      <p class="tip" style="margin-top:0">两选一，没有第三种。</p>
      <div class="chips">${chips
        .map((x) => `<button class="chip" data-act="chip" data-v="${x}">${x}</button>`)
        .join('')}</div>
      <div class="field" style="margin-top:12px">
        <label for="jb">发生了什么</label>
        <input id="jb" type="text" data-autofocus placeholder="例：回了条微信，两分钟" value="${esc(preset)}">
      </div>
      <div id="matches">${matchHTML(chainId, preset)}</div>
      <div class="sheet-foot">
        <div class="btnrow" style="margin:0">
          <button class="btn danger" data-act="judge-deny" data-id="${chainId}">判为失败</button>
          <button class="btn primary" data-act="judge-allow" data-id="${chainId}">允许</button>
        </div>
        <p class="tip" style="margin-top:8px">失败＝链清零回 #1。允许＝该行为在本链永久放行，且以后必须一律允许。</p>
      </div>`,
    onMount(root) {
      const input = root.querySelector('#jb');
      input.addEventListener('input', () => {
        root.querySelector('#matches').innerHTML = matchHTML(chainId, input.value);
      });
    },
    focus: '#jb',
  });
}

function readJudgeInput() {
  const el = $('#jb');
  return el ? el.value.trim() : '';
}

function confirmDeny(chainId, behavior) {
  const c = C.chainById(st, chainId);
  const n = c ? C.nextN(c) - 1 : 0;
  openSheet({
    title: '确认清零',
    body: `
      <p class="tip" style="margin-top:0">判为失败：<b>${esc(behavior)}</b></p>
      <div class="kv"><span class="k">将清零</span><span class="v">${n} 节 → #1</span></div>
      <div class="kv"><span class="k">内化进度</span><span class="v">保留</span></div>
      <p class="tip">崩塌会记入档案，国策的内化天数不受影响。</p>
      <div class="btnrow">
        <button class="btn danger wide" data-act="judge-deny-go" data-id="${chainId}" data-v="${esc(behavior)}">确认清零</button>
      </div>
      <div class="btnrow"><button class="btn ghost wide" data-act="close">撤回</button></div>`,
  });
}

function confirmAllow(chainId, behavior) {
  openSheet({
    title: '确认立例',
    body: `
      <p class="tip" style="margin-top:0">允许：<b>${esc(behavior)}</b></p>
      <div class="warn">从此以后，同样的情况在这一条链里一律放行，不能再算违规。这是「下必为例」。</div>
      <div class="btnrow">
        <button class="btn primary wide" data-act="judge-allow-go" data-id="${chainId}" data-v="${esc(behavior)}">确认永久放行</button>
      </div>
      <div class="btnrow"><button class="btn ghost wide" data-act="close">撤回</button></div>`,
  });
}

/* ---------------- 流程：结算 ---------------- */

function openSettle() {
  const today = C.dayKey();
  const done = st.settlements[today];
  if (done) {
    const broken = done.brokenIds.length;
    openSheet({
      title: `结算 · ${today}`,
      body: `<p class="tip" style="margin-top:0">今天已经结算过了。</p>
        <div class="kv"><span class="k">熄灭</span><span class="v">${broken} 项</span></div>
        ${done.note ? `<p class="tip">备注：${esc(done.note)}</p>` : ''}
        <p class="tip">一天只结算一次，避免反复改判。</p>`,
    });
    return;
  }
  const lit = st.policies.filter((p) => p.state === 'lit');
  if (!lit.length) {
    openSheet({
      title: '结算',
      body: `<p class="tip" style="margin-top:0">没有点亮的国策可结算。先去点亮一个。</p>
        <div class="btnrow"><button class="btn primary wide" data-act="new-policy">点亮国策</button></div>`,
    });
    return;
  }
  const rows = C.treeOrder(st).filter((r) => r.p.state === 'lit');
  openSheet({
    title: '日结算',
    body: `
      <p class="tip" style="margin-top:0">默认全部保持点亮。只勾<b>崩了</b>的。</p>
      <div style="border-top:1px solid var(--line)">
        ${rows
          .map(
            (r) => `<label class="check-row" style="padding-left:${r.depth * 14}px">
              <input type="checkbox" value="${r.p.id}">
              <span class="txt">${esc(r.p.title)}<span class="sub"> · ${TYPE[r.p.type] || '被动'}${r.p.isGroup ? ' · 组' : ''}</span></span>
            </label>`
          )
          .join('')}
      </div>
      <div class="field" style="margin-top:14px">
        <label for="s-note">备注（可选）</label>
        <input id="s-note" type="text" placeholder="例：感冒，躺了一天">
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="settle-go">确认结算</button></div>`,
  });
}

function settleGo() {
  const ids = [...els.sheet.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
  const note = ($('#s-note') && $('#s-note').value.trim()) || '';
  const today = C.dayKey();
  led.settle(today, ids, note);
  closeSheet();
  render();
  toast(ids.length ? `已结算 · ${ids.length} 项熄灭` : '已结算 · 全数存活');
}

/* ---------------- 流程：国策 ---------------- */

function openPolicySheet(id) {
  const p = C.policyById(st, id);
  if (!p) return;
  const kids = C.childrenOf(st, p.id);
  const descN = C.descendantIds(st, p.id).length;
  const word = p.state === 'lit' ? '点亮' : p.state === 'frozen' ? '冻结' : '在库';
  openSheet({
    title: p.title,
    body: `
      <div class="kv"><span class="k">类型</span><span class="v">${TYPE[p.type] || '被动'}${p.isGroup ? ` · 组（配额 ${p.quota}）` : ''}</span></div>
      <div class="kv"><span class="k">状态</span><span class="v">${word}${p.level ? ` · 强化 +${p.level}` : ''}</span></div>
      <div class="kv"><span class="k">内化</span><span class="v">${p.daysLit || 0} 天</span></div>
      <div class="kv"><span class="k">子节点</span><span class="v">${kids.length} 个${descN ? `（含后代 ${descN}）` : ''}</span></div>
      ${p.cond ? `<p class="tip">${esc(p.cond)}</p>` : ''}
      <div class="btnrow">
        <button class="btn primary" data-act="p-add" data-id="${id}">加子节点</button>
        <button class="btn" data-act="p-up" data-id="${id}">强化 +1</button>
      </div>
      <div class="btnrow">
        ${
          p.state === 'lit'
            ? `<button class="btn danger" data-act="p-off" data-id="${id}">熄灭${descN ? `（连带 ${descN}）` : ''}</button>`
            : `<button class="btn" data-act="prestore" data-id="${id}">重新点亮</button>`
        }
        <button class="btn ghost" data-act="p-delete" data-id="${id}">删除</button>
      </div>
      ${p.level ? `<div class="btnrow"><button class="btn ghost wide" data-act="p-down" data-id="${id}">降一级</button></div>` : ''}`,
  });
}

function openNewPolicy(parentId = null) {
  const rows = C.treeOrder(st).filter((r) => r.p.state === 'lit');
  const parent = parentId ? C.policyById(st, parentId) : null;
  const opts =
    `<option value="" ${parent ? '' : 'selected'}>— 新分支（根节点）</option>` +
    rows
      .map(
        (r) =>
          `<option value="${r.p.id}" ${r.p.id === parentId ? 'selected' : ''}>${'　'.repeat(r.depth)}${esc(r.p.title)}</option>`
      )
      .join('');
  openSheet({
    title: parent ? `在「${parent.title}」下加子节点` : '点亮新国策',
    body: `
      <p class="tip" style="margin-top:0">每天最多点亮一个。越傻、越被动、越逆风也能活，越适合放根部。</p>
      <div class="field">
        <label for="np-title">名字</label>
        <input id="np-title" type="text" data-autofocus placeholder="例：不在沙发上用手机">
      </div>
      <div class="field">
        <span class="lbl">类型</span>
        <div class="radio-row">
          <label><input type="radio" name="np-type" value="passive" checked><span>被动</span></label>
          <label><input type="radio" name="np-type" value="semi"><span>半被动</span></label>
          <label><input type="radio" name="np-type" value="active"><span>主动</span></label>
          <label><input type="radio" name="np-type" value="mech"><span>机制</span></label>
        </div>
        <p class="tip">被动＝在特定场景「不做某事」；半被动＝如果 A 就 B；主动＝每天要投入（最容易崩，少用）。</p>
      </div>
      <div class="field">
        <label for="np-cond">规则原文</label>
        <input id="np-cond" type="text" placeholder="例：回家进门后 15 分钟内必须洗澡">
      </div>
      <div class="field">
        <label for="np-parent">接到哪个节点下</label>
        <select id="np-parent">${opts}</select>
      </div>
      <label class="check-row" style="border-bottom:0">
        <input type="checkbox" id="np-group">
        <span class="txt">这是「国策组」<span class="sub"> · 允许组内 N 个成员崩掉</span></span>
      </label>
      <div class="field" id="np-quota-wrap" hidden>
        <label for="np-quota">容错名额（亮着的最少几个，组才算亮）</label>
        <input id="np-quota" type="number" min="1" max="20" value="2">
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="np-save">点亮</button></div>`,
    onMount(root) {
      const g = root.querySelector('#np-group');
      g.addEventListener('change', () => {
        root.querySelector('#np-quota-wrap').hidden = !g.checked;
      });
    },
    focus: '#np-title',
  });
}

/* ---------------- 流程：冻结 ---------------- */

function openFreeze() {
  const rows = C.treeOrder(st);
  const opts =
    `<option value="">全部点亮的国策</option>` +
    rows
      .filter((r) => r.p.state === 'lit')
      .map((r) => `<option value="${r.p.id}">${'　'.repeat(r.depth)}${esc(r.p.title)} 及其子节点</option>`)
      .join('');
  openSheet({
    title: '水密隔舱',
    body: `
      <p class="tip" style="margin-top:0">生病、出差、突发：先冻结，别让它把整棵树带崩。到期必须一次性补齐。</p>
      <div class="field">
        <label for="fz-days">冻结天数</label>
        <input id="fz-days" type="number" min="1" max="30" value="2">
      </div>
      <div class="field">
        <label for="fz-scope">范围</label>
        <select id="fz-scope">${opts}</select>
      </div>
      <div class="field">
        <label for="fz-note">缘由</label>
        <input id="fz-note" type="text" placeholder="例：发烧，卧床">
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="freeze-go">冻结</button></div>`,
    focus: '#fz-days',
  });
}

function openUnfreeze(id) {
  const f = st.freezes.find((x) => x.id === id);
  if (!f) return;
  const frozen = st.policies.filter((p) => p.state === 'frozen');
  openSheet({
    title: '解冻结算',
    body: `
      <p class="tip" style="margin-top:0">冻结期间不算违约。勾选<b>没能补上</b>的，其余回到点亮。</p>
      <div style="border-top:1px solid var(--line)">
        ${frozen
          .map(
            (p) => `<label class="check-row">
              <input type="checkbox" value="${p.id}">
              <span class="txt">${esc(p.title)}<span class="sub"> · ${TYPE[p.type] || '被动'}</span></span>
            </label>`
          )
          .join('')}
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="unfreeze-go" data-id="${id}">确认解冻</button></div>`,
  });
}

/* ---------------- 流程：链设置 ---------------- */

function openChainMenu(id) {
  const c = C.chainById(st, id);
  if (!c) return;
  openSheet({
    title: `链 · ${c.name}`,
    body: `
      <div class="kv"><span class="k">神圣座位</span><span class="v" style="font-size:13px">${esc(c.anchor || '—')}</span></div>
      <div class="kv"><span class="k">预约信号</span><span class="v" style="font-size:13px">${esc(c.auxSignal || '打一个响指')}</span></div>
      ${c.auxSignal2 ? `<div class="kv"><span class="k">即时信号</span><span class="v" style="font-size:13px">${esc(c.auxSignal2)}</span></div>` : ''}
      <div class="kv"><span class="k">单节时长</span><span class="v">${c.minutes} 分钟</span></div>
      <div class="kv"><span class="k">节点</span><span class="v">#${C.nextN(c)}</span></div>
      <div class="btnrow">
        <button class="btn" data-act="ch-edit" data-id="${id}">编辑</button>
        <button class="btn danger" data-act="ch-reset" data-id="${id}">清空重开</button>
      </div>
      <div class="btnrow"><button class="btn ghost wide" data-act="ch-delete" data-id="${id}">删除这条链</button></div>`,
  });
}

function openChainEdit(id) {
  const c = C.chainById(st, id);
  if (!c) return;
  openSheet({
    title: '编辑链',
    body: `
      <div class="field">
        <label for="ce-name">名字</label>
        <input id="ce-name" type="text" value="${esc(c.name)}" data-autofocus>
      </div>
      <div class="field">
        <label for="ce-anchor">神圣座位（起链标志）</label>
        <input id="ce-anchor" type="text" value="${esc(c.anchor)}" placeholder="例：深呼吸三次，戴上蓝帽子">
      </div>
      <div class="field">
        <label for="ce-aux">预约信号</label>
        <input id="ce-aux" type="text" value="${esc(c.auxSignal || '')}" placeholder="例：打一个响指">
      </div>
      <div class="field">
        <label for="ce-aux2">即时启动信号（可选）</label>
        <input id="ce-aux2" type="text" value="${esc(c.auxSignal2 || '')}" placeholder="例：连打三次响指">
      </div>
      <div class="field">
        <label for="ce-min">单节时长（分钟）</label>
        <input id="ce-min" type="number" min="5" max="240" value="${c.minutes}">
      </div>
      <div class="field">
        <span class="lbl">层级</span>
        <div class="radio-row">
          <label><input type="radio" name="ce-tier" value="elite" ${c.tier === 'elite' ? 'checked' : ''}><span>精锐</span></label>
          <label><input type="radio" name="ce-tier" value="normal" ${c.tier !== 'elite' ? 'checked' : ''}><span>普通</span></label>
        </div>
        <p class="tip">精锐链只在状态最好时动用；崩了用普通链接位。</p>
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="ce-save" data-id="${id}">保存</button></div>`,
    focus: '#ce-name',
  });
}

/* ---------------- 流程：新建链 ---------------- */

function openNewChain() {
  openSheet({
    title: '新建作战链',
    body: `
      <div class="field">
        <label for="nc-name">名字</label>
        <input id="nc-name" type="text" data-autofocus placeholder="例：突击 / 侦查 / 工程">
      </div>
      <div class="field">
        <label for="nc-anchor">神圣座位（起链标志）</label>
        <input id="nc-anchor" type="text" placeholder="例：深呼吸三次，戴上降噪耳机">
        <p class="tip">这是「开始」的标志，越具体越好。它是链的开关，不是 App。</p>
      </div>
      <div class="field">
        <label for="nc-aux">预约信号（怎么预约）</label>
        <input id="nc-aux" type="text" placeholder="例：打一个响指">
        <p class="tip">和座位分开：打响指只是预约，坐下才是开始。留空就用默认「打一个响指」。</p>
      </div>
      <div class="field">
        <label for="nc-aux2">即时启动信号（可选，二次保险）</label>
        <input id="nc-aux2" type="text" placeholder="例：连打三次响指">
        <p class="tip">设了它，预约剩 30 秒时会提醒你先打这个信号，再立刻坐下。</p>
      </div>
      <div class="field">
        <label for="nc-min">单节时长（分钟）</label>
        <input id="nc-min" type="number" min="5" max="240" value="60">
      </div>
      <div class="field">
        <span class="lbl">层级</span>
        <div class="radio-row">
          <label><input type="radio" name="nc-tier" value="elite" checked><span>精锐</span></label>
          <label><input type="radio" name="nc-tier" value="normal"><span>普通</span></label>
        </div>
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="nc-save">建链</button></div>`,
    focus: '#nc-name',
  });
}

/* ---------------- 流程：导出 / 导入 ---------------- */

function markExport(kind) {
  st.lastExportAt = Date.now();
  led._commit('export.' + kind, {});
  render();
}

function download(name, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openExportMd() {
  const md = led.exportMarkdown();
  openSheet({
    title: '导出 Markdown',
    body: `
      <div class="field">
        <textarea id="md-out" readonly style="min-height:260px;font-family:var(--mono);font-size:12px">${esc(md)}</textarea>
      </div>
      <div class="btnrow">
        <button class="btn" data-act="copy-md">复制</button>
        <button class="btn primary" data-act="dl-md">下载 .md</button>
      </div>
      <p class="tip">贴进微信小号、备忘录、纸质打印都行。离开 App 也不丢系统。</p>`,
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch (e) {
    const ta = $('#md-out');
    if (ta) {
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
        toast('已复制');
      } catch (err) {
        toast('复制失败，请手动选中');
      }
    }
  }
}

function openImport() {
  openSheet({
    title: '导入备份',
    body: `
      <p class="tip" style="margin-top:0">导入会覆盖当前账本。先导出一份留底更稳。</p>
      <div class="field">
        <label for="imp-file">选择 .json 文件</label>
        <input id="imp-file" type="file" accept="application/json,.json">
      </div>
      <div class="btnrow"><button class="btn wide" data-act="close">取消</button></div>`,
    onMount(root) {
      const input = root.querySelector('#imp-file');
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        const text = await f.text();
        tryImport(text);
      });
    },
  });
}

function tryImport(text) {
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    toast('不是合法的 JSON');
    return;
  }
  if (!obj || obj.app !== C.APP_ID) {
    toast('不是本应用的备份');
    return;
  }
  const fresh = C.Ledger.load(JSON.stringify(obj), { save: led._save });
  led.state = fresh.state;
  st = led.state;
  led.save();
  closeSheet();
  render();
  toast('已导入');
}

/* ---------------- 流程：设置 / 说明 ---------------- */

function openSettings() {
  openSheet({
    title: '规则参数',
    body: `
      <div class="field">
        <label for="se-day">作战日从几点开始（凌晨算前一天）</label>
        <input id="se-day" type="number" min="0" max="12" value="${st.settings.dayStart}">
      </div>
      <div class="field">
        <label for="se-aux">预约窗口（分钟）</label>
        <input id="se-aux" type="number" min="1" max="120" value="${st.settings.auxMinutes}">
      </div>
      <label class="check-row">
        <input type="checkbox" id="se-ritual" ${st.settings.ritual ? 'checked' : ''}>
        <span class="txt">起链前弹一次锚点确认<span class="sub"> · 关掉就是零点击开始</span></span>
      </label>
      <label class="check-row">
        <input type="checkbox" id="se-sound" ${st.settings.sound ? 'checked' : ''}>
        <span class="txt">到点提示音<span class="sub"> · 结链、预约到点</span></span>
      </label>
      <div class="btnrow" style="margin-top:6px">
        <button class="btn ghost wide" data-act="sound-test">试听提示音</button>
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="settings-save">保存</button></div>`,
  });
}

function openSync() {
  const c = syncCfg;
  const link = c.repo ? `https://github.com/${c.repo}/blob/${c.branch}/${c.path}` : '';
  openSheet({
    title: '云同步',
    body: `
      <p class="tip" style="margin-top:0">账本写到你的<b>私有仓库</b>，手机和电脑各配一次即可。每次上传都是一次 commit，覆盖了也能回滚。</p>
      <div class="field">
        <label for="sy-repo">仓库（owner/repo）</label>
        <input id="sy-repo" type="text" value="${esc(c.repo)}" placeholder="yourname/ctdp-ledger">
      </div>
      <div class="field">
        <label for="sy-path">文件路径</label>
        <input id="sy-path" type="text" value="${esc(c.path)}">
      </div>
      <div class="field">
        <label for="sy-branch">分支</label>
        <input id="sy-branch" type="text" value="${esc(c.branch)}">
      </div>
      <div class="field">
        <label for="sy-token">访问令牌（PAT）</label>
        <input id="sy-token" type="password" value="${esc(c.token)}" placeholder="github_pat_…">
        <p class="tip">只填在这台设备上，不会进账本、不会被同步。权限只要这一个仓库的 <b>Contents: Read and write</b>。</p>
      </div>
      ${link ? `<p class="tip">云端文件：<a href="${esc(link)}" target="_blank" rel="noreferrer">${esc(link)}</a></p>` : ''}
      <div class="btnrow">
        <button class="btn" data-act="sync-test">测试连接</button>
        <button class="btn primary" data-act="sync-save">保存</button>
      </div>
      ${
        G.configured(c)
          ? `<div class="btnrow"><button class="btn ghost wide" data-act="sync-forget">清除配置（账本不动）</button></div>`
          : ''
      }`,
  });
}

function openIntro() {
  openSheet({
    title: '这是什么',
    body: `
      <div class="note" style="font-size:14px">
        一个<b>账本</b>，不是教练。<br>
        它替你记住两件人记不住的事：判过什么例，崩过几次。
      </div>
      <div class="kv"><span class="k">主链</span><span class="v" style="font-family:var(--sans);font-size:13px">一个锚点 + 一小时 = 一个 # 节点</span></div>
      <div class="kv"><span class="k">判定</span><span class="v" style="font-family:var(--sans);font-size:13px">破戒只有两条路：清零，或永久放行</span></div>
      <div class="kv"><span class="k">国策树</span><span class="v" style="font-family:var(--sans);font-size:13px">每天点亮一个；崩了退回库，内化天数不丢</span></div>
      <p class="tip">没有推送轰炸，没有连续打卡羞辱。一天用不到一分钟。</p>
      <div class="btnrow"><button class="btn primary wide" data-act="intro-ok">开始</button></div>`,
  });
}

/* ---------------- 事件 ---------------- */

function afterChange() {
  render();
  autoSyncSoon();
}

function onClick(e) {
  const tabBtn = e.target.closest('.tabs button');
  if (tabBtn) {
    ui.tab = tabBtn.dataset.tab;
    render();
    return;
  }
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const id = t.dataset.id;
  const v = t.dataset.v;

  switch (act) {
    case 'close':
      closeSheet();
      break;

    /* 起链 */
    case 'start':
      openRitual(id);
      break;
    case 'start-go': {
      const c = C.chainById(st, id);
      if (!c) break;
      led.start(id);
      closeSheet();
      afterChange();
      scheduleChainSound(id);
      toast(`第 #${C.nextN(c)} 节起链`);
      break;
    }
    case 'arm': {
      const c = C.chainById(st, id);
      led.arm(id);
      afterChange();
      scheduleChainSound(id);
      toast(`已预约 · ${(c && c.auxSignal) || '打一个响指'}`);
      break;
    }
    case 'fire': {
      const c = C.chainById(st, id);
      const n = c ? C.nextN(c) : 1;
      S.cancel('aux:' + id);
      S.cancel('aux2:' + id);
      led.fireAux(id);
      afterChange();
      scheduleChainSound(id);
      toast(`第 #${n} 节起链`);
      break;
    }
    case 'disarm':
      cancelChainSounds(id);
      led.disarm(id);
      afterChange();
      toast('预约作废');
      break;
    case 'complete':
      openComplete(id);
      break;
    case 'force-done': {
      cancelChainSounds(id);
      const r = led.complete(id, { force: true });
      closeSheet();
      afterChange();
      if (r.ok) toast(`第 #${r.n} 节入档（未满时长）`);
      break;
    }
    case 'interrupt': {
      cancelChainSounds(id);
      const info = led.pause(id);
      if (info) {
        openJudge(id);
        toast(`已中断 · 用时 ${C.fmtClock(info.took)}`);
      }
      break;
    }
    case 'judge':
      openJudge(id);
      break;
    case 'chip': {
      const input = $('#jb');
      if (input) {
        input.value = v;
        input.dispatchEvent(new Event('input'));
        input.focus();
      }
      break;
    }
    case 'judge-allow': {
      const behavior = readJudgeInput();
      if (!behavior) return toast('先写一句发生了什么');
      confirmAllow(id, behavior);
      break;
    }
    case 'judge-deny': {
      const behavior = readJudgeInput();
      if (!behavior) return toast('先写一句发生了什么');
      confirmDeny(id, behavior);
      break;
    }
    case 'judge-allow-go': {
      cancelChainSounds(id);
      led.judge({ chainId: id, behavior: v, decision: 'allow' });
      closeSheet();
      afterChange();
      toast('已立判例 · 永久放行');
      break;
    }
    case 'judge-deny-go': {
      cancelChainSounds(id);
      const r = led.judge({ chainId: id, behavior: v, decision: 'deny' });
      closeSheet();
      afterChange();
      if (r.reset) toast(`链已清零（${r.cleared} 节）`);
      break;
    }

    /* 链菜单 */
    case 'chmenu':
      openChainMenu(id);
      break;
    case 'ch-edit':
      openChainEdit(id);
      break;
    case 'ce-save': {
      const name = $('#ce-name').value.trim();
      const anchor = $('#ce-anchor').value.trim();
      const auxSignal = $('#ce-aux').value.trim();
      const auxSignal2 = $('#ce-aux2').value.trim();
      const min = Number($('#ce-min').value) || 60;
      const tier = ($('input[name="ce-tier"]:checked') || {}).value || 'normal';
      led.updateChain(id, {
        name: name || '未命名链',
        anchor,
        auxSignal,
        auxSignal2,
        minutes: Math.max(5, Math.min(240, min)),
        tier,
      });
      closeSheet();
      afterChange();
      toast('已保存');
      break;
    }
    case 'ch-reset':
      openSheet({
        title: '清空重开',
        body: `<p class="tip" style="margin-top:0">把这条链重置到 #1。会记一次崩塌。</p>
          <div class="btnrow"><button class="btn danger wide" data-act="ch-reset-go" data-id="${id}">确认清零</button></div>
          <div class="btnrow"><button class="btn ghost wide" data-act="close">撤回</button></div>`,
      });
      break;
    case 'ch-reset-go':
      cancelChainSounds(id);
      led.reset(id, '手动清空');
      closeSheet();
      afterChange();
      toast('已清零');
      break;
    case 'ch-delete':
      openSheet({
        title: '删除链',
        body: `<p class="tip" style="margin-top:0">「${esc((C.chainById(st, id) || {}).name || '')}」的节点会一并消失。不可撤销。</p>
          <div class="btnrow"><button class="btn danger wide" data-act="ch-delete-go" data-id="${id}">确认删除</button></div>
          <div class="btnrow"><button class="btn ghost wide" data-act="close">撤回</button></div>`,
      });
      break;
    case 'ch-delete-go': {
      cancelChainSounds(id);
      st.chains = st.chains.filter((c) => c.id !== id);
      closeSheet();
      afterChange();
      toast('已删除');
      break;
    }
    case 'new-chain':
      openNewChain();
      break;
    case 'nc-save': {
      const name = $('#nc-name').value.trim();
      const anchor = $('#nc-anchor').value.trim();
      const auxSignal = $('#nc-aux').value.trim();
      const auxSignal2 = $('#nc-aux2').value.trim();
      const min = Number($('#nc-min').value) || 60;
      const tier = ($('input[name="nc-tier"]:checked') || {}).value || 'normal';
      if (!name) return toast('给它起个名字');
      led.addChain({ name, anchor, auxSignal, auxSignal2, minutes: Math.max(5, Math.min(240, min)), tier });
      closeSheet();
      afterChange();
      toast('已建链');
      break;
    }

    /* 国策 */
    case 'new-policy':
      openNewPolicy();
      break;
    case 'np-save': {
      const title = $('#np-title').value.trim();
      if (!title) return toast('给它起个名字');
      const type = ($('input[name="np-type"]:checked') || {}).value || 'passive';
      const cond = $('#np-cond').value.trim();
      const parentId = $('#np-parent').value || null;
      const isGroup = $('#np-group').checked;
      const quota = Number($('#np-quota').value) || 1;
      const r = led.addPolicy({ title, type, cond, parentId, isGroup, quota });
      if (!r.ok) {
        toast('今天已经点亮过一个了，明天再来');
        return;
      }
      closeSheet();
      afterChange();
      toast('已点亮');
      if (ui.tab === 'policies' && ui.treeMode !== 'list') {
        const el = document.querySelector(`.tnode[data-id="${r.policy.id}"]`);
        if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', inline: 'center' }));
      }
      break;
    }
    case 'pmenu':
    case 'pnode': {
      openPolicySheet(id);
      break;
    }
    case 'p-add':
      openNewPolicy(id);
      break;
    case 'tree-list':
      ui.treeMode = 'list';
      render();
      break;
    case 'tree-map':
      ui.treeMode = 'map';
      ui.treeInit = false;
      render();
      break;
    case 'fit': {
      const L = layoutTree(st.policies, treeOpts());
      const tv = $('#treeview');
      const availW = (tv ? tv.clientWidth : document.documentElement.clientWidth) - 2;
      const availH = (tv ? tv.clientHeight : 400) - 2;
      ui.zoom = Math.max(0.5, Math.min(1, Math.round(Math.min(availW / L.width, availH / L.height) * 100) / 100));
      render();
      break;
    }
    case 'zoom': {
      const dir = Number(v);
      if (dir === 0) {
        ui.zoom = 1;
      } else {
        const base = ui.zoom || autoZoom(layoutTree(st.policies, treeOpts()));
        ui.zoom = Math.round(Math.max(0.6, Math.min(1.6, base + dir * 0.15)) * 100) / 100;
      }
      const tv = $('#treeview');
      const ratio = tv ? tv.scrollLeft / Math.max(1, tv.scrollWidth - tv.clientWidth) : 0;
      render();
      const tv2 = $('#treeview');
      if (tv2) tv2.scrollLeft = ratio * Math.max(0, tv2.scrollWidth - tv2.clientWidth);
      break;
    }
    case 'p-up':
      led.levelUp(id);
      closeSheet();
      afterChange();
      break;
    case 'p-down':
      led.levelDown(id);
      closeSheet();
      afterChange();
      break;
    case 'p-off': {
      const hit = led.extinguish(id, 'manual');
      closeSheet();
      afterChange();
      toast(hit.length > 1 ? `已熄灭，连带 ${hit.length - 1} 个子节点` : '已熄灭');
      break;
    }
    case 'prestore':
      led.restore(id);
      closeSheet();
      afterChange();
      toast('已重新点亮');
      break;
    case 'p-delete': {
      const p = C.policyById(st, id);
      const kids = p ? C.childrenOf(st, p.id).length : 0;
      const descN = C.descendantIds(st, id).length;
      openSheet({
        title: '删除国策',
        body: `<p class="tip" style="margin-top:0">「${esc(p ? p.title : '')}」连同它的整棵子树一起删掉。</p>
          <div class="kv"><span class="k">直接子节点</span><span class="v">${kids} 个</span></div>
          <div class="kv"><span class="k">含后代</span><span class="v">${descN} 个</span></div>
          <p class="tip">历史还留在事件日志里，但树上再也看不到了。想留着就改用「熄灭」。</p>
          <div class="btnrow"><button class="btn danger wide" data-act="p-delete-go" data-id="${id}">确认删除${descN ? ` ${descN + 1} 个节点` : ''}</button></div>
          <div class="btnrow"><button class="btn ghost wide" data-act="close">撤回</button></div>`,
      });
      break;
    }
    case 'p-delete-go': {
      const ids = [id, ...C.descendantIds(st, id)];
      st.policies = st.policies.filter((p) => !ids.includes(p.id));
      closeSheet();
      afterChange();
      toast('已删除');
      break;
    }

    /* 结算 / 冻结 */
    case 'settle':
      openSettle();
      break;
    case 'settle-go':
      settleGo();
      break;
    case 'freeze':
      openFreeze();
      break;
    case 'freeze-go': {
      const days = Math.max(1, Math.min(30, Number($('#fz-days').value) || 1));
      const scope = $('#fz-scope').value;
      const note = $('#fz-note').value.trim();
      led.freeze({ scopeIds: scope ? [scope] : null, days, note });
      closeSheet();
      afterChange();
      toast(`已冻结 ${days} 天`);
      break;
    }
    case 'unfreeze':
      openUnfreeze(id);
      break;
    case 'unfreeze-go': {
      const ids = [...els.sheet.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
      led.resolveFreeze(id, ids);
      closeSheet();
      afterChange();
      toast(ids.length ? `已解冻 · ${ids.length} 项熄灭` : '已解冻 · 全部补齐');
      break;
    }

    /* 赢麻了 */
    case 'win':
      openSheet({
        title: '记一笔',
        body: `
          <div class="field">
            <label for="wn-title">今天最大的那件事</label>
            <input id="wn-title" type="text" data-autofocus placeholder="例：搞定高数第三章">
          </div>
          <div class="field">
            <span class="lbl">量级</span>
            <div class="radio-row">
              <label><input type="radio" name="wn-grade" value="small" checked><span>小赢</span></label>
              <label><input type="radio" name="wn-grade" value="mid"><span>中赢</span></label>
              <label><input type="radio" name="wn-grade" value="big"><span>大赢</span></label>
            </div>
          </div>
          <div class="btnrow"><button class="btn primary wide" data-act="win-save">入档</button></div>`,
        focus: '#wn-title',
      });
      break;
    case 'win-save': {
      const title = $('#wn-title').value.trim();
      if (!title) return toast('写一句');
      const grade = ($('input[name="wn-grade"]:checked') || {}).value || 'small';
      led.addWin({ title, grade });
      closeSheet();
      afterChange();
      toast('已入档');
      break;
    }

    /* 导出 / 导入 / 设置 */
    case 'export-md':
      openExportMd();
      break;
    case 'copy-md': {
      const ta = $('#md-out');
      if (ta) copyText(ta.value);
      break;
    }
    case 'dl-md':
      download(`作战档案-${C.dayKey()}.md`, led.exportMarkdown(), 'text/markdown');
      markExport('md');
      toast('已下载');
      break;
    case 'export-json':
      download(`作战档案-${C.dayKey()}.json`, led.toJSON(), 'application/json');
      markExport('json');
      toast('已导出');
      break;
    case 'import':
      openImport();
      break;
    case 'verify': {
      const r = led.verify();
      openSheet({
        title: '哈希链校验',
        body: r.ok
          ? `<p class="tip" style="margin-top:0">完整。${r.count} 条事件首尾相接，没被改过。</p>
             <div class="kv"><span class="k">事件</span><span class="v">${r.count}</span></div>
             <div class="kv"><span class="k">结论</span><span class="v">完整</span></div>`
          : `<div class="warn">第 ${r.seq} 条事件起对不上。账本可能被手工改过，或旧版本数据。</div>`,
      });
      break;
    }
    case 'settings':
      openSettings();
      break;
    case 'settings-save': {
      st.settings.dayStart = Math.max(0, Math.min(12, Number($('#se-day').value) || 4));
      st.settings.auxMinutes = Math.max(1, Math.min(120, Number($('#se-aux').value) || 15));
      st.settings.ritual = $('#se-ritual').checked;
      st.settings.sound = $('#se-sound').checked;
      led._commit('settings.update', { ...st.settings });
      closeSheet();
      afterChange();
      rescheduleAll();
      toast('已保存');
      break;
    }
    case 'sound-test':
      S.unlock();
      S.chime('done');
      toast(S.ready() ? '这是结链的提示音' : '浏览器还没解锁音频，先点一下页面');
      break;
    case 'force-update': {
      (async () => {
        try {
          if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister()));
          }
          if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
        } catch (e) {
          /* 清不掉也照样重载 */
        }
        location.reload();
      })();
      break;
    }
    case 'sync-open':
      openSync();
      break;
    case 'sync-save': {
      const cfg = {
        repo: $('#sy-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''),
        path: $('#sy-path').value.trim() || 'ledger/state.json',
        branch: $('#sy-branch').value.trim() || 'main',
        token: $('#sy-token').value.trim(),
      };
      G.saveCfg(cfg);
      syncCfg = G.loadCfg();
      syncConflict = false;
      closeSheet();
      afterChange();
      toast('已保存到本机');
      break;
    }
    case 'sync-test': {
      const cfg = {
        repo: $('#sy-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''),
        path: $('#sy-path').value.trim() || 'ledger/state.json',
        branch: $('#sy-branch').value.trim() || 'main',
        token: $('#sy-token').value.trim(),
      };
      if (!cfg.repo || !cfg.token) return toast('仓库和令牌都要填');
      toast('测试中…');
      G.test(cfg)
        .then((r) => {
          G.saveCfg(cfg);
          syncCfg = G.loadCfg();
          toast(`连上了：${r.login} → ${r.repo}${r.private ? '（私有）' : '（公开！账本会被人看到）'}`);
          render();
        })
        .catch((e) => toast(e.message || '连接失败'));
      break;
    }
    case 'sync-pull':
      doPull().then((ok) => {
        if (!ok && isDirty() && G.configured(syncCfg)) {
          openSheet({
            title: '本地有未上传的改动',
            body: `<p class="tip" style="margin-top:0">拉取会用云端覆盖本机。先决定保哪边。</p>
              <div class="btnrow"><button class="btn primary wide" data-act="sync-pull-force">用云端覆盖本机</button></div>
              <div class="btnrow"><button class="btn wide" data-act="sync-push-force">改用本机覆盖云端</button></div>
              <div class="btnrow"><button class="btn ghost wide" data-act="close">先不动</button></div>`,
          });
        }
      });
      break;
    case 'sync-pull-force':
      closeSheet();
      doPull({ silent: false, force: true }).then(() => rescheduleAll());
      break;
    case 'sync-push':
    case 'sync-push-force':
      closeSheet();
      doPush().then((ok) => {
        if (!ok && syncConflict) {
          openSheet({
            title: '云端已经变了',
            body: `<p class="tip" style="margin-top:0">这台设备和别处都改过账本。GitHub 上每次上传都是一个 commit，覆盖了也能回滚。</p>
              <div class="btnrow"><button class="btn primary wide" data-act="sync-force-overwrite">用本机覆盖云端</button></div>
              <div class="btnrow"><button class="btn wide" data-act="sync-pull-force">用云端覆盖本机</button></div>
              <div class="btnrow"><button class="btn ghost wide" data-act="close">先不动</button></div>`,
          });
        }
      });
      break;
    case 'sync-force-overwrite': {
      closeSheet();
      (async () => {
        try {
          const remote = await G.pull(syncCfg);
          const res = await G.push(syncCfg, JSON.stringify(st), remote ? remote.sha : null, '账本（强制覆盖）');
          if (res.conflict) throw new Error('还是冲突，稍后再试');
          markSynced(res.sha);
          syncConflict = false;
          render();
          toast('已覆盖云端');
        } catch (e) {
          toast(e.message || '覆盖失败');
        }
      })();
      break;
    }
    case 'sync-forget':
      G.saveCfg({ ...G.DEF });
      syncCfg = G.loadCfg();
      closeSheet();
      afterChange();
      toast('已断开（账本不动）');
      break;
    case 'intro':
      openIntro();
      break;
    case 'intro-ok':
      st.seen = true;
      led._commit('app.seen', {});
      closeSheet();
      afterChange();
      break;
    default:
      break;
  }
}

document.addEventListener('click', onClick);

/* 调试出口：出问题时在控制台看一眼版本 / 音频状态 / 状态对象 */
window.__app = {
  version: APP_VERSION,
  state: () => led.state,
  sound: S,
  sync: G,
};

/* ---------------- 启动 ---------------- */

paintEmblem();
render();
rescheduleAll();

if (!st.seen) {
  openIntro();
} else if (storage && navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

const hashApplied = applySyncHash();
if (!hashApplied) bootSync();
setTimeout(() => {
  if (G.configured(syncCfg)) autoSyncSoon();
}, 3000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
