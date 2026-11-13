/* =============================================================================
 * ui.js 鈥?瑙嗗浘涓庝氦浜掞紙鏃犳鏋讹紝鏃犳瀯寤猴級
 * ========================================================================== */

import * as C from './core.js';
import { layoutTree, edgePath } from './tree.js';
import * as S from './sound.js';
import * as G from './sync.js';

const APP_VERSION = '0.4.1';

/* ---------------- 鍏冪礌 ---------------- */
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

/* ---------------- 瀛樺偍 ---------------- */
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
      toast('鏈湴瀛樺偍鍐欏叆澶辫触锛岃鍒般€屾。妗堛€嶅鍑哄浠?);
    }
  },
});
st = led.state;

const ui = { tab: 'chains', q: '', treeMode: 'map', zoom: 0, treeInit: false };

/* ---------------- 灏忓伐鍏?---------------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TYPE = { passive: '琚姩', semi: '鍗婅鍔?, active: '涓诲姩', mech: '鏈哄埗' };
const GRADE = { small: '灏忚耽', mid: '涓耽', big: '澶ц耽' };

/* ---------------- 澹伴煶 ---------------- */

document.addEventListener(
  'pointerdown',
  () => {
    S.unlock();
    rescheduleAll();
  },
  { once: true, capture: true }
);

/** 缁欐煇鏉￠摼鎺掑ソ鎻愮ず闊筹細缁撻摼涓€澹帮紝棰勭害鍒扮偣涓€涓?*/
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

/* ---------------- 浜戝悓姝?---------------- */

let syncCfg = G.loadCfg();
let syncTimer = null;
let syncBusy = false;
let syncConflict = false;
let lastAutoWarn = 0;

const syncInfo = () => st.sync || { sha: null, at: 0, rev: 0, digest: '' };

/** 鍐呭鎸囩汗锛氫笉鍚?sync 瀛楁锛岀敤鏉ュ垽鏂€滄湰鏈烘槸鍚︾湡鐨勬敼杩団€?*/
function digestOf(s) {
  return C.fnv1a(JSON.stringify({ ...s, sync: null }));
}
const localDigest = () => digestOf(st);
const isDirty = () => localDigest() !== (syncInfo().digest || '');

/** 杩滅鐨勬寚绾瑰繀椤诲厛鎶婄姸鎬佽窇涓€閬嶈鑼冨寲锛屽惁鍒欏拰鏈湴姘歌繙瀵逛笉涓?*/
function remoteDigest(text) {
  const obj = JSON.parse(text);
  if (!obj || obj.app !== C.APP_ID) throw new Error('浜戠鏂囦欢涓嶆槸鏈簲鐢ㄧ殑璐︽湰');
  const fresh = C.Ledger.load(JSON.stringify(obj), { save: null });
  return { digest: digestOf(fresh.state), state: fresh.state };
}

function markSynced(sha) {
  st.sync = { sha, at: Date.now(), rev: st.rev || 0, digest: localDigest() };
  led.save();
}

function syncLine() {
  if (!G.configured(syncCfg)) {
    return '鏈厤缃€傞厤濂藉悗鎵嬫満鍜岀數鑴戝叡鐢ㄤ竴浠借处鏈紱鏁版嵁鏀惧湪浣犺嚜宸辩殑绉佹湁浠撳簱閲屻€?;
  }
  const info = syncInfo();
  if (syncConflict) return '鈿?浜戠鍜屾湰鍦伴兘鏀硅繃锛岄渶瑕佹墜鍔ㄩ€変竴娆★紙鐐广€屾媺鍙栥€嶆垨銆屼笂浼犮€嶏級銆?;
  if (!info.at) return '宸查厤缃紝杩樻病鍚屾杩囥€傚厛鐐广€屼笂浼犮€嶆妸鏈満璐︽湰鎺ㄤ笂鍘汇€?;
  const when = C.fmtHM(info.at);
  return isDirty() ? `鏈湴鏈夋敼鍔ㄦ湭涓婁紶 路 涓婃鍚屾 ${when}` : `宸插悓姝?路 ${when}${info.sha ? ' 路 ' + info.sha.slice(0, 7) : ''}`;
}

function applyRemote(text, sha) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error('浜戠鏂囦欢涓嶆槸鍚堟硶 JSON');
  }
  if (!obj || obj.app !== C.APP_ID) throw new Error('浜戠鏂囦欢涓嶆槸鏈簲鐢ㄧ殑璐︽湰');
  const fresh = C.Ledger.load(JSON.stringify(obj), { save: led._save });
  led.state = fresh.state;
  st = led.state;
  st.sync = { sha, at: Date.now(), rev: st.rev || 0, digest: digestOf(st) };
  led.save();
  syncConflict = false;
  render();
}

async function doPull({ silent = false, force = false } = {}) {
  if (!G.configured(syncCfg)) return false;
  try {
    const remote = await G.pull(syncCfg);
    if (!remote) {
      if (!silent) toast('浜戠杩樻病鏈夋枃浠讹紝鍏堛€屼笂浼犮€嶄竴娆?);
      return false;
    }
    let remoteState;
    try {
      remoteState = JSON.parse(remote.text);
    } catch (e) {
      throw new Error('浜戠鏂囦欢涓嶆槸鍚堟硶 JSON');
    }
    if (!remoteState || remoteState.app !== C.APP_ID) throw new Error('浜戠鏂囦欢涓嶆槸鏈簲鐢ㄧ殑璐︽湰');
    if (!force && remoteDigest(remote.text).digest === localDigest()) {
      markSynced(remote.sha);
      if (!silent) toast('浜戠鍜屾湰鏈轰竴鑷?);
      render();
      return true;
    }
    applyRemote(remote.text, remote.sha);
    if (!silent) toast('宸叉媺鍙栦簯绔处鏈?);
    return true;
  } catch (e) {
    if (!silent) toast(e.message || '鎷夊彇澶辫触');
    return false;
  }
}

async function doPush({ silent = false, force = false } = {}) {
  if (!G.configured(syncCfg)) return false;
  try {
    let sha = syncInfo().sha;
    if (force) {
      // 鏄惧紡瑕嗙洊鏃跺厛鍙栧綋鍓?sha锛屽埆鎷挎棫鐨勫幓鎾?409
      const remote = await G.pull(syncCfg);
      sha = remote ? remote.sha : null;
    }
    const res = await G.push(syncCfg, JSON.stringify(st), sha, `璐︽湰 ${new Date().toLocaleString('zh-CN')}`);
    if (res.conflict) {
      syncConflict = true;
      if (!silent) toast('浜戠宸茬粡鍙樹簡锛屽厛鎷夊彇瀵规瘮');
      render();
      return false;
    }
    markSynced(res.sha);
    syncConflict = false;
    if (!silent) toast('宸蹭笂浼?);
    render();
    return true;
  } catch (e) {
    if (!silent) toast(e.message || '涓婁紶澶辫触');
    return false;
  }
}

/** 鐢?#sync=<base64url>&mode=push|pull 涓€鏉￠摼鎺ュ畬鎴愰厤缃紙鐗囨涓嶄細鍙戝埌鏈嶅姟鍣級 */
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
    toast(`浜戝悓姝ュ凡閰嶇疆锛?{cfg.repo}`);
    if (mode) {
      setTimeout(() => {
        if (mode[1] === 'push') doPush({ force: true });
        else doPull({});
      }, 600);
    }
    return true;
  } catch (e) {
    toast('閰嶇疆閾炬帴鏃犳晥');
    return false;
  }
}

/** 涓よ竟閮藉姩杩囷細鍒寽锛岀瓑浜洪€?*/
function flagConflict(manual) {
  syncConflict = true;
  render();
  const now = Date.now();
  if (manual || now - lastAutoWarn > 60000) {
    lastAutoWarn = now;
    toast('浜戠鍜屾湰鏈洪兘鏀硅繃锛屽悓姝ユ殏鍋滀簡');
  }
  return false;
}

/**
 * 涓夋柟姣旇緝锛氭湰鏈?= 涓婃鍚屾锛熶簯绔?= 涓婃鍚屾锛? * 鍙湁涓€杈瑰姩杩囧氨鑷姩鍚屾锛涗袱杈归兘鍔ㄨ繃灏卞仠涓嬫潵绛変汉閫夈€? */
async function syncNow({ manual = false } = {}) {
  if (!G.configured(syncCfg) || syncBusy) return false;
  syncBusy = true;
  try {
    const remote = await G.pull(syncCfg);
    const local = localDigest();
    const seen = syncInfo().digest || '';

    if (!remote) return await doPush({ silent: !manual, force: true });

    let remoteState;
    try {
      remoteState = JSON.parse(remote.text);
    } catch (e) {
      throw new Error('浜戠鏂囦欢涓嶆槸鍚堟硶 JSON');
    }
    if (!remoteState || remoteState.app !== C.APP_ID) throw new Error('浜戠鏂囦欢涓嶆槸鏈簲鐢ㄧ殑璐︽湰');

    const rd = remoteDigest(remote.text).digest;

    if (rd === local) {
      markSynced(remote.sha);
      syncConflict = false;
      render();
      return true;
    }
    if (!seen) {
      // 鍏ㄦ柊璁惧锛堝嚑涔庢病鍔ㄨ繃锛夌洿鎺ユ帴浜戠锛涘姩杩囧氨鍒寽
      const fresh = (st.events || []).length <= 1 && !st.wins.length && !st.precedents.length;
      if (fresh) {
        applyRemote(remote.text, remote.sha);
        if (manual) toast('宸叉媺鍙栦簯绔处鏈?);
        return true;
      }
      return flagConflict(manual);
    }
    if (local === seen) {
      applyRemote(remote.text, remote.sha);
      if (manual) toast('宸叉媺鍙栦簯绔处鏈?);
      return true;
    }
    if (rd === seen) return await doPush({ silent: !manual });
    return flagConflict(manual);
  } catch (e) {
    if (manual) toast(e.message || '鍚屾澶辫触');
    return false;
  } finally {
    syncBusy = false;
  }
}

/** 鍐茬獊鏃剁殑涓€閿悎骞讹細鍙鈥滃彧浼氬鍔犫€濈殑闆嗗悎鍙栧苟闆?*/
function mergeRemote(text) {
  const remote = JSON.parse(text);
  const union = (a, b) => {
    const ids = new Set(a.map((x) => x.id));
    return [...a, ...(b || []).filter((x) => !ids.has(x.id))];
  };
  st.precedents = union(st.precedents, remote.precedents);
  st.wins = union(st.wins, remote.wins);
  // 鍚屼竴鏉￠摼锛氫繚鐣欒妭鐐规洿澶氱殑閭ｄ唤
  for (const rc of remote.chains || []) {
    const lc = st.chains.find((c) => c.id === rc.id);
    if (!lc) st.chains.push(rc);
    else if ((rc.nodes || []).length > (lc.nodes || []).length) {
      lc.nodes = rc.nodes;
      lc.resets = rc.resets || lc.resets;
    }
  }
  led.save();
  render();
}

function autoSyncSoon() {
  if (!G.configured(syncCfg)) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow({}), 8000);
}

async function bootSync() {
  if (!G.configured(syncCfg)) return;
  await syncNow({});
  rescheduleAll();
}

/* 鍥炲埌鍓嶅彴銆佹仮澶嶈仈缃戙€佷互鍙婃瘡 45 绉掗兘璇曚竴娆?*/
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && G.configured(syncCfg)) syncNow({});
});
window.addEventListener('online', () => {
  if (G.configured(syncCfg)) syncNow({});
});
setInterval(() => {
  if (document.visibilityState === 'visible' && G.configured(syncCfg) && !syncBusy) syncNow({});
}, 45000);

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

