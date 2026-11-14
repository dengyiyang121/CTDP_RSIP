/* =============================================================================
 * sync.js — 同步传输层（目前只有 GitHub Contents API）
 *
 * 只做三件事：验令牌、把整份账本读回来、把整份账本写成一次提交。
 * 冲突判断交给上层（ui.js + merge.js）：这里永远不猜、不覆盖。
 *
 * 关键点：
 *  - GET 必须 cache:'no-store' 并加时间戳，否则浏览器会喂 60 秒前的旧 sha。
 *  - 网络错误 / 5xx / 429 自动重试；401/403/404 立即报错，别让人干等。
 *  - 新建文件时 sha 必须为空；文件已存在时 sha 必须是最新的，否则 409/422。
 * ========================================================================== */

const DEFAULT_API = 'https://api.github.com';
const CFG_KEY = 'ctdp.sync.cfg';
const DEVICE_KEY = 'ctdp.sync.device';

export const DEF = { repo: '', path: 'ledger/state.json', branch: 'main', token: '', apiBase: DEFAULT_API };

/* ---------- 配置 ---------- */

export function loadCfg() {
  try {
    const raw = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
    const cfg = { ...DEF, ...raw };
    cfg.repo = normalizeRepo(cfg.repo);
    cfg.path = String(cfg.path || DEF.path).replace(/^\/+/, '');
    cfg.branch = String(cfg.branch || DEF.branch);
    cfg.apiBase = String(cfg.apiBase || DEFAULT_API).replace(/\/+$/, '');
    cfg.token = String(cfg.token || '').trim();
    return cfg;
  } catch (e) {
    return { ...DEF };
  }
}

export function saveCfg(cfg) {
  const next = {
    ...DEF,
    ...cfg,
    repo: normalizeRepo(cfg.repo),
    token: String(cfg.token || '').trim(),
    apiBase: String(cfg.apiBase || DEFAULT_API).replace(/\/+$/, ''),
  };
  localStorage.setItem(CFG_KEY, JSON.stringify(next));
  return next;
}

