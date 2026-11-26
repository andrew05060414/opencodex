// 讲解标注：橙框圈住 data-n 元素，说明放在右侧留白里，用细线连过去，互不重叠。
for (const b of document.querySelectorAll('.board')) {
  const br = b.getBoundingClientRect(); let lastBottom = 50;
  const items = [...b.querySelectorAll('[data-n]')].sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top);
  for (const t of items) {
    const r = t.getBoundingClientRect();
    let L = r.left - br.left, T = r.top - br.top, W = r.width, H = r.height;
    if (t.dataset.w) { let e = t; for (let i = 1; i < +t.dataset.w; i++) e = e.nextElementSibling; const r2 = e.getBoundingClientRect(); W = r2.right - r.left; H = Math.max(H, r2.bottom - r.top); }
    const ring = document.createElement('div'); ring.className = 'ring';
    Object.assign(ring.style, { left: L - 5 + 'px', top: T - 4 + 'px', width: W + 10 + 'px', height: H + 8 + 'px' }); b.append(ring);
    const c = document.createElement('div'); c.className = 'call'; c.innerHTML = '<b>' + t.dataset.n + '</b>' + t.dataset.t; b.append(c);
    const x = br.width - 262; let y = Math.max(T + H / 2 - c.offsetHeight / 2, lastBottom + 10);
    Object.assign(c.style, { left: x + 'px', top: y + 'px', width: '246px' }); lastBottom = y + c.offsetHeight;
    const ln = document.createElement('div'); ln.className = 'lead-line';
    const x1 = L + W + 5, y1 = T + H / 2, x2 = x, y2 = y + c.offsetHeight / 2;
    const len = Math.hypot(x2 - x1, y2 - y1), ang = Math.atan2(y2 - y1, x2 - x1);
    Object.assign(ln.style, { left: x1 + 'px', top: y1 + 'px', width: len + 'px', transform: 'rotate(' + ang + 'rad)' }); b.append(ln);
  }
}
