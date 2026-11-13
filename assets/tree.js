/* =============================================================================
 * tree.js — 国策树的布局计算（纯函数，可在 node 里测）
 *
 * 两种朝向：
 *   LR（宽屏）：根在左，子节点向右 → 深度轴 = x
 *   TB（窄屏）：根在上，子节点向下 → 深度轴 = y
 * 广度轴按子树尺寸居中排列（简化版 tidy tree），保证父节点对着子节点群的中线。
 * ========================================================================== */

const DEF = { nodeW: 136, nodeH: 62, gapX: 44, gapY: 14, rootGap: 26, pad: 0, direction: 'LR' };

/** p 的祖先链里是否会绕回 p 自己（脏数据保护） */
function isCyclic(p, map) {
  const seen = new Set([p.id]);
  let cur = map.get(p.parentId);
  let guard = 0;
  while (cur && guard++ < 500) {
    if (seen.has(cur.id)) return true;
    seen.add(cur.id);
    cur = cur.parentId ? map.get(cur.parentId) : null;
  }
  return false;
}

export function layoutTree(policies, opts = {}) {
  const { nodeW, nodeH, gapX, gapY, rootGap, pad } = { ...DEF, ...opts };
  const dir = opts.direction === 'TB' ? 'TB' : 'LR';
  const vertical = dir === 'TB';

  const map = new Map(policies.map((p) => [p.id, p]));
  const kids = new Map();
  const roots = [];

  for (const p of policies) {
    const parent = p.parentId ? map.get(p.parentId) : null;
    if (parent && parent !== p && !isCyclic(p, map)) {
      if (!kids.has(parent.id)) kids.set(parent.id, []);
      kids.get(parent.id).push(p);
    } else {
      roots.push(p);
    }
  }
  for (const arr of kids.values()) arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  roots.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  /* 深度轴：步长 = 节点尺寸 + 间距；广度轴：节点沿另一方向排队 */
  const dStep = vertical ? nodeH + gapY : nodeW + gapX;
  const bSize = vertical ? nodeW : nodeH;
  const bGap = vertical ? gapX : gapY;

  const ext = new Map(); // 子树在广度轴上占的长度
  const totalB = (cs) => cs.reduce((a, c, i) => a + ext.get(c.id) + (i ? bGap : 0), 0);

  const measure = (p) => {
    const cs = kids.get(p.id) || [];
    cs.forEach(measure);
    const v = cs.length ? Math.max(bSize, totalB(cs)) : bSize;
    ext.set(p.id, v);
    return v;
  };
  roots.forEach(measure);

  const pos = new Map();
  const place = (p, depth, start) => {
    const my = ext.get(p.id);
    const b = start + (my - bSize) / 2;
    const x = vertical ? b + pad : depth * dStep + pad;
    const y = vertical ? depth * dStep + pad : b + pad;
    pos.set(p.id, { x, y });
    const cs = kids.get(p.id) || [];
    if (!cs.length) return;
    let cursor = start + (my - totalB(cs)) / 2;
    for (const c of cs) {
      place(c, depth + 1, cursor);
      cursor += ext.get(c.id) + bGap;
    }
  };

  let start = 0;
  for (const r of roots) {
    place(r, 0, start);
    start += ext.get(r.id) + rootGap;
  }

  const nodes = [];
  for (const p of policies) {
    const at = pos.get(p.id);
    if (at) nodes.push({ p, x: at.x, y: at.y, w: nodeW, h: nodeH });
  }

  const edges = [];
  for (const [pid, cs] of kids) {
    const a = pos.get(pid);
    if (!a) continue;
    for (const c of cs) {
      const b = pos.get(c.id);
      if (!b) continue;
      edges.push({
        from: pid,
        to: c.id,
        dir,
        gap: vertical ? gapY : gapX,
        x1: vertical ? a.x + nodeW / 2 : a.x + nodeW,
        y1: vertical ? a.y + nodeH : a.y + nodeH / 2,
        x2: vertical ? b.x + nodeW / 2 : b.x,
        y2: vertical ? b.y : b.y + nodeH / 2,
        state: c.state,
      });
    }
  }

  const width = nodes.reduce((m, n) => Math.max(m, n.x + nodeW + pad), 0);
  const height = nodes.reduce((m, n) => Math.max(m, n.y + nodeH + pad), 0);
  return { dir, nodeW, nodeH, width, height, nodes, edges, roots: roots.map((r) => r.id) };
}

/** 正交折线：父缘 → 中段 → 子缘（末端留 7px 给箭头） */
export function edgePath(e, gap = e.gap ?? 44) {
  if (e.dir === 'TB') {
    const my = e.y1 + gap / 2;
    return `M ${e.x1} ${e.y1} V ${my} H ${e.x2} V ${e.y2 - 7}`;
  }
  const mx = e.x1 + gap / 2;
  return `M ${e.x1} ${e.y1} H ${mx} V ${e.y2} H ${e.x2 - 7}`;
}