export function normalizeRepo(s) {
  return String(s || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

export function configured(cfg) {
  return !!(cfg && cfg.repo && cfg.token);
}

/** 稳定的设备 ID，只在本机；用来写提交信息、备份文件名 */
export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      const rnd = Math.random().toString(36).slice(2, 8);
      id = `dev_${Date.now().toString(36)}_${rnd}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch (e) {
    return 'dev_unknown';
  }
}

/* ---------- 同步码 ---------- */

export function encodeCode(cfg) {
  const payload = { repo: cfg.repo, path: cfg.path, branch: cfg.branch, token: cfg.token };
  if (cfg.apiBase && cfg.apiBase !== DEFAULT_API) payload.apiBase = cfg.apiBase;
  return b64url(JSON.stringify(payload));
}

export function decodeCode(code) {
  const cfg = JSON.parse(b64urlDecode(code));
  if (!cfg || !cfg.repo || !cfg.token) throw new Error('同步码不完整');
  return { ...DEF, ...cfg };
}

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4 ? '='.repeat(4 - (b.length % 4)) : '';
  const bin = atob(b + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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

/* ---------- 错误 ---------- */

export class SyncError extends Error {
  constructor(message, { status = 0, retryable = false, detail = '' } = {}) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt, res) {
  const ra = res && res.headers ? Number(res.headers.get('retry-after')) : 0;
  if (ra > 0) return Math.min(10000, ra * 1000);
  return Math.min(8000, 700 * Math.pow(2, attempt) + Math.floor(Math.random() * 300));
}

/* ---------- 请求 ---------- */

async function api(cfg, method, path, body, { retry = 3, timeout = 20000 } = {}) {
  const base = (cfg.apiBase || DEFAULT_API).replace(/\/+$/, '');
  // GitHub API 会给 GET 加 60 秒缓存；时间戳 + no-store 双保险
  const url = base + path + (method === 'GET' ? (path.includes('?') ? '&' : '?') + '_=' + Date.now() : '');
  let lastErr = null;

  for (let attempt = 0; attempt <= retry; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(url, {
        method,
        cache: 'no-store',
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retry) {
        await sleep(backoff(attempt));
        continue;
      }
      const why = e && e.name === 'AbortError' ? '请求超时' : '网络连不上';
      throw new SyncError(`${why} GitHub（检查代理 / 网络后会自动重试）`, { retryable: true });
    }
    clearTimeout(timer);

    if ((res.status === 429 || res.status === 408 || res.status >= 500) && attempt < retry) {
      await sleep(backoff(attempt, res));
      continue;
    }
    return res;
  }
  throw new SyncError(lastErr ? String(lastErr.message || lastErr) : '请求失败', { retryable: true });
}

async function reason(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j && j.message ? String(j.message) : '';
  } catch (e) {
    /* 忽略 */
  }
  const remaining = res.headers ? res.headers.get('x-ratelimit-remaining') : null;
  const reset = res.headers ? Number(res.headers.get('x-ratelimit-reset')) : 0;

  if (res.status === 401) return new SyncError('令牌无效或已过期（401）。去 GitHub 重新生成一个，再填进来。', { status: 401, detail });
  if (res.status === 403) {
    if (remaining === '0') {
      const when = reset ? new Date(reset * 1000).toLocaleTimeString('zh-CN') : '稍后';
      return new SyncError(`GitHub 接口限流了（每小时 5000 次，${when} 恢复）。本地照常可用，到点会自动重试。`, { status: 403, retryable: true, detail });
    }
    if (/rate limit/i.test(detail)) {
      return new SyncError('GitHub 接口限流了，稍后自动重试。', { status: 403, retryable: true, detail });
    }
    return new SyncError(`没有写权限（403）：令牌要对该仓库有 Contents: Read and write。${detail ? ' · ' + detail : ''}`, { status: 403, detail });
  }
  if (res.status === 404) return new SyncError('仓库或分支不存在（404）：检查 owner/repo、分支名，以及令牌是否只勾了这个仓库。', { status: 404, detail });
  if (res.status === 409) return new SyncError('云端刚被别的设备改过（409），会自动重拉再合并。', { status: 409, retryable: true, detail });
  if (res.status === 422) return new SyncError(`云端拒绝了这次写入（422）${detail ? ' · ' + detail : ''}`, { status: 422, detail });
  if (res.status === 413) return new SyncError('账本文件太大（413）。先去导出 JSON 备份，再清理一些旧事件。', { status: 413, detail });
  return new SyncError(`同步失败：${res.status}${detail ? ' · ' + detail : ''}`, { status: res.status, retryable: res.status >= 500, detail });
}

/* ---------- 操作 ---------- */

/** 验证令牌 + 仓库可读 + 有写权限，返回 { login, repo, private } */
export async function test(cfg) {
  const r1 = await api(cfg, 'GET', '/user', null, { retry: 1 });
  if (!r1.ok) throw await reason(r1);
  const me = await r1.json();

  const r2 = await api(cfg, 'GET', `/repos/${cfg.repo}`, null, { retry: 1 });
  if (!r2.ok) throw await reason(r2);
  const repo = await r2.json();

  if (!repo.permissions || !repo.permissions.push) {
    throw new SyncError('这个令牌对仓库没有写权限。Fine-grained token 里把 Contents 改成 Read and write。', { status: 403 });
  }

  // 分支写错是新手最常见的 422：明确告诉默认分支是什么
  if (repo.default_branch && cfg.branch !== repo.default_branch && repo.size > 0) {
    const rb = await api(cfg, 'GET', `/repos/${cfg.repo}/branches/${encodeURIComponent(cfg.branch)}`, null, { retry: 1 });
    if (rb.status === 404) {
      throw new SyncError(`分支 ${cfg.branch} 不存在；这个仓库的默认分支是 ${repo.default_branch}，把「分支」改成它。`, { status: 404 });
    }
  }

  return { login: me.login, repo: repo.full_name, private: !!repo.private, branch: cfg.branch };
}

/** 拉取；文件不存在返回 null */
export async function pull(cfg) {
  const path = `/repos/${cfg.repo}/contents/${encodeURI(cfg.path)}?ref=${encodeURIComponent(cfg.branch)}`;
  const res = await api(cfg, 'GET', path);
  if (res.status === 404) return null;
  if (!res.ok) throw await reason(res);
  const j = await res.json();
  if (!j || !j.sha) return null;
  if (j.encoding !== 'base64' || typeof j.content !== 'string') {
    throw new SyncError('云端文件格式不对（不是 Contents API 的 base64）。', { status: 0 });
  }
  return { sha: j.sha, text: unb64(j.content), size: j.size || 0 };
}

/**
 * 推送。sha 为空则新建文件；文件已存在时 sha 必须是最新的。
 * 与远端不一致时返回 { conflict: true }，不覆盖。
 */
export async function push(cfg, text, sha, message) {
  const body = {
    message: message || `ledger ${new Date().toISOString()}`,
    content: b64(text),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;

  const res = await api(cfg, 'PUT', `/repos/${cfg.repo}/contents/${encodeURI(cfg.path)}`, body, { retry: 2 });
  if (res.status === 409 || res.status === 422) {
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch (e) {
      /* ignore */
    }
    return { conflict: true, status: res.status, detail };
  }
  if (!res.ok) throw await reason(res);
  const j = await res.json();
  return { sha: j.content.sha, commit: j.commit.sha };
}
