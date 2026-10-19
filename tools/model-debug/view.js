// Draws building models: plan (left) and a simple 3/4 view (right). Runs in the page.
window.drawModels = function (data) {
  const { models, cx, cy, half, ppm } = data;
  const W = Math.round(half * 2 * ppm);
  const cv = document.getElementById('c');
  cv.width = W * 2 + 20; cv.height = W + 30;
  const g = cv.getContext('2d');
  g.fillStyle = '#7fae5a'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#000'; g.font = '14px sans-serif'; g.fillText(data.title, 8, cv.height - 10);
  const tw = (m, s, d) => [m.ox + (m.ux * s - m.uy * d) * m.tpm, m.oy + (m.uy * s + m.ux * d) * m.tpm];
  const P = (x, y, ox) => [ox + ((x - cx) / data.tpm + half) * ppm, ((y - cy) / data.tpm + half) * ppm];
  const hsh = (n) => { n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d); return (n ^ (n >>> 12)) >>> 0; };
  const ROOFS = ['#b0472f', '#a5432c', '#6b4a3a', '#4b5563', '#3c3f46', '#8a3a2a'];
  const roofCol = (m, w) => (w.roof === 'flat' ? (m.kind === 'hall' ? '#9aa0a6' : '#8b8f94') : w.roof === 'mansard' ? '#4b5563' : m.kind === 'greenhouse' ? '#cfe8ef' : ROOFS[hsh(m.style >>> 0) % ROOFS.length]);
  const path = (pts) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); };
  // ---- plan
  g.save(); g.beginPath(); g.rect(0, 0, W, W); g.clip();
  for (const m of models) {
    for (const w of m.wings) {
      const b = w.box;
      const pts = [[b.s0, b.d0], [b.s1, b.d0], [b.s1, b.d1], [b.s0, b.d1]].map(([s, d]) => P(...tw(m, s, d), 0));
      g.fillStyle = roofCol(m, w); path(pts); g.fill();
      g.strokeStyle = '#222'; g.lineWidth = 1; g.stroke();
      if (w.roof !== 'flat' && w.roof !== 'shed') {
        const sm = (b.s0 + b.s1) / 2, dm = (b.d0 + b.d1) / 2;
        const inset = w.roof === 'hip' ? Math.min((b.d1 - b.d0) / 2, (b.s1 - b.s0) / 2) : 0;
        let a, c;
        if (w.ridgeAlongS) { a = tw(m, b.s0 + inset, dm); c = tw(m, b.s1 - inset, dm); }
        else { a = tw(m, sm, b.d0 + inset); c = tw(m, sm, b.d1 - inset); }
        g.strokeStyle = '#111'; g.lineWidth = 2; g.beginPath(); g.moveTo(...P(...a, 0)); g.lineTo(...P(...c, 0)); g.stroke();
      }
      if (w.roof === 'shed') { g.fillStyle = 'rgba(255,255,255,0.3)'; path(pts); g.fill(); }
      if (w.party) w.party.forEach((p, side) => {
        if (!p) return;
        const e = [[b.s0, b.d0, b.s1, b.d0], [b.s1, b.d0, b.s1, b.d1], [b.s0, b.d1, b.s1, b.d1], [b.s0, b.d0, b.s0, b.d1]][side];
        g.strokeStyle = '#d0f'; g.lineWidth = 3; g.beginPath(); g.moveTo(...P(...tw(m, e[0], e[1]), 0)); g.lineTo(...P(...tw(m, e[2], e[3]), 0)); g.stroke();
      });
    }
    for (const o of m.openings) {
      if (o.kind === 'window' && o.storey > 0) continue;
      const b = m.wings[o.wing].box;
      const along = o.side === 0 || o.side === 2;
      const c = along ? [b.s0 + o.at, o.side === 0 ? b.d0 : b.d1] : [o.side === 1 ? b.s1 : b.s0, b.d0 + o.at];
      const h = o.w / 2;
      const e = along ? [c[0] - h, c[1], c[0] + h, c[1]] : [c[0], c[1] - h, c[0], c[1] + h];
      g.strokeStyle = o.kind === 'door' ? '#0f0' : o.kind === 'window' ? '#7cf' : o.kind === 'garage' ? '#fa0' : '#ff0';
      g.lineWidth = o.kind === 'window' ? 2 : 4;
      g.beginPath(); g.moveTo(...P(...tw(m, e[0], e[1]), 0)); g.lineTo(...P(...tw(m, e[2], e[3]), 0)); g.stroke();
    }
  }
  for (const m of models) {
    g.strokeStyle = 'rgba(255,0,0,0.85)'; g.lineWidth = 1;
    for (const r of m.src.rings) path(Array.from({ length: r.length / 2 }, (_, i) => P(r[i * 2], r[i * 2 + 1], 0))), g.stroke();
  }
  g.restore();
  // ---- 3/4 view: camera looks north and down, sees south-facing walls
  const X0 = W + 20;
  g.save(); g.beginPath(); g.rect(X0, 0, W, W); g.clip();
  g.fillStyle = '#86b35f'; g.fillRect(X0, 0, W, W);
  const Q = (x, y, z) => { const p = P(x, y, X0); return [p[0], p[1] - z * ppm * 0.75]; };
  const faces = [];
  for (const m of models) {
    m.wings.forEach((w, wi) => {
      const b = w.box, H = w.wallH, R = w.roofH;
      const C = [[b.s0, b.d0], [b.s1, b.d0], [b.s1, b.d1], [b.s0, b.d1]].map(([s, d]) => tw(m, s, d));
      const maxY = Math.max(...C.map((p) => p[1]));
      const cen = tw(m, (b.s0 + b.s1) / 2, (b.d0 + b.d1) / 2);
      const zShed = (s, d) => {
        const hi = w.high ?? 0;
        const t = hi === 0 ? 1 - (d - b.d0) / (b.d1 - b.d0) : hi === 2 ? (d - b.d0) / (b.d1 - b.d0) : hi === 1 ? (s - b.s0) / (b.s1 - b.s0) : 1 - (s - b.s0) / (b.s1 - b.s0);
        return H + R * t;
      };
      const SC = [[b.s0, b.d0], [b.s1, b.d0], [b.s1, b.d1], [b.s0, b.d1]];
      [[0, 1], [1, 2], [2, 3], [3, 0]].forEach(([i, j], side) => {
        const a = C[i], c = C[j];
        const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
        const out = [mid[0] - cen[0], mid[1] - cen[1]];
        if (out[1] <= 0.01) return;
        const along = side === 0 || side === 2;
        const za = w.roof === 'shed' ? zShed(...SC[i]) : H, zc = w.roof === 'shed' ? zShed(...SC[j]) : H;
        const poly = [Q(a[0], a[1], 0), Q(c[0], c[1], 0), Q(c[0], c[1], zc)];
        if (w.roof === 'gable' && along !== w.ridgeAlongS) poly.push(Q(mid[0], mid[1], H + R));
        poly.push(Q(a[0], a[1], za));
        const shade = Math.abs(out[0]) / Math.hypot(out[0], out[1]);
        const L = along ? b.s1 - b.s0 : b.d1 - b.d0;
        const fwd = side === 0 || side === 1;
        const wins = m.openings.filter((o) => o.wing === wi && o.side === side).map((o) => {
          const t0 = fwd ? (o.at - o.w / 2) / L : 1 - (o.at + o.w / 2) / L, t1 = t0 + o.w / L;
          const st = o.storey ?? 0, sh = H / (w.storeys || 1);
          const z0 = o.kind === 'window' ? st * sh + sh * 0.3 : 0;
          const z1 = o.kind === 'window' ? st * sh + sh * 0.78 : o.kind === 'shopfront' ? Math.min(H, 2.8) : o.kind === 'garage' ? 2.2 : 2.1;
          const at = (tt, z) => Q(a[0] + (c[0] - a[0]) * tt, a[1] + (c[1] - a[1]) * tt, z);
          return { kind: o.kind, poly: [at(t0, z0), at(t1, z0), at(t1, z1), at(t0, z1)] };
        });
        faces.push({ depth: Math.max(a[1], c[1]) + 0.001, poly, col: w.party && w.party[side] ? '#8a6a5a' : `hsl(15,40%,${46 - shade * 12}%)`, wins });
      });
      const sm = (b.s0 + b.s1) / 2, dm = (b.d0 + b.d1) / 2;
      const T = (s, d, z) => { const p = tw(m, s, d); return Q(p[0], p[1], z); };
      const col = roofCol(m, w);
      if (w.roof === 'flat' || R <= 0) {
        faces.push({ depth: maxY + 0.002, poly: SC.map(([s, d]) => T(s, d, H)), col });
      } else if (w.roof === 'shed') {
        faces.push({ depth: maxY + 0.002, poly: SC.map(([s, d]) => T(s, d, zShed(s, d))), col: '#5a5f66' });
      } else {
        const ins = w.roof === 'hip' ? Math.min((b.d1 - b.d0) / 2, (b.s1 - b.s0) / 2) : 0;
        const R2 = H + R;
        let planes = w.ridgeAlongS
          ? [[[b.s0, b.d0, H], [b.s1, b.d0, H], [b.s1 - ins, dm, R2], [b.s0 + ins, dm, R2]], [[b.s0, b.d1, H], [b.s1, b.d1, H], [b.s1 - ins, dm, R2], [b.s0 + ins, dm, R2]]]
          : [[[b.s0, b.d0, H], [b.s0, b.d1, H], [sm, b.d1 - ins, R2], [sm, b.d0 + ins, R2]], [[b.s1, b.d0, H], [b.s1, b.d1, H], [sm, b.d1 - ins, R2], [sm, b.d0 + ins, R2]]];
        if (w.roof === 'hip') {
          if (w.ridgeAlongS) planes.push([[b.s0, b.d0, H], [b.s0, b.d1, H], [b.s0 + ins, dm, R2]], [[b.s1, b.d0, H], [b.s1, b.d1, H], [b.s1 - ins, dm, R2]]);
          else planes.push([[b.s0, b.d0, H], [b.s1, b.d0, H], [sm, b.d0 + ins, R2]], [[b.s0, b.d1, H], [b.s1, b.d1, H], [sm, b.d1 - ins, R2]]);
        }
        for (const pl of planes) {
          const ys = pl.map(([s, d]) => tw(m, s, d)[1]);
          const south = (ys[0] + ys[1]) / 2 > ys.slice(2).reduce((x, y) => x + y, 0) / (ys.length - 2);
          faces.push({ depth: maxY + (south ? 0.003 : 0.002), poly: pl.map(([s, d, z]) => T(s, d, z)), col, dark: !south });
        }
      }
    });
  }
  faces.sort((a, b) => a.depth - b.depth);
  for (const f of faces) {
    path(f.poly); g.fillStyle = f.col; g.fill();
    if (f.dark) { g.fillStyle = 'rgba(0,0,0,0.28)'; g.fill(); }
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 1; g.stroke();
    for (const w of f.wins || []) {
      path(w.poly);
      g.fillStyle = w.kind === 'window' ? '#26364d' : w.kind === 'door' ? '#3a2416' : w.kind === 'garage' ? '#c8c8c8' : '#8fbad6'; g.fill();
    }
  }
  g.restore();
};