/* ---------------- 寮瑰眰 ---------------- */

let lastFocus = null;

function openSheet({ title, body, onMount, focus = null }) {
  lastFocus = document.activeElement;
  els.sheet.innerHTML = `
    <div class="sheet-head">
      <h2 id="sheet-title">${esc(title)}</h2>
      <button class="x" data-act="close" aria-label="鍏抽棴">鉁?/button>
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
/* 鍙湁鈥滄寜涓嬧€濆拰鈥滄澗寮€鈥濋兘鍦ㄩ伄缃╀笂鎵嶅叧銆?   鍚﹀垯浠庡脊灞傞噷鎸変笅銆佹嫋鍒扮獥澶栨澗寮€锛屾祻瑙堝櫒浼氭妸 click 娲惧彂鍒板叡鍚岀鍏堬紙閬僵锛夛紝
   姝ｅ湪濉殑琛ㄥ崟灏辫璇叧浜嗐€?*/
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

/* ---------------- 鍍忕礌绾圭珷 ---------------- */

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

/* ---------------- 娓叉煋锛氫富閾?---------------- */

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
      ? '浠婂ぉ宸茬粌'
      : `涓婃 ${days} 澶╁墠`
    : c.resets.length
    ? '宕╁悗寰呰捣'
    : '鏈紑寮?;

  const head = `
    <div class="chain-head">
      <div class="chain-title">
        <span class="tier ${c.tier === 'elite' ? 'elite' : ''}">${c.tier === 'elite' ? '绮鹃攼' : '鏅€?}</span>
        <h2>${esc(c.name)}</h2>
      </div>
      <div class="chain-n mono" aria-label="涓嬩竴涓妭鐐圭紪鍙?${n}">#${n}</div>
    </div>`;

  if (c.running) {
    const el = now - c.running.start;
    const done = el >= c.minutes * 60000;
    return `<article class="card" data-chain="${c.id}">
      ${head}
      <div class="run">
        <div class="run-top">
          <div class="run-clock mono ${done ? 'done' : ''}" data-clock="${c.id}" role="timer" aria-live="off">${C.fmtClock(el)}</div>
          <span class="run-sub"><span class="led"></span>${done ? '鍙粨' : '杩涜涓?}</span>
        </div>
        <div class="run-sub">鐩爣 ${c.minutes}:00 路 ${C.fmtHM(c.running.start)} 璧烽摼 路 绗?#${c.running.n} 鑺?/div>
        ${segs(c.nodes.length)}
        <div class="btnrow">
          <button class="btn primary" id="done-${c.id}" data-act="complete" data-id="${c.id}">瀹屾垚</button>
          <button class="btn danger" data-act="interrupt" data-id="${c.id}">涓柇</button>
        </div>
      </div>
    </article>`;
  }

  const aux = c.aux
    ? (() => {
        const left = c.aux.dueAt - now;
        const over = left <= 0;
        const sig = (c.aux.stage2 && c.auxSignal2 ? c.auxSignal2 : c.auxSignal) || '鎵撲竴涓搷鎸?;
        const label = over ? '棰勭害瓒呮椂 路 璇ュ垽浜? : c.aux.stage2 ? `鍗虫椂淇″彿 路 ${sig}` : `棰勭害涓?路 ${sig}`;
        return `<div class="aux ${over ? 'overdue' : ''}" data-aux="${c.id}">
          <div class="aux-top">
            <span class="aux-label">${esc(label)}</span>
            <span class="aux-time mono" data-clock="aux-${c.id}">${over ? '00:00' : C.fmtClock(left)}</span>
          </div>
          <div class="aux-goal">鍧愪笅鏍囧織 路 ${esc(c.anchor || '锛堟湭璁鹃敋鐐癸級')}</div>
          <div class="btnrow" style="margin-top:8px">
            <button class="btn primary" data-act="fire" data-id="${c.id}">宸插氨浣嶏紝寮€濮?/button>
            <button class="btn ghost" data-act="disarm" data-id="${c.id}">浣滃簾</button>
          </div>
        </div>`;
      })()
    : '';

  const pending = c.pending
    ? `<div class="note" style="border-color:var(--rust-dim);margin-top:10px;display:flex;gap:10px;align-items:center;justify-content:space-between">
         <span>鏈変竴娆℃湭鍒ょ殑涓柇 路 鐢ㄦ椂 ${C.fmtClock(c.pending.took)}</span>
         <button class="btn danger" data-act="judge" data-id="${c.id}">鐜板湪鍒?/button>
       </div>`
    : '';

  return `<article class="card" data-chain="${c.id}">
    ${head}
    ${c.anchor ? `<p class="anchor">${esc(c.anchor)}</p>` : `<p class="anchor" style="color:var(--faint)">鏈绁炲湥搴т綅</p>`}
    ${segs(c.nodes.length)}
    <div class="chain-meta">
      <span>绱 ${total.toFixed(1)}h</span>
      <span>宕╁ ${c.resets.length}</span>
      <span>${last}</span>
    </div>
    ${aux}
    ${pending}
    <div class="btnrow">
      ${
        c.aux
          ? ''
          : `<button class="btn primary" data-act="start" data-id="${c.id}">寮€濮?/button>
             <button class="btn" data-act="arm" data-id="${c.id}">棰勭害</button>`
      }
      <button class="btn danger" data-act="judge" data-id="${c.id}">鍒ゅ畾</button>
      <button class="btn icon" data-act="chmenu" data-id="${c.id}" aria-label="閾捐缃?>鈰?/button>
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
      <div class="sec-head">鎴樺喌<span class="spacer"></span><span class="hint">${settled ? '浠婃棩宸茬粨绠? : '浠婃棩鏈粨绠?}</span></div>
      <div class="stats cols-3">
        <div class="stat"><b>${todays.length}</b><span>浠婃棩鑺傜偣</span></div>
        <div class="stat"><b>${h.toFixed(1)}<small>h</small></b><span>浠婃棩涓撴敞</span></div>
        <div class="stat"><b>${lit}</b><span>鐐逛寒鍥界瓥</span></div>
      </div>
      ${
        settled
          ? ''
          : `<div class="note" style="margin-top:10px;display:flex;gap:12px;align-items:center;justify-content:space-between">
               <span>浠婃棩灏氭湭缁撶畻銆傚浗绛栦笉浼氳嚜鍔ㄧ伃锛屼篃涓嶄細鑷姩鍙樺ソ銆?/span>
               <button class="btn" data-act="settle">缁撶畻</button>
             </div>`
      }
      ${
        syncConflict
          ? `<div class="warn" style="margin-top:10px;display:flex;gap:12px;align-items:center;justify-content:space-between">
               <span>浜戠鍜屾湰鏈洪兘鏀硅繃锛岃嚜鍔ㄥ悓姝ユ殏鍋溿€?/span>
               <button class="btn" data-act="sync-conflict">澶勭悊</button>
             </div>`
          : ''
      }
    </section>`;

  const list = st.chains.length
    ? st.chains.map((c) => chainCard(c, now)).join('')
    : `<div class="empty">杩樻病鏈夐摼銆?br>涓€鏉￠摼 = 涓€涓敋鐐?+ 涓€灏忔椂銆?/div>`;

  return `${hero}
    <section class="section">
      <div class="sec-head">涓婚摼<span class="spacer"></span><span class="hint">${st.chains.length} 鏉?/span></div>
      ${list}
    </section>`;
}

/* ---------------- 娓叉煋锛氬浗绛栨爲 ---------------- */

function policyRow(p, depth) {
  const mark = p.state === 'lit' ? '鈻? : p.state === 'frozen' ? '鈻? : '鈻?;
  const kids = C.childrenOf(st, p.id);
  const litKids = kids.filter((k) => k.state === 'lit').length;
  const tag = p.isGroup ? `缁?${litKids}/${kids.length}` : TYPE[p.type] || '琚姩';
  const pct = C.habitPct(p);
  const stateWord = p.state === 'lit' ? '鐐逛寒' : p.state === 'frozen' ? '鍐荤粨' : '鍦ㄥ簱';
  const aria = `${p.title}锛?{tag}锛?{stateWord}锛?{p.daysLit || 0} 澶ー;
  return `<div class="node ${p.state}" data-d="${depth}" style="--d:${depth}" role="listitem" aria-label="${esc(aria)}">
    <div class="node-line">
      <span class="node-mark" aria-hidden="true">${mark}</span>
      <span class="node-title">${esc(p.title)}</span>
      <span class="tag ${p.type === 'active' ? 'active' : ''}">${esc(tag)}</span>
      ${p.level ? `<span class="lv">+${p.level}</span>` : ''}
      <button class="node-more" data-act="pmenu" data-id="${p.id}" aria-label="${esc(p.title)} 鎿嶄綔">鈰?/button>
    </div>
    ${p.cond ? `<div class="node-sub">${esc(p.cond)}</div>` : ''}
    <div class="node-sub" style="margin-top:2px">${p.daysLit || 0} 澶?路 鍐呭寲 ${Math.round(pct)}%</div>
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

/** 棣栨杩涘叆鏃惰嚜鍔ㄧ缉鍒拌兘鐪嬪叏锛涗笉瓒呰繃 1锛屼篃涓嶅皬浜?0.8 */
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
        ? `缁?${litKids}/${kids.length}`
        : `${TYPE[p.type] || '琚姩'}${p.level ? ` +${p.level}` : ''} 路 ${p.daysLit || 0}澶ー;
      const word = p.state === 'lit' ? '鐐逛寒' : p.state === 'frozen' ? '鍐荤粨' : '鍦ㄥ簱';
      return `<div class="tnode ${p.state}${p.isGroup ? ' grp' : ''}" style="left:${x}px;top:${y}px;width:${L.nodeW}px;height:${L.nodeH}px">
        <i class="tstrip ${p.type}" aria-hidden="true"></i>
        <button class="tnode-main" data-act="pnode" data-id="${p.id}" aria-label="${esc(p.title)}锛?{meta}锛?{word}">
          <span class="t-title">${esc(p.title)}</span>
          <span class="t-meta">${esc(meta)}</span>
        </button>
        ${p.state === 'lit' ? `<button class="tnode-add" data-act="p-add" data-id="${p.id}" aria-label="鍦ㄣ€?{esc(p.title)}銆嶄笅鍔犲瓙鑺傜偣">+</button>` : ''}
      </div>`;
    })
    .join('');
  return `
    <div class="treebar">
      <span class="thint">鎷栧姩 路 <b>+</b> 鎺ュ瓙鑺傜偣</span>
      <div class="ttools">
        <button class="tbtn" data-act="zoom" data-v="-1" aria-label="缂╁皬">鈭?/button>
        <button class="tbtn" data-act="zoom" data-v="0" aria-label="鍘熷澶у皬">1:1</button>
        <button class="tbtn" data-act="zoom" data-v="1" aria-label="鏀惧ぇ">+</button>
        <button class="tbtn" data-act="fit" aria-label="缂╂斁鍒板畬鏁存樉绀?>閫傞厤</button>
        <button class="tbtn" data-act="tree-list">鍒楄〃</button>
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
      <span class="thint">鍒楄〃 路 缂╄繘鍗冲眰绾?/span>
      <div class="ttools"><button class="tbtn" data-act="tree-map">鍦板浘</button></div>
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
           <span>浠婃棩灏氭湭缁撶畻銆?/span><button class="btn" data-act="settle">缁撶畻</button></div>`
      : '',
    dueFreeze
      ? `<div class="warn" style="margin:0 0 10px">姘村瘑闅旇埍宸插埌鏈燂紙${C.fmtHM(dueFreeze.deadline)}锛夈€傝瑙ｅ喕缁撶畻浜嗐€?           <div class="btnrow"><button class="btn" data-act="unfreeze" data-id="${dueFreeze.id}">瑙ｅ喕缁撶畻</button></div></div>`
      : '',
    openFreeze.length && !dueFreeze
      ? `<div class="note" style="margin:0 0 10px;display:flex;gap:12px;align-items:center;justify-content:space-between">
           <span>鍐荤粨涓?路 ${openFreeze.length} 鑸?路 鏈€杩戝埌鏈?${C.fmtHM(Math.min(...openFreeze.map((f) => f.deadline)))}</span>
           <button class="btn" data-act="unfreeze" data-id="${openFreeze[0].id}">鎻愬墠瑙ｅ喕</button>
         </div>`
      : '',
  ].join('');

  const body = !rows.length
    ? `<div class="empty">鏍戞槸绌虹殑銆?br>浠庝竴涓€屼笉鍋氫簨銆嶇殑琚姩鍥界瓥寮€濮嬫渶绋炽€?/div>`
    : ui.treeMode === 'list'
    ? treeList()
    : treeMap();

  return `
    <section class="section">
      <div class="sec-head">鍥界瓥鏍?span class="spacer"></span>
        <button class="btn" data-act="freeze" style="min-height:30px;padding:0 9px;font-size:11px">姘村瘑闅旇埍</button>
      </div>
      <div class="chain-meta" style="margin:0 0 10px">
        <span>鐐逛寒 ${litN}</span><span>鍐荤粨 ${frozenN}</span><span>鍦ㄥ簱 ${stockN}</span>
      </div>
      ${banner}
      ${body}
      <details class="manual">
        <summary>瑙勫垯澶囧繕</summary>
        <p>路 姣忓ぉ鏈€澶氱偣浜竴涓浗绛栵紱宕╂帀涓€涓紝瀹冨拰鎵€鏈夊瓙鑺傜偣涓€璧烽€€鍥炲簱锛屼絾<i>鍐呭寲澶╂暟涓嶄涪</i>銆?br>
           路 缁撶畻榛樿鍏ㄩ儴淇濇寔鐐逛寒锛屼綘鍙嬀銆屽穿浜嗐€嶇殑銆?br>
           路 杩炵嚎浠庣埗鑺傜偣鎸囧悜瀛愯妭鐐癸紱铏氱嚎锛濆湪搴撴垨鍐荤粨銆?br>
           路 鐢熺梾/鍑哄樊鐢ㄣ€屾按瀵嗛殧鑸便€嶅喕缁擄紝鍒版湡涓€娆¤ˉ榻愩€?/p>
      </details>
    </section>`;
}

