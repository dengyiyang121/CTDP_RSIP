/* =============================================================================
 * sync.js — 用 GitHub 私有仓库当同步盘
 * 只做两件事：把整份账本 PUT 成一次提交，或从远端 GET 回来。
 * 每次 PUT 都是一个 commit，所以“上一次覆盖”永远能回滚。
 * ========================================================================== */

const API = 'https://api.github.com';
const CFG_KEY = 'ctdp.sync.cfg';

export const DEF = { repo: '', path: 'ledger/state.json', branch: 'main', token: '' };

export function loadCfg() {
  try {
    return { ...DEF, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') };
  } catch (e) {
    return { ...DEF };
  }
}

export function saveCfg(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify({ ...DEF, ...cfg }));
}

export function configured(cfg) {
  return !!(cfg && cfg.repo && cfg.token);
}

/* ---------- base64（UTF-8 安全） ---------- */

export function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function unb64(s) {
  const bin = atob(String(s).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------- 请求 ---------- */

async function api(cfg, method, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('连不上 GitHub（网络或代理）');
  }
  return res;
}

async function reason(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j.message || '';
  } catch (e) {
    /* 忽略 */
  }
  if (res.status === 401) return '令牌无效或过期（401）';
  if (res.status === 403) return `没有权限或触到限流（403）${detail ? ' · ' + detail : ''}`;
  if (res.status === 404) return '仓库或文件不存在（404）';
  return `${res.status}${detail ? ' · ' + detail : ''}`;
}

/* ---------- 操作 ---------- */

/** 验证令牌 + 仓库可读，返回 { login, repo } */
export async function test(cfg) {
  const r1 = await api(cfg, 'GET', '/user');
  if (!r1.ok) throw new Error(await reason(r1));
  const me = await r1.json();
  const r2 = await api(cfg, 'GET', `/repos/${cfg.repo}`);
  if (!r2.ok) throw new Error(await reason(r2));
  const repo = await r2.json();
  if (!repo.permissions || !repo.permissions.push) throw new Error('这个令牌对仓库没有写权限');
  return { login: me.login, repo: repo.full_name, private: repo.private };
}

/** 拉取；文件不存在返回 null */
export async function pull(cfg) {
  const path = `/repos/${cfg.repo}/contents/${encodeURI(cfg.path)}?ref=${encodeURIComponent(cfg.branch)}`;
  const res = await api(cfg, 'GET', path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await reason(res));
  const j = await res.json();
  return { sha: j.sha, text: unb64(j.content) };
}

/**
 * 推送。sha 为空则新建文件。
 * 与远端不一致时返回 { conflict: true }，不覆盖。
 */
export async function push(cfg, text, sha, message) {
  const body = {
    message: message || `ledger ${new Date().toISOString()}`,
    content: b64(text),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;
  const res = await api(cfg, 'PUT', `/repos/${cfg.repo}/contents/${encodeURI(cfg.path)}`, body);
  if (res.status === 409 || res.status === 422) return { conflict: true, status: res.status };
  if (!res.ok) throw new Error(await reason(res));
  const j = await res.json();
  return { sha: j.content.sha, commit: j.commit.sha };
}