/* ---------------- 娓叉煋锛氬垽渚?---------------- */

function viewPrecedents() {
  const list = [...st.precedents].sort((a, b) => b.at - a.at);
  const items = list
    .map((p) => {
      const c = C.chainById(st, p.chainId);
      const txt = `${p.behavior} ${c ? c.name : ''} ${p.note || ''}`;
      return `<div class="pc" data-s="${esc(txt.toLowerCase())}">
        <span class="verdict ${p.decision}">${p.decision === 'allow' ? '鍑? : '椹?}</span>
        <div style="flex:1;min-width:0">
          <p class="pc-b">${esc(p.behavior)}</p>
          <p class="pc-m">${esc(c ? c.name : '宸插垹閾?)} 路 ${C.fmtHM(p.at)} 路 ${p.decision === 'allow' ? '姘镐箙鏀捐' : '鍒や负澶辫触'}</p>
          ${p.note ? `<p class="pc-m" style="color:var(--dim)">${esc(p.note)}</p>` : ''}
        </div>
      </div>`;
    })
    .join('');

  return `
    <section class="section">
      <div class="sec-head">鍒や緥<span class="spacer"></span><span class="hint">${list.length} 鏉?/span></div>
      <input class="search" id="pq" type="search" placeholder="鎼滃垽渚嬧€? value="${esc(ui.q)}" aria-label="鎼滅储鍒や緥">
      <div style="margin-top:4px" id="plist">
        ${list.length ? items : `<div class="empty" style="margin-top:12px">杩樻病鏈夊垽渚嬨€?br>鍒ゅ畾鏃躲€屽厑璁搞€嶄竴娆★紝灏辫嚜鍔ㄧ珛涓€鏉★紝姘镐箙鐢熸晥銆?/div>`}
      </div>
      ${
        list.length
          ? `<div class="note" style="margin-top:12px">涓嬪繀涓轰緥锛氫竴鏉°€屽厑璁搞€嶅氨绛変簬鎵胯浠ュ悗鍚屾牱鎯呭喌涓€寰嬪厑璁搞€傛墍浠ユ寜涓嬪幓涔嬪墠锛屽厛鐪嬫竻浠ｄ环銆?/div>`
          : ''
      }
    </section>`;
}

/* ---------------- 娓叉煋锛氭。妗?---------------- */

function viewArchive() {
  const s = C.stats(st);
  const wins = st.wins.slice(0, 12);
  const expDays = st.lastExportAt ? Math.floor((Date.now() - st.lastExportAt) / 86400000) : null;
  const backupTip =
    expDays === null
      ? '杩樻病瀵煎嚭杩囥€傛暟鎹彧鍦ㄨ繖鍙拌澶囦笂锛屾竻缂撳瓨灏辨病浜嗐€?
      : expDays >= 7
      ? `涓婃瀵煎嚭 ${expDays} 澶╁墠浜嗐€傚缓璁涓€浠姐€俙
      : `涓婃瀵煎嚭锛?{expDays === 0 ? '浠婂ぉ' : expDays + ' 澶╁墠'}`;
  return `
    <section class="section">
      <div class="sec-head">缁熻<span class="spacer"></span><span class="hint">鑷?${C.fmtDate(st.createdAt)}</span></div>
      <div class="stats">
        <div class="stat"><b>${s.nodes}</b><span>鑺傜偣</span></div>
        <div class="stat"><b>${s.hours.toFixed(1)}<small>h</small></b><span>绱涓撴敞</span></div>
        <div class="stat"><b>${s.longest}</b><span>鏈€闀块摼</span></div>
        <div class="stat"><b>${s.resets}</b><span>宕╁</span></div>
        <div class="stat"><b>${s.precedents}</b><span>鍒や緥</span></div>
        <div class="stat"><b>${s.lit}</b><span>鐐逛寒</span></div>
        <div class="stat"><b>${s.stock}</b><span>鍦ㄥ簱</span></div>
        <div class="stat"><b>${s.wins}</b><span>鍠滄姤</span></div>
      </div>
    </section>

    <section class="section">
      <div class="sec-head">璧㈤夯浜?span class="spacer"></span><button class="btn ghost" data-act="win" style="min-height:32px;padding:0 8px">璁颁竴绗?/button></div>
      ${
        wins.length
          ? wins
              .map(
                (w) => `<div class="win">
                  <span class="g ${w.grade}">${GRADE[w.grade] || '灏忚耽'}</span>
                  <span class="t">${esc(w.title)}</span>
                  <span class="d">${esc(w.date)}</span>
                </div>`
              )
              .join('')
          : `<div class="empty">浠婂ぉ鏈変粈涔堝€煎緱涓€鎻愮殑锛?br>鎶婃渶澶х殑閭ｄ欢鎷挎潵鍛藉悕杩欎竴澶┿€?/div>`
      }
    </section>

    <section class="section">
      <div class="sec-head">浜戝悓姝?span class="spacer"></span><span class="hint">${G.configured(syncCfg) ? '宸查厤缃? : '鏈厤缃?}</span></div>
      <div class="note">${esc(syncLine())}</div>
      ${
        syncConflict
          ? `<div class="btnrow" style="margin-top:10px"><button class="btn danger wide" data-act="sync-conflict">澶勭悊鍐茬獊</button></div>`
          : ''
      }
      <div class="btnrow" style="margin-top:10px">
        <button class="btn" data-act="sync-pull" ${G.configured(syncCfg) ? '' : 'disabled'}>鎷夊彇</button>
        <button class="btn" data-act="sync-push" ${G.configured(syncCfg) ? '' : 'disabled'}>涓婁紶</button>
      </div>
      <div class="btnrow">
        <button class="btn ghost wide" data-act="sync-open">${G.configured(syncCfg) ? '璁剧疆 / 鏂紑' : '閰嶇疆浜戝悓姝ワ紙GitHub 绉佹湁浠撳簱锛?}</button>
      </div>
    </section>

    <section class="section">
      <div class="sec-head">璐︽湰</div>
      <div class="btnrow" style="margin-top:0">
        <button class="btn" data-act="export-md">瀵煎嚭 Markdown</button>
        <button class="btn" data-act="export-json">瀵煎嚭 JSON</button>
      </div>
      <div class="btnrow">
        <button class="btn" data-act="import">瀵煎叆澶囦唤</button>
        <button class="btn" data-act="verify">鏍￠獙鍝堝笇閾?/button>
      </div>
      <p class="tip" style="color:var(--faint);font-size:12px;margin-top:10px">${backupTip}</p>
    </section>

    <section class="section">
      <div class="sec-head">璁剧疆</div>
      <div class="btnrow" style="margin-top:0">
        <button class="btn" data-act="settings">瑙勫垯鍙傛暟</button>
        <button class="btn ghost" data-act="intro">閲嶇湅璇存槑</button>
      </div>
      <div class="btnrow">
        <button class="btn ghost wide" data-act="force-update">寮哄埗鏇存柊锛堟竻缂撳瓨骞堕噸杞斤級</button>
      </div>
    </section>

    <section class="section">
      <div class="sec-head">鍏充簬</div>
      <div class="note">
        鏂规硶涓庡師鏂囷細<b>銆婂浣曟彁楂樿嚜鍒跺姏锛熴€?/b> edmond锛岀煡涔庛€?br>
        鐗堟湰 ${APP_VERSION} 路 鏈伐鍏峰彧鍋氳处鏈笌鍒や緥锛屼笉鍌績銆佷笉璇勫垎銆?br>
        鏁版嵁鍏ㄩ儴鍦ㄦ湰鏈猴紝闅忔椂鍙鍑虹寮€銆?      </div>
    </section>`;
}

/* ---------------- 娓叉煋涓灑 ---------------- */

function renderDock() {
  const today = C.dayKey(Date.now(), st.settings.dayStart);
  const settled = st.settlements[today];
  let html = '';
  if (ui.tab === 'chains') {
    html = `<button class="btn primary" data-act="new-chain">鏂板缓浣滄垬閾?/button>`;
  } else if (ui.tab === 'policies') {
    html = `<button class="btn" data-act="settle">缁撶畻</button>
            <button class="btn primary" data-act="new-policy">鐐逛寒鍥界瓥</button>`;
  } else if (ui.tab === 'archive') {
    html = `<button class="btn primary" data-act="export-md">瀵煎嚭 Markdown</button>`;
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
  els.seal.textContent = v.ok ? '瀹屾暣' : '寮傚父';
  els.seal.classList.toggle('bad', !v.ok);
  els.seal.title = v.ok ? `鍝堝笇閾惧畬鏁?路 ${v.count} 鏉′簨浠禶 : `绗?${v.seq} 鏉′簨浠惰捣寮傚父`;
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
      // 鍙湁鐪熸孩鍑烘椂鎵嶆樉绀哄彸缂樻笎闅愶紝鍚﹀垯浼氬帇鏆楁渶鍙充竴鍒?      const fade = document.querySelector('.tfade');
      if (fade) fade.style.display = tv.scrollWidth > tv.clientWidth + 2 ? 'block' : 'none';
    }
    if (tv && !ui.treeInit) {
      ui.treeInit = true;
      requestAnimationFrame(() => {
        tv.scrollLeft = 0; // 浠庢牴寮€濮嬬湅锛屽彸杈硅嚜宸辨嫋
      });
    }
  }
}

/* ---------------- 璁℃椂鍣?---------------- */

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
      // 浜屾淇″彿锛氬墿 30 绉掓椂鎶婃彁绀哄垏鍒般€屽嵆鏃跺惎鍔ㄤ俊鍙枫€?      if (left <= 30000 && left > 0 && c.aux.second && !c.aux.stage2) {
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
          const sig = (c.aux.stage2 && c.auxSignal2 ? c.auxSignal2 : c.auxSignal) || '鎵撲竴涓搷鎸?;
          label.textContent = left <= 0 ? '棰勭害瓒呮椂 路 璇ュ垽浜? : c.aux.stage2 ? `鍗虫椂淇″彿 路 ${sig}` : `棰勭害涓?路 ${sig}`;
        }
      }
      if (left <= 0 && !c.aux.notified) {
        c.aux.notified = true;
        toast('棰勭害鍒扮偣锛氱幇鍦ㄥ幓瑙﹀彂閿氱偣');
      }
    }
  }
}
setInterval(tick, 1000);

/* ---------------- 娴佺▼锛氳捣閾?---------------- */

function openRitual(id) {
  const c = C.chainById(st, id);
  if (!c) return;
  if (!st.settings.ritual) {
    const n = C.nextN(c);
    if (led.start(id)) {
      render();
      toast(`绗?#${n} 鑺傝捣閾綻);
    }
    return;
  }
  openSheet({
    title: '璧烽摼',
    body: `
      <p class="tip" style="margin-top:0">绁炲湥搴т綅 路 閿氱偣</p>
      <div class="note" style="font-size:16px;color:var(--ink);border-color:var(--brass-dim)">${esc(c.anchor || '锛堣繕娌¤閿氱偣锛?)}</div>
      <p class="tip">涓€鏃﹁Е鍙戯紝灏卞繀椤讳互鏈€濂界殑鐘舵€佸畬鎴?${c.minutes} 鍒嗛挓銆備腑閫旂牬鎴掞紝璧板垽瀹氾紝娌℃湁绗笁绉嶃€?/p>
      <div class="btnrow">
        <button class="btn primary wide" data-act="start-go" data-id="${id}">宸插氨浣?路 寮€濮?/button>
      </div>
      <div class="btnrow">
        <button class="btn ghost wide" data-act="close">鍐嶇瓑绛?/button>
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
      toast(`绗?#${r.n} 鑺傚叆妗);
    }
    return;
  }
  openSheet({
    title: '鏈弧鏃堕暱',
    body: `
      <p class="tip" style="margin-top:0">杩樺樊 <b class="mono">${C.fmtClock(target - el)}</b>銆傛寜瑙勫垯锛岀幇鍦ㄧ粨鏉熶笉绠楀畬鎴愩€?/p>
      <div class="kv"><span class="k">宸茬敤</span><span class="v">${C.fmtClock(el)}</span></div>
      <div class="kv"><span class="k">鐩爣</span><span class="v">${c.minutes}:00</span></div>
      <div class="btnrow">
        <button class="btn primary wide" data-act="close">缁х画涓撴敞</button>
      </div>
      <div class="btnrow">
        <button class="btn danger" data-act="interrupt" data-id="${id}">涓柇 路 璧板垽瀹?/button>
        <button class="btn ghost" data-act="force-done" data-id="${id}">浠嶇畻瀹屾垚</button>
      </div>`,
  });
}

/* ---------------- 娴佺▼锛氬垽瀹?---------------- */

function matchHTML(chainId, behavior) {
  const ms = C.similarPrecedents(st, chainId, behavior);
  if (!ms.length) return `<p class="tip" style="color:var(--faint)">娌℃湁鐩镐技鍒や緥鈥斺€旇繖涓€鍒ゅ氨鏄厛渚嬨€?/p>`;
  return (
    `<p class="tip" style="margin-bottom:6px">鐩镐技鍒や緥</p>` +
    ms
      .map(
        (m) => `<p class="match ${m.p.decision}">
          ${m.p.decision === 'allow' ? '鍑? : '椹?} 路 <b>${esc(m.p.behavior)}</b> 路 ${C.fmtHM(m.p.at)}
        </p>`
      )
      .join('')
  );
}

function openJudge(chainId, preset = '') {
  const c = C.chainById(st, chainId);
  if (!c) return;
  const chips = ['鐪嬫墜鏈?, '鍥炲井淇?, '鍒疯棰?, '绂诲紑搴т綅', '鎺ョ數璇?, '璧扮', '鍋氬埆鐨勪簨'];
  openSheet({
    title: `鍒ゅ畾 路 ${c.name}`,
    body: `
      <p class="tip" style="margin-top:0">涓ら€変竴锛屾病鏈夌涓夌銆?/p>
      <div class="chips">${chips
        .map((x) => `<button class="chip" data-act="chip" data-v="${x}">${x}</button>`)
        .join('')}</div>
      <div class="field" style="margin-top:12px">
        <label for="jb">鍙戠敓浜嗕粈涔?/label>
        <input id="jb" type="text" data-autofocus placeholder="渚嬶細鍥炰簡鏉″井淇★紝涓ゅ垎閽? value="${esc(preset)}">
      </div>
      <div id="matches">${matchHTML(chainId, preset)}</div>
      <div class="sheet-foot">
        <div class="btnrow" style="margin:0">
          <button class="btn danger" data-act="judge-deny" data-id="${chainId}">鍒や负澶辫触</button>
          <button class="btn primary" data-act="judge-allow" data-id="${chainId}">鍏佽</button>
        </div>
        <p class="tip" style="margin-top:8px">澶辫触锛濋摼娓呴浂鍥?#1銆傚厑璁革紳璇ヨ涓哄湪鏈摼姘镐箙鏀捐锛屼笖浠ュ悗蹇呴』涓€寰嬪厑璁搞€?/p>
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
    title: '纭娓呴浂',
    body: `
      <p class="tip" style="margin-top:0">鍒や负澶辫触锛?b>${esc(behavior)}</b></p>
      <div class="kv"><span class="k">灏嗘竻闆?/span><span class="v">${n} 鑺?鈫?#1</span></div>
      <div class="kv"><span class="k">鍐呭寲杩涘害</span><span class="v">淇濈暀</span></div>
      <p class="tip">宕╁浼氳鍏ユ。妗堬紝鍥界瓥鐨勫唴鍖栧ぉ鏁颁笉鍙楀奖鍝嶃€?/p>
      <div class="btnrow">
        <button class="btn danger wide" data-act="judge-deny-go" data-id="${chainId}" data-v="${esc(behavior)}">纭娓呴浂</button>
      </div>
      <div class="btnrow"><button class="btn ghost wide" data-act="close">鎾ゅ洖</button></div>`,
  });
}

function confirmAllow(chainId, behavior) {
  openSheet({
    title: '纭绔嬩緥',
    body: `
      <p class="tip" style="margin-top:0">鍏佽锛?b>${esc(behavior)}</b></p>
      <div class="warn">浠庢浠ュ悗锛屽悓鏍风殑鎯呭喌鍦ㄨ繖涓€鏉￠摼閲屼竴寰嬫斁琛岋紝涓嶈兘鍐嶇畻杩濊銆傝繖鏄€屼笅蹇呬负渚嬨€嶃€?/div>
      <div class="btnrow">
        <button class="btn primary wide" data-act="judge-allow-go" data-id="${chainId}" data-v="${esc(behavior)}">纭姘镐箙鏀捐</button>
      </div>
      <div class="btnrow"><button class="btn ghost wide" data-act="close">鎾ゅ洖</button></div>`,
  });
}

/* ---------------- 娴佺▼锛氱粨绠?---------------- */

function openSettle() {
  const today = C.dayKey();
  const done = st.settlements[today];
  if (done) {
    const broken = done.brokenIds.length;
    openSheet({
      title: `缁撶畻 路 ${today}`,
      body: `<p class="tip" style="margin-top:0">浠婂ぉ宸茬粡缁撶畻杩囦簡銆?/p>
        <div class="kv"><span class="k">鐔勭伃</span><span class="v">${broken} 椤?/span></div>
        ${done.note ? `<p class="tip">澶囨敞锛?{esc(done.note)}</p>` : ''}
        <p class="tip">涓€澶╁彧缁撶畻涓€娆★紝閬垮厤鍙嶅鏀瑰垽銆?/p>`,
    });
    return;
  }
  const lit = st.policies.filter((p) => p.state === 'lit');
  if (!lit.length) {
    openSheet({
      title: '缁撶畻',
      body: `<p class="tip" style="margin-top:0">娌℃湁鐐逛寒鐨勫浗绛栧彲缁撶畻銆傚厛鍘荤偣浜竴涓€?/p>
        <div class="btnrow"><button class="btn primary wide" data-act="new-policy">鐐逛寒鍥界瓥</button></div>`,
    });
    return;
  }
  const rows = C.treeOrder(st).filter((r) => r.p.state === 'lit');
  openSheet({
    title: '鏃ョ粨绠?,
    body: `
      <p class="tip" style="margin-top:0">榛樿鍏ㄩ儴淇濇寔鐐逛寒銆傚彧鍕?b>宕╀簡</b>鐨勩€?/p>
      <div style="border-top:1px solid var(--line)">
        ${rows
          .map(
            (r) => `<label class="check-row" style="padding-left:${r.depth * 14}px">
              <input type="checkbox" value="${r.p.id}">
              <span class="txt">${esc(r.p.title)}<span class="sub"> 路 ${TYPE[r.p.type] || '琚姩'}${r.p.isGroup ? ' 路 缁? : ''}</span></span>
            </label>`
          )
          .join('')}
      </div>
      <div class="field" style="margin-top:14px">
        <label for="s-note">澶囨敞锛堝彲閫夛級</label>
        <input id="s-note" type="text" placeholder="渚嬶細鎰熷啋锛岃汉浜嗕竴澶?>
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="settle-go">纭缁撶畻</button></div>`,
  });
}

function settleGo() {
  const ids = [...els.sheet.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
  const note = ($('#s-note') && $('#s-note').value.trim()) || '';
  const today = C.dayKey();
  led.settle(today, ids, note);
  closeSheet();
  render();
  toast(ids.length ? `宸茬粨绠?路 ${ids.length} 椤圭唲鐏璥 : '宸茬粨绠?路 鍏ㄦ暟瀛樻椿');
}

/* ---------------- 娴佺▼锛氬浗绛?---------------- */

function openPolicySheet(id) {
  const p = C.policyById(st, id);
  if (!p) return;
  const kids = C.childrenOf(st, p.id);
  const descN = C.descendantIds(st, p.id).length;
  const word = p.state === 'lit' ? '鐐逛寒' : p.state === 'frozen' ? '鍐荤粨' : '鍦ㄥ簱';
  openSheet({
    title: p.title,
    body: `
      <div class="kv"><span class="k">绫诲瀷</span><span class="v">${TYPE[p.type] || '琚姩'}${p.isGroup ? ` 路 缁勶紙閰嶉 ${p.quota}锛塦 : ''}</span></div>
      <div class="kv"><span class="k">鐘舵€?/span><span class="v">${word}${p.level ? ` 路 寮哄寲 +${p.level}` : ''}</span></div>
      <div class="kv"><span class="k">鍐呭寲</span><span class="v">${p.daysLit || 0} 澶?/span></div>
      <div class="kv"><span class="k">瀛愯妭鐐?/span><span class="v">${kids.length} 涓?{descN ? `锛堝惈鍚庝唬 ${descN}锛塦 : ''}</span></div>
      ${p.cond ? `<p class="tip">${esc(p.cond)}</p>` : ''}
      <div class="btnrow">
        <button class="btn primary" data-act="p-add" data-id="${id}">鍔犲瓙鑺傜偣</button>
        <button class="btn" data-act="p-up" data-id="${id}">寮哄寲 +1</button>
      </div>
      <div class="btnrow">
        ${
          p.state === 'lit'
            ? `<button class="btn danger" data-act="p-off" data-id="${id}">鐔勭伃${descN ? `锛堣繛甯?${descN}锛塦 : ''}</button>`
            : `<button class="btn" data-act="prestore" data-id="${id}">閲嶆柊鐐逛寒</button>`
        }
        <button class="btn ghost" data-act="p-delete" data-id="${id}">鍒犻櫎</button>
      </div>
      ${p.level ? `<div class="btnrow"><button class="btn ghost wide" data-act="p-down" data-id="${id}">闄嶄竴绾?/button></div>` : ''}`,
  });
}

function openNewPolicy(parentId = null) {
  const rows = C.treeOrder(st).filter((r) => r.p.state === 'lit');
  const parent = parentId ? C.policyById(st, parentId) : null;
  const opts =
    `<option value="" ${parent ? '' : 'selected'}>鈥?鏂板垎鏀紙鏍硅妭鐐癸級</option>` +
    rows
      .map(
        (r) =>
          `<option value="${r.p.id}" ${r.p.id === parentId ? 'selected' : ''}>${'銆€'.repeat(r.depth)}${esc(r.p.title)}</option>`
      )
      .join('');
  openSheet({
    title: parent ? `鍦ㄣ€?{parent.title}銆嶄笅鍔犲瓙鑺傜偣` : '鐐逛寒鏂板浗绛?,
    body: `
      <p class="tip" style="margin-top:0">姣忓ぉ鏈€澶氱偣浜竴涓€傝秺鍌汇€佽秺琚姩銆佽秺閫嗛涔熻兘娲伙紝瓒婇€傚悎鏀炬牴閮ㄣ€?/p>
      <div class="field">
        <label for="np-title">鍚嶅瓧</label>
        <input id="np-title" type="text" data-autofocus placeholder="渚嬶細涓嶅湪娌欏彂涓婄敤鎵嬫満">
      </div>
      <div class="field">
        <span class="lbl">绫诲瀷</span>
        <div class="radio-row">
          <label><input type="radio" name="np-type" value="passive" checked><span>琚姩</span></label>
          <label><input type="radio" name="np-type" value="semi"><span>鍗婅鍔?/span></label>
          <label><input type="radio" name="np-type" value="active"><span>涓诲姩</span></label>
          <label><input type="radio" name="np-type" value="mech"><span>鏈哄埗</span></label>
        </div>
        <p class="tip">琚姩锛濆湪鐗瑰畾鍦烘櫙銆屼笉鍋氭煇浜嬨€嶏紱鍗婅鍔紳濡傛灉 A 灏?B锛涗富鍔紳姣忓ぉ瑕佹姇鍏ワ紙鏈€瀹规槗宕╋紝灏戠敤锛夈€?/p>
      </div>
      <div class="field">
        <label for="np-cond">瑙勫垯鍘熸枃</label>
        <input id="np-cond" type="text" placeholder="渚嬶細鍥炲杩涢棬鍚?15 鍒嗛挓鍐呭繀椤绘礂婢?>
      </div>
      <div class="field">
        <label for="np-parent">鎺ュ埌鍝釜鑺傜偣涓?/label>
        <select id="np-parent">${opts}</select>
      </div>
      <label class="check-row" style="border-bottom:0">
        <input type="checkbox" id="np-group">
        <span class="txt">杩欐槸銆屽浗绛栫粍銆?span class="sub"> 路 鍏佽缁勫唴 N 涓垚鍛樺穿鎺?/span></span>
      </label>
      <div class="field" id="np-quota-wrap" hidden>
        <label for="np-quota">瀹归敊鍚嶉锛堜寒鐫€鐨勬渶灏戝嚑涓紝缁勬墠绠椾寒锛?/label>
        <input id="np-quota" type="number" min="1" max="20" value="2">
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="np-save">鐐逛寒</button></div>`,
    onMount(root) {
      const g = root.querySelector('#np-group');
      g.addEventListener('change', () => {
        root.querySelector('#np-quota-wrap').hidden = !g.checked;
      });
    },
    focus: '#np-title',
  });
}

/* ---------------- 娴佺▼锛氬喕缁?---------------- */

function openFreeze() {
  const rows = C.treeOrder(st);
  const opts =
    `<option value="">鍏ㄩ儴鐐逛寒鐨勫浗绛?/option>` +
    rows
      .filter((r) => r.p.state === 'lit')
      .map((r) => `<option value="${r.p.id}">${'銆€'.repeat(r.depth)}${esc(r.p.title)} 鍙婂叾瀛愯妭鐐?/option>`)
      .join('');
  openSheet({
    title: '姘村瘑闅旇埍',
    body: `
      <p class="tip" style="margin-top:0">鐢熺梾銆佸嚭宸€佺獊鍙戯細鍏堝喕缁擄紝鍒瀹冩妸鏁存５鏍戝甫宕┿€傚埌鏈熷繀椤讳竴娆℃€цˉ榻愩€?/p>
      <div class="field">
        <label for="fz-days">鍐荤粨澶╂暟</label>
        <input id="fz-days" type="number" min="1" max="30" value="2">
      </div>
      <div class="field">
        <label for="fz-scope">鑼冨洿</label>
        <select id="fz-scope">${opts}</select>
      </div>
      <div class="field">
        <label for="fz-note">缂樼敱</label>
        <input id="fz-note" type="text" placeholder="渚嬶細鍙戠儳锛屽崸搴?>
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="freeze-go">鍐荤粨</button></div>`,
    focus: '#fz-days',
  });
}

function openUnfreeze(id) {
  const f = st.freezes.find((x) => x.id === id);
  if (!f) return;
  const frozen = st.policies.filter((p) => p.state === 'frozen');
  openSheet({
    title: '瑙ｅ喕缁撶畻',
    body: `
      <p class="tip" style="margin-top:0">鍐荤粨鏈熼棿涓嶇畻杩濈害銆傚嬀閫?b>娌¤兘琛ヤ笂</b>鐨勶紝鍏朵綑鍥炲埌鐐逛寒銆?/p>
      <div style="border-top:1px solid var(--line)">
        ${frozen
          .map(
            (p) => `<label class="check-row">
              <input type="checkbox" value="${p.id}">
              <span class="txt">${esc(p.title)}<span class="sub"> 路 ${TYPE[p.type] || '琚姩'}</span></span>
            </label>`
          )
          .join('')}
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="unfreeze-go" data-id="${id}">纭瑙ｅ喕</button></div>`,
  });
}

/* ---------------- 娴佺▼锛氶摼璁剧疆 ---------------- */

function openChainMenu(id) {
  const c = C.chainById(st, id);
  if (!c) return;
  openSheet({
    title: `閾?路 ${c.name}`,
    body: `
      <div class="kv"><span class="k">绁炲湥搴т綅</span><span class="v" style="font-size:13px">${esc(c.anchor || '鈥?)}</span></div>
      <div class="kv"><span class="k">棰勭害淇″彿</span><span class="v" style="font-size:13px">${esc(c.auxSignal || '鎵撲竴涓搷鎸?)}</span></div>
      ${c.auxSignal2 ? `<div class="kv"><span class="k">鍗虫椂淇″彿</span><span class="v" style="font-size:13px">${esc(c.auxSignal2)}</span></div>` : ''}
      <div class="kv"><span class="k">鍗曡妭鏃堕暱</span><span class="v">${c.minutes} 鍒嗛挓</span></div>
      <div class="kv"><span class="k">鑺傜偣</span><span class="v">#${C.nextN(c)}</span></div>
      <div class="btnrow">
        <button class="btn" data-act="ch-edit" data-id="${id}">缂栬緫</button>
        <button class="btn danger" data-act="ch-reset" data-id="${id}">娓呯┖閲嶅紑</button>
      </div>
      <div class="btnrow"><button class="btn ghost wide" data-act="ch-delete" data-id="${id}">鍒犻櫎杩欐潯閾?/button></div>`,
  });
}

function openChainEdit(id) {
  const c = C.chainById(st, id);
  if (!c) return;
  openSheet({
    title: '缂栬緫閾?,
    body: `
      <div class="field">
        <label for="ce-name">鍚嶅瓧</label>
        <input id="ce-name" type="text" value="${esc(c.name)}" data-autofocus>
      </div>
      <div class="field">
        <label for="ce-anchor">绁炲湥搴т綅锛堣捣閾炬爣蹇楋級</label>
        <input id="ce-anchor" type="text" value="${esc(c.anchor)}" placeholder="渚嬶細娣卞懠鍚镐笁娆★紝鎴翠笂钃濆附瀛?>
      </div>
      <div class="field">
        <label for="ce-aux">棰勭害淇″彿</label>
        <input id="ce-aux" type="text" value="${esc(c.auxSignal || '')}" placeholder="渚嬶細鎵撲竴涓搷鎸?>
      </div>
      <div class="field">
        <label for="ce-aux2">鍗虫椂鍚姩淇″彿锛堝彲閫夛級</label>
        <input id="ce-aux2" type="text" value="${esc(c.auxSignal2 || '')}" placeholder="渚嬶細杩炴墦涓夋鍝嶆寚">
      </div>
      <div class="field">
        <label for="ce-min">鍗曡妭鏃堕暱锛堝垎閽燂級</label>
        <input id="ce-min" type="number" min="5" max="240" value="${c.minutes}">
      </div>
      <div class="field">
        <span class="lbl">灞傜骇</span>
        <div class="radio-row">
          <label><input type="radio" name="ce-tier" value="elite" ${c.tier === 'elite' ? 'checked' : ''}><span>绮鹃攼</span></label>
          <label><input type="radio" name="ce-tier" value="normal" ${c.tier !== 'elite' ? 'checked' : ''}><span>鏅€?/span></label>
        </div>
        <p class="tip">绮鹃攼閾惧彧鍦ㄧ姸鎬佹渶濂芥椂鍔ㄧ敤锛涘穿浜嗙敤鏅€氶摼鎺ヤ綅銆?/p>
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="ce-save" data-id="${id}">淇濆瓨</button></div>`,
    focus: '#ce-name',
  });
}

/* ---------------- 娴佺▼锛氭柊寤洪摼 ---------------- */

function openNewChain() {
  openSheet({
    title: '鏂板缓浣滄垬閾?,
    body: `
      <div class="field">
        <label for="nc-name">鍚嶅瓧</label>
        <input id="nc-name" type="text" data-autofocus placeholder="渚嬶細绐佸嚮 / 渚︽煡 / 宸ョ▼">
      </div>
      <div class="field">
        <label for="nc-anchor">绁炲湥搴т綅锛堣捣閾炬爣蹇楋級</label>
        <input id="nc-anchor" type="text" placeholder="渚嬶細娣卞懠鍚镐笁娆★紝鎴翠笂闄嶅櫔鑰虫満">
        <p class="tip">杩欐槸銆屽紑濮嬨€嶇殑鏍囧織锛岃秺鍏蜂綋瓒婂ソ銆傚畠鏄摼鐨勫紑鍏筹紝涓嶆槸 App銆?/p>
      </div>
      <div class="field">
        <label for="nc-aux">棰勭害淇″彿锛堟€庝箞棰勭害锛?/label>
        <input id="nc-aux" type="text" placeholder="渚嬶細鎵撲竴涓搷鎸?>
        <p class="tip">鍜屽骇浣嶅垎寮€锛氭墦鍝嶆寚鍙槸棰勭害锛屽潗涓嬫墠鏄紑濮嬨€傜暀绌哄氨鐢ㄩ粯璁ゃ€屾墦涓€涓搷鎸囥€嶃€?/p>
      </div>
      <div class="field">
        <label for="nc-aux2">鍗虫椂鍚姩淇″彿锛堝彲閫夛紝浜屾淇濋櫓锛?/label>
        <input id="nc-aux2" type="text" placeholder="渚嬶細杩炴墦涓夋鍝嶆寚">
        <p class="tip">璁句簡瀹冿紝棰勭害鍓?30 绉掓椂浼氭彁閱掍綘鍏堟墦杩欎釜淇″彿锛屽啀绔嬪埢鍧愪笅銆?/p>
      </div>
      <div class="field">
        <label for="nc-min">鍗曡妭鏃堕暱锛堝垎閽燂級</label>
        <input id="nc-min" type="number" min="5" max="240" value="60">
      </div>
      <div class="field">
        <span class="lbl">灞傜骇</span>
        <div class="radio-row">
          <label><input type="radio" name="nc-tier" value="elite" checked><span>绮鹃攼</span></label>
          <label><input type="radio" name="nc-tier" value="normal"><span>鏅€?/span></label>
        </div>
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="nc-save">寤洪摼</button></div>`,
    focus: '#nc-name',
  });
}

/* ---------------- 娴佺▼锛氬鍑?/ 瀵煎叆 ---------------- */

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
    title: '瀵煎嚭 Markdown',
    body: `
      <div class="field">
        <textarea id="md-out" readonly style="min-height:260px;font-family:var(--mono);font-size:12px">${esc(md)}</textarea>
      </div>
      <div class="btnrow">
        <button class="btn" data-act="copy-md">澶嶅埗</button>
        <button class="btn primary" data-act="dl-md">涓嬭浇 .md</button>
      </div>
      <p class="tip">璐磋繘寰俊灏忓彿銆佸蹇樺綍銆佺焊璐ㄦ墦鍗伴兘琛屻€傜寮€ App 涔熶笉涓㈢郴缁熴€?/p>`,
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('宸插鍒?);
  } catch (e) {
    const ta = $('#md-out');
    if (ta) {
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
        toast('宸插鍒?);
      } catch (err) {
        toast('澶嶅埗澶辫触锛岃鎵嬪姩閫変腑');
      }
    }
  }
}

function openImport() {
  openSheet({
    title: '瀵煎叆澶囦唤',
    body: `
      <p class="tip" style="margin-top:0">瀵煎叆浼氳鐩栧綋鍓嶈处鏈€傚厛瀵煎嚭涓€浠界暀搴曟洿绋炽€?/p>
      <div class="field">
        <label for="imp-file">閫夋嫨 .json 鏂囦欢</label>
        <input id="imp-file" type="file" accept="application/json,.json">
      </div>
      <div class="btnrow"><button class="btn wide" data-act="close">鍙栨秷</button></div>`,
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
    toast('涓嶆槸鍚堟硶鐨?JSON');
    return;
  }
  if (!obj || obj.app !== C.APP_ID) {
    toast('涓嶆槸鏈簲鐢ㄧ殑澶囦唤');
    return;
  }
  const fresh = C.Ledger.load(JSON.stringify(obj), { save: led._save });
  led.state = fresh.state;
  st = led.state;
  led.save();
  closeSheet();
  render();
  toast('宸插鍏?);
}

/* ---------------- 娴佺▼锛氳缃?/ 璇存槑 ---------------- */

function openSettings() {
  openSheet({
    title: '瑙勫垯鍙傛暟',
    body: `
      <div class="field">
        <label for="se-day">浣滄垬鏃ヤ粠鍑犵偣寮€濮嬶紙鍑屾櫒绠楀墠涓€澶╋級</label>
        <input id="se-day" type="number" min="0" max="12" value="${st.settings.dayStart}">
      </div>
      <div class="field">
        <label for="se-aux">棰勭害绐楀彛锛堝垎閽燂級</label>
        <input id="se-aux" type="number" min="1" max="120" value="${st.settings.auxMinutes}">
      </div>
      <label class="check-row">
        <input type="checkbox" id="se-ritual" ${st.settings.ritual ? 'checked' : ''}>
        <span class="txt">璧烽摼鍓嶅脊涓€娆￠敋鐐圭‘璁?span class="sub"> 路 鍏虫帀灏辨槸闆剁偣鍑诲紑濮?/span></span>
      </label>
      <label class="check-row">
        <input type="checkbox" id="se-sound" ${st.settings.sound ? 'checked' : ''}>
        <span class="txt">鍒扮偣鎻愮ず闊?span class="sub"> 路 缁撻摼銆侀绾﹀埌鐐?/span></span>
      </label>
      <div class="btnrow" style="margin-top:6px">
        <button class="btn ghost wide" data-act="sound-test">璇曞惉鎻愮ず闊?/button>
      </div>
      <div class="btnrow"><button class="btn primary wide" data-act="settings-save">淇濆瓨</button></div>`,
  });
}

function openConflict() {
  openSheet({
    title: '浜戠鍜屾湰鏈洪兘鏀硅繃',
    body: `
      <p class="tip" style="margin-top:0">涓よ竟閮芥湁鏂板唴瀹癸紝鑷姩鍚屾鍏堝仠浣忎簡銆傞€変竴杈硅鐩栵紝鎴栬€呭悎骞躲€?/p>
      <div class="note" style="font-size:13px">
        鍚堝苟锛濆垽渚嬨€佸枩鎶ュ彇骞堕泦锛涘悓涓€鏉￠摼淇濈暀鑺傜偣鏇村鐨勯偅浠斤紱鍥界瓥鏍戜互鏈満涓哄噯銆?      </div>
      <div class="btnrow" style="margin-top:12px">
        <button class="btn primary wide" data-act="sync-push-force">鐢ㄦ湰鏈鸿鐩栦簯绔?/button>
      </div>
      <div class="btnrow">
        <button class="btn wide" data-act="sync-pull-force">鐢ㄤ簯绔鐩栨湰鏈?/button>
      </div>
      <div class="btnrow">
        <button class="btn wide" data-act="sync-merge">鍚堝苟涓よ竟</button>
      </div>
      <div class="btnrow"><button class="btn ghost wide" data-act="close">鍏堜笉鍔?/button></div>`,
  });
}

function openSync() {
  const c = syncCfg;
  const link = c.repo ? `https://github.com/${c.repo}/blob/${c.branch}/${c.path}` : '';
  openSheet({
    title: '浜戝悓姝?,
    body: `
      <p class="tip" style="margin-top:0">璐︽湰鍐欏埌浣犵殑<b>绉佹湁浠撳簱</b>锛屾墜鏈哄拰鐢佃剳鍚勯厤涓€娆″嵆鍙€傛瘡娆′笂浼犻兘鏄竴娆?commit锛岃鐩栦簡涔熻兘鍥炴粴銆?/p>
      <div class="field">
        <label for="sy-repo">浠撳簱锛坥wner/repo锛?/label>
        <input id="sy-repo" type="text" value="${esc(c.repo)}" placeholder="yourname/ctdp-ledger">
      </div>
      <div class="field">
        <label for="sy-path">鏂囦欢璺緞</label>
        <input id="sy-path" type="text" value="${esc(c.path)}">
      </div>
      <div class="field">
        <label for="sy-branch">鍒嗘敮</label>
        <input id="sy-branch" type="text" value="${esc(c.branch)}">
      </div>
      <div class="field">
        <label for="sy-token">璁块棶浠ょ墝锛圥AT锛?/label>
        <input id="sy-token" type="password" value="${esc(c.token)}" placeholder="github_pat_鈥?>
        <p class="tip">鍙～鍦ㄨ繖鍙拌澶囦笂锛屼笉浼氳繘璐︽湰銆佷笉浼氳鍚屾銆傛潈闄愬彧瑕佽繖涓€涓粨搴撶殑 <b>Contents: Read and write</b>銆?/p>
      </div>
      ${link ? `<p class="tip">浜戠鏂囦欢锛?a href="${esc(link)}" target="_blank" rel="noreferrer">${esc(link)}</a></p>` : ''}
      <div class="btnrow">
        <button class="btn" data-act="sync-test">娴嬭瘯杩炴帴</button>
        <button class="btn primary" data-act="sync-save">淇濆瓨</button>
      </div>
      ${
        G.configured(c)
          ? `<div class="btnrow"><button class="btn ghost wide" data-act="sync-forget">娓呴櫎閰嶇疆锛堣处鏈笉鍔級</button></div>`
          : ''
      }`,
  });
}

function openIntro() {
  openSheet({
    title: '杩欐槸浠€涔?,
    body: `
      <div class="note" style="font-size:14px">
        涓€涓?b>璐︽湰</b>锛屼笉鏄暀缁冦€?br>
        瀹冩浛浣犺浣忎袱浠朵汉璁颁笉浣忕殑浜嬶細鍒よ繃浠€涔堜緥锛屽穿杩囧嚑娆°€?      </div>
      <div class="kv"><span class="k">涓婚摼</span><span class="v" style="font-family:var(--sans);font-size:13px">涓€涓敋鐐?+ 涓€灏忔椂 = 涓€涓?# 鑺傜偣</span></div>
      <div class="kv"><span class="k">鍒ゅ畾</span><span class="v" style="font-family:var(--sans);font-size:13px">鐮存垝鍙湁涓ゆ潯璺細娓呴浂锛屾垨姘镐箙鏀捐</span></div>
      <div class="kv"><span class="k">鍥界瓥鏍?/span><span class="v" style="font-family:var(--sans);font-size:13px">姣忓ぉ鐐逛寒涓€涓紱宕╀簡閫€鍥炲簱锛屽唴鍖栧ぉ鏁颁笉涓?/span></div>
      <p class="tip">娌℃湁鎺ㄩ€佽桨鐐革紝娌℃湁杩炵画鎵撳崱缇炶颈銆備竴澶╃敤涓嶅埌涓€鍒嗛挓銆?/p>
      <div class="btnrow"><button class="btn primary wide" data-act="intro-ok">寮€濮?/button></div>`,
  });
}

/* ---------------- 浜嬩欢 ---------------- */

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

    /* 璧烽摼 */
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
      toast(`绗?#${C.nextN(c)} 鑺傝捣閾綻);
      break;
    }
    case 'arm': {
      const c = C.chainById(st, id);
      led.arm(id);
      afterChange();
      scheduleChainSound(id);
      toast(`宸查绾?路 ${(c && c.auxSignal) || '鎵撲竴涓搷鎸?}`);
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
      toast(`绗?#${n} 鑺傝捣閾綻);
      break;
    }
    case 'disarm':
      cancelChainSounds(id);
      led.disarm(id);
      afterChange();
      toast('棰勭害浣滃簾');
      break;
    case 'complete':
      openComplete(id);
      break;
    case 'force-done': {
      cancelChainSounds(id);
      const r = led.complete(id, { force: true });
      closeSheet();
      afterChange();
      if (r.ok) toast(`绗?#${r.n} 鑺傚叆妗ｏ紙鏈弧鏃堕暱锛塦);
      break;
    }
    case 'interrupt': {
      cancelChainSounds(id);
      const info = led.pause(id);
      if (info) {
        openJudge(id);
        toast(`宸蹭腑鏂?路 鐢ㄦ椂 ${C.fmtClock(info.took)}`);
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
      if (!behavior) return toast('鍏堝啓涓€鍙ュ彂鐢熶簡浠€涔?);
      confirmAllow(id, behavior);
      break;
    }
    case 'judge-deny': {
      const behavior = readJudgeInput();
      if (!behavior) return toast('鍏堝啓涓€鍙ュ彂鐢熶簡浠€涔?);
      confirmDeny(id, behavior);
      break;
    }
    case 'judge-allow-go': {
      cancelChainSounds(id);
      led.judge({ chainId: id, behavior: v, decision: 'allow' });
      closeSheet();
      afterChange();
      toast('宸茬珛鍒や緥 路 姘镐箙鏀捐');
      break;
    }
    case 'judge-deny-go': {
      cancelChainSounds(id);
      const r = led.judge({ chainId: id, behavior: v, decision: 'deny' });
      closeSheet();
      afterChange();
      if (r.reset) toast(`閾惧凡娓呴浂锛?{r.cleared} 鑺傦級`);
      break;
    }

    /* 閾捐彍鍗?*/
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
        name: name || '鏈懡鍚嶉摼',
        anchor,
        auxSignal,
        auxSignal2,
        minutes: Math.max(5, Math.min(240, min)),
        tier,
      });
      closeSheet();
      afterChange();
      toast('宸蹭繚瀛?);
      break;
    }
    case 'ch-reset':
      openSheet({
        title: '娓呯┖閲嶅紑',
        body: `<p class="tip" style="margin-top:0">鎶婅繖鏉￠摼閲嶇疆鍒?#1銆備細璁颁竴娆″穿濉屻€?/p>
          <div class="btnrow"><button class="btn danger wide" data-act="ch-reset-go" data-id="${id}">纭娓呴浂</button></div>
          <div class="btnrow"><button class="btn ghost wide" data-act="close">鎾ゅ洖</button></div>`,
      });
      break;
    case 'ch-reset-go':
      cancelChainSounds(id);
      led.reset(id, '鎵嬪姩娓呯┖');
      closeSheet();
      afterChange();
      toast('宸叉竻闆?);
      break;
    case 'ch-delete':
      openSheet({
        title: '鍒犻櫎閾?,
        body: `<p class="tip" style="margin-top:0">銆?{esc((C.chainById(st, id) || {}).name || '')}銆嶇殑鑺傜偣浼氫竴骞舵秷澶便€備笉鍙挙閿€銆?/p>
          <div class="btnrow"><button class="btn danger wide" data-act="ch-delete-go" data-id="${id}">纭鍒犻櫎</button></div>
          <div class="btnrow"><button class="btn ghost wide" data-act="close">鎾ゅ洖</button></div>`,
      });
      break;
    case 'ch-delete-go': {
      cancelChainSounds(id);
      st.chains = st.chains.filter((c) => c.id !== id);
      closeSheet();
      afterChange();
      toast('宸插垹闄?);
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
      if (!name) return toast('缁欏畠璧蜂釜鍚嶅瓧');
      led.addChain({ name, anchor, auxSignal, auxSignal2, minutes: Math.max(5, Math.min(240, min)), tier });
      closeSheet();
      afterChange();
      toast('宸插缓閾?);
      break;
    }

    /* 鍥界瓥 */
    case 'new-policy':
      openNewPolicy();
      break;
    case 'np-save': {
      const title = $('#np-title').value.trim();
      if (!title) return toast('缁欏畠璧蜂釜鍚嶅瓧');
      const type = ($('input[name="np-type"]:checked') || {}).value || 'passive';
      const cond = $('#np-cond').value.trim();
      const parentId = $('#np-parent').value || null;
      const isGroup = $('#np-group').checked;
      const quota = Number($('#np-quota').value) || 1;
      const r = led.addPolicy({ title, type, cond, parentId, isGroup, quota });
      if (!r.ok) {
        toast('浠婂ぉ宸茬粡鐐逛寒杩囦竴涓簡锛屾槑澶╁啀鏉?);
        return;
      }
      closeSheet();
      afterChange();
      toast('宸茬偣浜?);
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
      toast(hit.length > 1 ? `宸茬唲鐏紝杩炲甫 ${hit.length - 1} 涓瓙鑺傜偣` : '宸茬唲鐏?);
      break;
    }
    case 'prestore':
      led.restore(id);
      closeSheet();
      afterChange();
      toast('宸查噸鏂扮偣浜?);
      break;
    case 'p-delete': {
      const p = C.policyById(st, id);
      const kids = p ? C.childrenOf(st, p.id).length : 0;
      const descN = C.descendantIds(st, id).length;
      openSheet({
        title: '鍒犻櫎鍥界瓥',
        body: `<p class="tip" style="margin-top:0">銆?{esc(p ? p.title : '')}銆嶈繛鍚屽畠鐨勬暣妫靛瓙鏍戜竴璧峰垹鎺夈€?/p>
          <div class="kv"><span class="k">鐩存帴瀛愯妭鐐?/span><span class="v">${kids} 涓?/span></div>
          <div class="kv"><span class="k">鍚悗浠?/span><span class="v">${descN} 涓?/span></div>
          <p class="tip">鍘嗗彶杩樼暀鍦ㄤ簨浠舵棩蹇楅噷锛屼絾鏍戜笂鍐嶄篃鐪嬩笉鍒颁簡銆傛兂鐣欑潃灏辨敼鐢ㄣ€岀唲鐏€嶃€?/p>
          <div class="btnrow"><button class="btn danger wide" data-act="p-delete-go" data-id="${id}">纭鍒犻櫎${descN ? ` ${descN + 1} 涓妭鐐筦 : ''}</button></div>
          <div class="btnrow"><button class="btn ghost wide" data-act="close">鎾ゅ洖</button></div>`,
      });
      break;
    }
    case 'p-delete-go': {
      const ids = [id, ...C.descendantIds(st, id)];
      st.policies = st.policies.filter((p) => !ids.includes(p.id));
      closeSheet();
      afterChange();
      toast('宸插垹闄?);
      break;
    }

    /* 缁撶畻 / 鍐荤粨 */
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
      toast(`宸插喕缁?${days} 澶ー);
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
      toast(ids.length ? `宸茶В鍐?路 ${ids.length} 椤圭唲鐏璥 : '宸茶В鍐?路 鍏ㄩ儴琛ラ綈');
      break;
    }

    /* 璧㈤夯浜?*/
    case 'win':
      openSheet({
        title: '璁颁竴绗?,
        body: `
          <div class="field">
            <label for="wn-title">浠婂ぉ鏈€澶х殑閭ｄ欢浜?/label>
            <input id="wn-title" type="text" data-autofocus placeholder="渚嬶細鎼炲畾楂樻暟绗笁绔?>
          </div>
          <div class="field">
            <span class="lbl">閲忕骇</span>
            <div class="radio-row">
              <label><input type="radio" name="wn-grade" value="small" checked><span>灏忚耽</span></label>
              <label><input type="radio" name="wn-grade" value="mid"><span>涓耽</span></label>
              <label><input type="radio" name="wn-grade" value="big"><span>澶ц耽</span></label>
            </div>
          </div>
          <div class="btnrow"><button class="btn primary wide" data-act="win-save">鍏ユ。</button></div>`,
        focus: '#wn-title',
      });
      break;
    case 'win-save': {
      const title = $('#wn-title').value.trim();
      if (!title) return toast('鍐欎竴鍙?);
      const grade = ($('input[name="wn-grade"]:checked') || {}).value || 'small';
      led.addWin({ title, grade });
      closeSheet();
      afterChange();
      toast('宸插叆妗?);
      break;
    }

    /* 瀵煎嚭 / 瀵煎叆 / 璁剧疆 */
    case 'export-md':
      openExportMd();
      break;
    case 'copy-md': {
      const ta = $('#md-out');
      if (ta) copyText(ta.value);
      break;
    }
    case 'dl-md':
      download(`浣滄垬妗ｆ-${C.dayKey()}.md`, led.exportMarkdown(), 'text/markdown');
      markExport('md');
      toast('宸蹭笅杞?);
      break;
    case 'export-json':
      download(`浣滄垬妗ｆ-${C.dayKey()}.json`, led.toJSON(), 'application/json');
      markExport('json');
      toast('宸插鍑?);
      break;
    case 'import':
      openImport();
      break;
    case 'verify': {
      const r = led.verify();
      openSheet({
        title: '鍝堝笇閾炬牎楠?,
        body: r.ok
          ? `<p class="tip" style="margin-top:0">瀹屾暣銆?{r.count} 鏉′簨浠堕灏剧浉鎺ワ紝娌¤鏀硅繃銆?/p>
             <div class="kv"><span class="k">浜嬩欢</span><span class="v">${r.count}</span></div>
             <div class="kv"><span class="k">缁撹</span><span class="v">瀹屾暣</span></div>`
          : `<div class="warn">绗?${r.seq} 鏉′簨浠惰捣瀵逛笉涓娿€傝处鏈彲鑳借鎵嬪伐鏀硅繃锛屾垨鏃х増鏈暟鎹€?/div>`,
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
      toast('宸蹭繚瀛?);
      break;
    }
    case 'sound-test':
      S.unlock();
      S.chime('done');
      toast(S.ready() ? '杩欐槸缁撻摼鐨勬彁绀洪煶' : '娴忚鍣ㄨ繕娌¤В閿侀煶棰戯紝鍏堢偣涓€涓嬮〉闈?);
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
          /* 娓呬笉鎺変篃鐓ф牱閲嶈浇 */
        }
        location.reload();
      })();
      break;
    }
    case 'sync-open':
      openSync();
      break;
    case 'sync-conflict':
      openConflict();
      break;
    case 'sync-merge': {
      closeSheet();
      (async () => {
        try {
          const remote = await G.pull(syncCfg);
          if (!remote) return toast('浜戠娌℃湁鏂囦欢');
          mergeRemote(remote.text);
          const ok = await doPush({ force: true });
          if (ok) {
            syncConflict = false;
            render();
            toast('宸插悎骞跺苟涓婁紶');
          }
        } catch (e) {
          toast(e.message || '鍚堝苟澶辫触');
        }
      })();
      break;
    }
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
      toast('宸蹭繚瀛樺埌鏈満');
      break;
    }
    case 'sync-test': {
      const cfg = {
        repo: $('#sy-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''),
        path: $('#sy-path').value.trim() || 'ledger/state.json',
        branch: $('#sy-branch').value.trim() || 'main',
        token: $('#sy-token').value.trim(),
      };
      if (!cfg.repo || !cfg.token) return toast('浠撳簱鍜屼护鐗岄兘瑕佸～');
      toast('娴嬭瘯涓€?);
      G.test(cfg)
        .then((r) => {
          G.saveCfg(cfg);
          syncCfg = G.loadCfg();
          toast(`杩炰笂浜嗭細${r.login} 鈫?${r.repo}${r.private ? '锛堢鏈夛級' : '锛堝叕寮€锛佽处鏈細琚汉鐪嬪埌锛?}`);
          render();
        })
        .catch((e) => toast(e.message || '杩炴帴澶辫触'));
      break;
    }
    case 'sync-pull':
      doPull().then((ok) => {
        if (!ok && isDirty() && G.configured(syncCfg)) {
          openSheet({
            title: '鏈湴鏈夋湭涓婁紶鐨勬敼鍔?,
            body: `<p class="tip" style="margin-top:0">鎷夊彇浼氱敤浜戠瑕嗙洊鏈満銆傚厛鍐冲畾淇濆摢杈广€?/p>
              <div class="btnrow"><button class="btn primary wide" data-act="sync-pull-force">鐢ㄤ簯绔鐩栨湰鏈?/button></div>
              <div class="btnrow"><button class="btn wide" data-act="sync-push-force">鏀圭敤鏈満瑕嗙洊浜戠</button></div>
              <div class="btnrow"><button class="btn ghost wide" data-act="close">鍏堜笉鍔?/button></div>`,
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
            title: '浜戠宸茬粡鍙樹簡',
            body: `<p class="tip" style="margin-top:0">杩欏彴璁惧鍜屽埆澶勯兘鏀硅繃璐︽湰銆侴itHub 涓婃瘡娆′笂浼犻兘鏄竴涓?commit锛岃鐩栦簡涔熻兘鍥炴粴銆?/p>
              <div class="btnrow"><button class="btn primary wide" data-act="sync-force-overwrite">鐢ㄦ湰鏈鸿鐩栦簯绔?/button></div>
              <div class="btnrow"><button class="btn wide" data-act="sync-pull-force">鐢ㄤ簯绔鐩栨湰鏈?/button></div>
              <div class="btnrow"><button class="btn ghost wide" data-act="close">鍏堜笉鍔?/button></div>`,
          });
        }
      });
      break;
    case 'sync-force-overwrite': {
      closeSheet();
      (async () => {
        try {
          const remote = await G.pull(syncCfg);
          const res = await G.push(syncCfg, JSON.stringify(st), remote ? remote.sha : null, '璐︽湰锛堝己鍒惰鐩栵級');
          if (res.conflict) throw new Error('杩樻槸鍐茬獊锛岀◢鍚庡啀璇?);
          markSynced(res.sha);
          syncConflict = false;
          render();
          toast('宸茶鐩栦簯绔?);
        } catch (e) {
          toast(e.message || '瑕嗙洊澶辫触');
        }
      })();
      break;
    }
    case 'sync-forget':
      G.saveCfg({ ...G.DEF });
      syncCfg = G.loadCfg();
      closeSheet();
      afterChange();
      toast('宸叉柇寮€锛堣处鏈笉鍔級');
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

/* 璋冭瘯鍑哄彛锛氬嚭闂鏃跺湪鎺у埗鍙扮湅涓€鐪肩増鏈?/ 闊抽鐘舵€?/ 鐘舵€佸璞?*/
window.__app = {
  version: APP_VERSION,
  state: () => led.state,
  sound: S,
  sync: G,
  syncNow,
  syncLine,
  isDirty,
  digestOf,
  remoteDigest,
  debugJson: (s) => JSON.stringify({ ...s, sync: null }),
};

/* ---------------- 鍚姩 ---------------- */

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
