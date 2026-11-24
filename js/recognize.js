// 아크 그리드 젬 목록 화면 인식 (docs/SCREEN_RECOGNITION.md)
// 입력 이미지 형식: { width, height, data: RGBA Uint8(Clamped)Array } — 브라우저 ImageData와 같음. Node 테스트에서도 사용.
//
// 순서: 화면을 1080 기준 배율로 맞춤 → 정렬 막대("의지력 순 ▲ / 포인트 순 ▼")를 찾아 목록 위치를 정함(창 이동 대응)
//      → 9줄을 읽음(숫자·효과·Lv·장착·타입) → 스크롤 막대 위치 → 여러 장을 겹침+스크롤 위치로 이어 붙임
// 주의: 목록에는 같은 계열의 '다른 코어에 장착된 젬'이 나오지 않음 (선택한 코어에 장착된 젬 + 미장착 젬만)

// ---- 기준 좌표 (1920×1080, 정렬 막대 왼쪽 위 = 원점) ----
export const GEO = {
  anchor: { w: 428, h: 32 },          // 정렬 막대 두 칸 영역 (기준 화면 x 1272~1700, y 268~300)
  row0: 56, pitch: 63, line2: 28,     // 첫 줄 숫자 윗변(원점 기준), 줄 간격, 둘째 줄 오프셋
  digitX: 64, digitW: 24,             // 숫자 탐색 영역
  bandX: 126, bandW: 242,             // 효과 줄 (이름 + Lv)
  btnX: 328, btnW: 60,                // 해제 버튼
  glyphX: 16, glyphDy: 6, glyphS: 26, // 타입 문양 (줄 윗변 기준)
  iconX: 2, iconW: 52,                // 아이콘 전체 (계열 색 판별)
  thumbX: 416, thumbW: 11, trackTop: 59, trackBottom: 594, // 스크롤 막대 (원점 기준 y)
  rows: 9,
};
const LINE_H = 17;

export const GEM_TYPES = {
  안정: { family: '질서', baseWill: 8, pool: ['공격력', '추가피해', '아군피해강화', '낙인력'] },
  견고: { family: '질서', baseWill: 9, pool: ['공격력', '보스피해', '아군피해강화', '아군공격강화'] },
  불변: { family: '질서', baseWill: 10, pool: ['추가피해', '보스피해', '낙인력', '아군공격강화'] },
  침식: { family: '혼돈', baseWill: 8, pool: ['공격력', '추가피해', '아군피해강화', '낙인력'] },
  왜곡: { family: '혼돈', baseWill: 9, pool: ['공격력', '보스피해', '아군피해강화', '아군공격강화'] },
  붕괴: { family: '혼돈', baseWill: 10, pool: ['추가피해', '보스피해', '낙인력', '아군공격강화'] },
};

// ---- 픽셀 특징 ----
const clip01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const px = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
const whiteL = (r, g, b) => clip01((Math.min(r, g, b) - 60) / 150);
// 노란 글씨(Lv): 노란 기가 있는 픽셀만 남기고 밝기로 세기를 매김 (가는 획이 약해지지 않게)
const yellowL = (r, g, b) => (Math.min(r, g) - b > 30 ? clip01(((r + g) / 2 - 70) / 110) : 0);
const glyphL = (r, g, b) => clip01((Math.min(r, g, b) - 150) / 80);

function field(img, x0, y0, w, h, fn) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = x0 + x, Y = y0 + y;
    if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue;
    const [r, g, b] = px(img, X, Y);
    out[y * w + x] = fn(r, g, b);
  }
  return { w, h, d: out };
}
const colMax = (f, c) => { let m = 0; for (let y = 0; y < f.h; y++) m = Math.max(m, f.d[y * f.w + c]); return m; };
function sub(f, x0, w) { // 가로 [x0, x0+w) 잘라내기 (넘치면 0)
  const out = new Float32Array(w * f.h);
  for (let y = 0; y < f.h; y++) for (let x = 0; x < w; x++) { const X = x0 + x; if (X >= 0 && X < f.w) out[y * w + x] = f.d[y * f.w + X]; }
  return { w, h: f.h, d: out };
}

/** 잉크(값>0.4)가 시작하는 위·왼쪽 모서리에 맞춰 w×h로 잘라냄 (줄마다 1px씩 다른 세로 위치 보정) */
function inkBox(f, w, h) {
  let top = -1, left = -1;
  for (let y = 0; y < f.h && top < 0; y++) for (let x = 0; x < f.w; x++) if (f.d[y * f.w + x] > 0.4) { top = y; break; }
  for (let x = 0; x < f.w && left < 0; x++) for (let y = 0; y < f.h; y++) if (f.d[y * f.w + x] > 0.4) { left = x; break; }
  const out = new Float32Array(w * h);
  if (top >= 0) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const Y = top + y, X = left + x;
    if (Y < f.h && X < f.w) out[y * w + x] = f.d[Y * f.w + X];
  }
  return { w, h, d: out };
}

// ---- 배율 맞추기 ----
/** 화면 전체 캡처 기준 UI 배율 (docs: min(높이, 너비×9/16)/1080) */
export const uiScale = (w, h) => Math.min(h, (w * 9) / 16) / 1080;
/** 배율 s인 이미지를 기준(1080) 크기로 다시 그림 (양선형) */
export function rescale(img, s) {
  if (Math.abs(s - 1) < 0.005) return img;
  const W = Math.round(img.width / s), H = Math.round(img.height / s);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(img.height - 1.001, Math.max(0, (y + 0.5) * s - 0.5)), y0 = Math.floor(sy), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(img.width - 1.001, Math.max(0, (x + 0.5) * s - 0.5)), x0 = Math.floor(sx), fx = sx - x0;
      const i00 = (y0 * img.width + x0) * 4, i01 = i00 + 4, i10 = i00 + img.width * 4, i11 = i10 + 4, o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        data[o + c] = (img.data[i00 + c] * (1 - fx) + img.data[i01 + c] * fx) * (1 - fy) + (img.data[i10 + c] * (1 - fx) + img.data[i11 + c] * fx) * fy;
      }
      data[o + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

// ---- 기준 표식(정렬 막대) 찾기 ----
function grayDown(img, k) { // k배 축소 흑백
  const W = Math.floor(img.width / k), H = Math.floor(img.height / k), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) { const [r, g, b] = px(img, x * k + dx, y * k + dy); s += (r + g + b) / 3; }
    out[y * W + x] = s / (k * k);
  }
  return { w: W, h: H, d: out };
}
/** 템플릿 대조 (평균 절대차). 반환 { x, y, score } — score 낮을수록 일치 */
function matchTemplate(G, T, x0 = 0, y0 = 0, x1 = G.w - T.w, y1 = G.h - T.h, step = 1) {
  let best = { x: 0, y: 0, score: Infinity };
  const tn = T.w * T.h;
  for (let y = Math.max(0, y0); y <= Math.min(y1, G.h - T.h); y += step) {
    for (let x = Math.max(0, x0); x <= Math.min(x1, G.w - T.w); x += step) {
      let s = 0;
      for (let ty = 0; ty < T.h && s < best.score * tn; ty++) {
        const gi = (y + ty) * G.w + x, ti = ty * T.w;
        for (let tx = 0; tx < T.w; tx++) s += Math.abs(G.d[gi + tx] - T.d[ti + tx]);
      }
      if (s / tn < best.score) best = { x, y, score: s / tn };
    }
  }
  return best;
}
/** 기준 크기 이미지에서 정렬 막대 위치 찾기 (거친 탐색 → 정밀 보정) */
export function findAnchor(img, T) {
  const k = T.anchorQ.k;
  const G = grayDown(img, k);
  const coarse = matchTemplate(G, T.anchorQ);
  const G1 = grayDown(img, 1);
  const fine = matchTemplate(G1, T.anchorF, coarse.x * k - k * 2, coarse.y * k - k * 2, coarse.x * k + k * 2, coarse.y * k + k * 2);
  return fine;
}

/** 직전 위치 hint {x,y} 주변 ±r px만 대조 */
export function findAnchorNear(img, T, hint, r = 4) {
  const x0 = hint.x - r, y0 = hint.y - r, w = T.anchorF.w + 2 * r, h = T.anchorF.h + 2 * r;
  if (x0 < 0 || y0 < 0 || x0 + w > img.width || y0 + h > img.height) return null;
  const G = { w, h, d: new Float32Array(w * h) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [R, Gr, B] = px(img, x0 + x, y0 + y); G.d[y * w + x] = (R + Gr + B) / 3; }
  const m = matchTemplate(G, T.anchorF);
  return { x: m.x + x0, y: m.y + y0, score: m.score };
}

// ---- 한 줄 특징 추출 (템플릿 생성과 인식이 같은 함수를 씀) ----
export function rowFeatures(img, ax, ay, r) {
  const top = ay + GEO.row0 + GEO.pitch * r;
  const f = { r };
  for (const [li, dy] of [[0, 0], [1, GEO.line2]]) {
    const y0 = top + dy - 3;
    const dg = field(img, ax + GEO.digitX, y0, GEO.digitW, LINE_H, whiteL);
    let c0 = -1;
    for (let c = 0; c < dg.w; c++) if (colMax(dg, c) > 0.4) { c0 = c; break; }
    f[`d${li}`] = c0 < 0 ? null : sub(dg, c0, 10);
    const bw = field(img, ax + GEO.bandX, y0, GEO.bandW, LINE_H, whiteL);
    const by = field(img, ax + GEO.bandX, y0, GEO.bandW, LINE_H, yellowL);
    const yc = []; for (let c = 0; c < by.w; c++) if (colMax(by, c) > 0.45) yc.push(c);
    if (!yc.length) { f[`n${li}`] = null; f[`l${li}`] = null; continue; }
    const runs = []; let s = yc[0], p = yc[0];
    for (const c of yc.slice(1)) { if (c > p + 2) { runs.push([s, p]); s = c; } p = c; }
    runs.push([s, p]);
    f[`l${li}`] = inkBox(sub(by, runs[runs.length - 1][0], 9), 9, 12);
    const nameEnd = runs[0][0] - 2;
    let n0 = -1; for (let c = 0; c < nameEnd; c++) if (colMax(bw, c) > 0.4) { n0 = c; break; }
    f[`n${li}`] = n0 < 0 ? null : sub(sub(bw, 0, nameEnd), n0, 120);
  }
  // 해제 버튼(회색 상자) 비율
  let gray = 0, n = 0;
  for (let y = top + 4; y < top + 30; y++) for (let x = ax + GEO.btnX; x < ax + GEO.btnX + GEO.btnW; x++) {
    const [R, G, B] = px(img, x, y); const m = (R + G + B) / 3;
    if (Math.abs(R - B) < 25 && m > 55 && m < 140) gray++; n++;
  }
  f.btn = gray / n;
  f.glyph = field(img, ax + GEO.glyphX, top + GEO.glyphDy, GEO.glyphS, GEO.glyphS, glyphL);
  // 아이콘 색: 파랑이 더 세면 혼돈
  let rs = 0, bs = 0;
  for (let y = top + 2; y < top + 32; y++) for (let x = ax + GEO.iconX + 8; x < ax + GEO.iconX + 38; x++) { const [R, , B] = px(img, x, y); rs += R; bs += B; }
  f.family = bs > rs ? '혼돈' : '질서';
  return f;
}

/** 스크롤 막대 손잡이 윗변 (원점 기준 y). 막대가 없으면 null */
export function thumbTop(img, ax, ay) {
  const x0 = ax + GEO.thumbX;
  let run = 0, start = -1;
  for (let y = ay + GEO.trackTop - 2; y < ay + GEO.trackBottom + 14; y++) {
    let s = 0; for (let x = x0; x < x0 + GEO.thumbW; x++) { const [r, g, b] = px(img, x, y); s += (r + g + b) / 3; }
    if (s / GEO.thumbW > 60) { if (run === 0) start = y; run++; if (run >= 30) return start - ay; } else run = 0;
  }
  return null;
}

// ---- 분류 ----
/** 평균 절대차. 글자 렌더링이 1px씩 어긋나는 경우가 있어 가로·세로 ±1px 이동 중 최소값을 씀 */
export function shiftDist(f, e) {
  let best = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    let s = 0;
    for (let y = 0; y < e.h; y++) {
      const fy = y + dy;
      for (let x = 0; x < e.w; x++) {
        const fx = x + dx;
        const v = fy >= 0 && fy < f.h && fx >= 0 && fx < f.w ? f.d[fy * f.w + fx] : 0;
        s += Math.abs(v - e.d[y * e.w + x]);
      }
    }
    if (s < best) best = s;
  }
  return best / (e.w * e.h);
}
/** 가장 가까운 견본. 반환 { label, d, margin(2등 다른 라벨과의 차) } */
export function nearest(feat, exemplars, allowed) {
  let best = null, second = null;
  for (const e of exemplars) {
    if (allowed && !allowed.includes(e.label)) continue;
    const d = shiftDist(feat, e);
    if (!best || d < best.d) { if (best && best.label !== e.label) second = best; best = { label: e.label, d }; }
    else if (e.label !== best.label && (!second || d < second.d)) second = { label: e.label, d };
  }
  return best ? { label: best.label, d: best.d, margin: second ? second.d - best.d : 1 } : null;
}

/**
 * Lv 3과 5는 렌더링에 따라 견본 거리만으로 헷갈림(실측: 다른 캐릭터 화면에서 5→3 오인식 22건 중 7건은 경고도 없었음).
 * 5에만 있는 '위쪽 왼쪽 세로획'으로 다시 판정하고, 견본 판정과 다르면 획 판정을 따르며 경고를 남김.
 * f: inkBox로 위·왼쪽을 맞춘 Lv 특징(9×12)
 */
function checkLv35(f, label, warn) {
  if (label !== 3 && label !== 5) return label;
  let bottom = 0;
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) if (f.d[y * f.w + x] > 0.45) bottom = y;
  const yq = Math.max(2, Math.round(bottom * 0.3));
  let left = 0;
  for (let y = yq - 1; y <= yq + 1; y++) for (let x = 0; x < 2; x++) left = Math.max(left, f.d[y * f.w + x] ?? 0);
  const byStroke = left > 0.45 ? 5 : 3;
  if (byStroke !== label && !warn.includes('Lv 확인 필요')) warn.push('Lv 확인 필요');
  return byStroke;
}

/** 줄 특징 → 젬. 확신이 낮은 항목은 warn에 적음 */
export function classifyRow(f, T, scale = 1, tol = 1) {
  if (!f.d0 || !f.d1 || !f.n0 || !f.n1 || !f.l0 || !f.l1) return null; // 빈 줄
  const warn = [];
  // 1080이 아닌 화면은 배율을 맞추며 흐려져 거리가 커짐(실측 10~20배) → 거리 기준을 늘리고, 2등과의 차이를 거리에 비례해 봄
  const loose = (Math.abs(scale - 1) < 0.01 ? 1 : 12) * tol; // tol: 사용자가 고르는 허용 오차 (엄격 0.7 / 보통 1 / 느슨 1.6)
  const pick = (feat, list, what, allowed) => {
    const r = nearest(feat, list, allowed);
    if (!r) { warn.push(`${what} 인식 불가`); return null; }
    if (r.d > T.thr[what] * loose || r.margin < Math.max(T.thr.margin, 0.15 * r.d) / tol) warn.push(`${what} 확인 필요`);
    return r.label;
  };
  const will = pick(f.d0, T.digit, '숫자'), points = pick(f.d1, T.digit, '숫자');
  const e1 = pick(f.n0, T.name, '효과'), e2 = pick(f.n1, T.name, '효과');
  const l1 = checkLv35(f.l0, pick(f.l0, T.lv, 'Lv'), warn), l2 = checkLv35(f.l1, pick(f.l1, T.lv, 'Lv'), warn);
  // 타입: 계열·효과·의지력으로 후보를 줄이고, 후보가 여럿이면 문양으로 고름
  const cands = Object.entries(GEM_TYPES).filter(([, t]) => t.family === f.family && t.pool.includes(e1) && t.pool.includes(e2) && will >= t.baseWill - 5 && will <= t.baseWill - 1).map(([k]) => k);
  let type = null;
  if (cands.length === 1) type = cands[0];
  else if (cands.length > 1) {
    const withTpl = cands.filter((c) => T.glyph.some((g) => g.label === c));
    const g = withTpl.length ? nearest(f.glyph, T.glyph, withTpl) : null;
    type = g ? g.label : cands[0];
    // 견본 없는 타입(예: 불변)이 후보에 있으면, 문양이 견본과 충분히 가까울 때만 확신
    if (!g || (withTpl.length < cands.length && g.d > T.thr.문양 * loose) || g.margin < T.thr.margin) warn.push('타입 확인 필요');
  } else warn.push('타입 판별 불가(효과·의지력 조합이 맞는 타입 없음)');
  return { type, family: f.family, will, points, e1, l1, e2, l2, equipped: f.btn > 0.3, warn };
}

/** 이미지 한 장 → { ok, anchor, scale, thumb, family, rows } */
export function readFrame(raw, T, opts = {}) {
  // opts.scale: 화면 일부만 잘라 넣을 때 등 배율을 직접 지정
  const scale = opts.scale ?? uiScale(raw.width, raw.height);
  const img = rescale(raw, scale);
  // 직전 화면의 기준 위치 근처를 먼저 봄 (창을 옮기지 않았다면 전체 탐색을 건너뛰어 빠름)
  let anchor = opts.hint ? findAnchorNear(img, T, opts.hint) : null;
  if (!anchor || anchor.score > T.thr.anchor) anchor = findAnchor(img, T);
  const tol = opts.tol ?? 1;
  if (anchor.score > T.thr.anchor * tol) return { ok: false, reason: '젬 목록을 찾지 못함 (아크 그리드 → 젬 탭이 보이는지 확인)', anchor, scale };
  const rows = [];
  for (let r = 0; r < GEO.rows; r++) {
    const g = classifyRow(rowFeatures(img, anchor.x, anchor.y, r), T, scale, tol);
    if (g) rows.push(g);
  }
  const fam = rows.length ? (rows.filter((g) => g.family === '혼돈').length > rows.length / 2 ? '혼돈' : '질서') : null;
  return { ok: true, anchor, scale, thumb: thumbTop(img, anchor.x, anchor.y), family: fam, rows };
}

// ---- 템플릿 (scripts/build-rec-templates.js가 만든 압축 데이터 → 사용 형태) ----
function b64ToBytes(s) {
  if (typeof atob === 'function') { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  return Uint8Array.from(Buffer.from(s, 'base64'));
}
const unpack = (e) => { const b = b64ToBytes(e.b64); const d = new Float32Array(b.length); for (let i = 0; i < b.length; i++) d[i] = b[i] / 255; return { label: e.label, w: e.w, h: e.h, d }; };
export function prepareTemplates(raw) {
  const anchorF = unpack(raw.anchorF);
  for (let i = 0; i < anchorF.d.length; i++) anchorF.d[i] *= 255;
  const anchorQ = unpack(raw.anchorQ);
  for (let i = 0; i < anchorQ.d.length; i++) anchorQ.d[i] *= 255;
  anchorQ.k = raw.anchorQ.k;
  return { anchorF, anchorQ, digit: raw.digit.map(unpack), lv: raw.lv.map(unpack), name: raw.name.map(unpack), glyph: raw.glyph.map(unpack), thr: raw.thr };
}

// ---- 여러 장 이어 붙이기 ----
const rowKey = (g) => `${g.type}|${g.will}|${g.points}|${g.e1}${g.l1}|${g.e2}${g.l2}|${g.equipped ? 1 : 0}`;
const THUMB_RANGE = 475; // 손잡이 이동 범위(px): 막대 위 끝~손잡이 최저 위치 (1080 기준 실측, 손잡이 크기는 줄 수와 무관)

/**
 * 같은 스크롤 위치(손잡이 ±1px)에서 찍힌 화면들을 줄마다 다수결로 하나로 합침.
 * 마우스를 올린 줄이 밝아지거나 스크롤 중간에 찍혀 한 장만 다르게 읽힌 줄을 걸러 냄.
 */
function consensus(group) {
  const len = Math.max(...group.map((f) => f.rows.length));
  const rows = [];
  for (let r = 0; r < len; r++) {
    const votes = new Map();
    for (const f of group) {
      const g = f.rows[r]; if (!g) continue;
      const k = rowKey(g), v = votes.get(k) ?? { n: 0, clean: null, any: g };
      v.n++; if (!g.warn.length && !v.clean) v.clean = g;
      votes.set(k, v);
    }
    const sorted = [...votes.values()].sort((a, b) => b.n - a.n || (b.clean ? 1 : 0) - (a.clean ? 1 : 0));
    const top = sorted[0];
    const g = { ...(top.clean ?? top.any), warn: [...(top.clean ?? top.any).warn] };
    if (sorted.length > 1 && sorted[1].n * 2 >= top.n && !g.warn.includes('화면마다 다르게 읽힘')) g.warn.push('화면마다 다르게 읽힘');
    rows.push(g);
  }
  return rows;
}

/**
 * 같은 계열 화면들을 '목록 안의 위치'로 이어 붙임 (화면 순서·스크롤 방향과 무관 → 위아래로 여러 번 스크롤해도 중복 없음).
 *
 * 목록 구조: 맨 위에 '선택한 코어'의 장착 젬 e개(0~4, 해제 버튼 있음) + 아래에 미장착 젬 U개(어느 코어를 골라도 같은 순서).
 * 다른 코어에 장착된 젬은 목록에 안 나옴 → 코어를 바꾸면 e와 전체 길이(U+e)가 달라짐. 모든 젬을 해제한 프리셋이면 e=0.
 * 화면의 첫 줄 위치 = (손잡이 위치 − 맨 위) / 한 줄 픽셀, 한 줄 픽셀 = 475 / (U+e − 9).
 * U 후보마다, 화면마다 가능한 e(줄 경계에서 1.5px 안 + 맨 위 장착 줄 수가 맞는 것) 중 이미 놓인 내용과 가장 맞는 e를 골라 놓고,
 * (겹친 칸 내용이 다른 수×3 + 못 본 칸 수)가 가장 적은 U를 고름. e는 맨 위 화면에서 본 값들로 제한(맨 위를 못 봤으면 0~4).
 * 반환 { rows(장착 젬 묶음들 + 미장착 U줄), total, gaps:[{after, missing, from, to}], consistent, conflicts, equippedSets }
 */
export function stitch(frames) {
  const fs = frames.filter((f) => f.ok && f.rows.length);
  if (!fs.length) return { rows: [], total: 0, gaps: [], consistent: true, conflicts: 0, equippedSets: 0 };
  const withT = fs.filter((f) => f.thumb != null);
  if (!withT.length) { // 스크롤 막대 없음 = 9줄 이하 한 화면
    const rows = consensus(fs);
    return { rows, total: rows.length, gaps: [], consistent: true, conflicts: 0, equippedSets: 0 };
  }
  // 손잡이 위치(±1px)와 내용(9줄 중 7줄 이상 같음)으로 묶고 묶음마다 다수결
  const sorted = withT.slice().sort((a, b) => a.thumb - b.thumb);
  const groups = [];
  const similar = (A, B) => { let n = 0; const m = Math.min(A.length, B.length); for (let j = 0; j < m; j++) if (rowKey(A[j]) === rowKey(B[j])) n++; return n >= Math.max(1, m - 2) && A.length === B.length; };
  for (const f of sorted) {
    const g = groups.find((x) => Math.abs(f.thumb - x.frames[0].thumb) <= 1 && similar(x.frames[0].rows, f.rows));
    if (g) g.frames.push(f); else groups.push({ frames: [f] });
  }
  for (const g of groups) {
    const ts = g.frames.map((f) => f.thumb).sort((a, b) => a - b);
    g.off = ts[ts.length >> 1] - GEO.trackTop;
    g.rows = consensus(g.frames);
    g.keys = g.rows.map(rowKey);
    g.q = 0; while (g.q < g.rows.length && g.rows[g.q].equipped) g.q++; // 맨 위부터 이어지는 장착 줄 수
  }
  // 맨 위 화면에서 본 e 값들 (못 봤으면 0~4 모두 허용)
  const tops = groups.filter((g) => g.off <= 1);
  const eAllowed = tops.length ? [...new Set(tops.map((g) => g.q))] : [0, 1, 2, 3, 4];
  const maxLen = Math.max(...groups.map((g) => g.rows.length));

  const place = (U) => {
    const cand = groups.map((g) => {
      const out = [];
      for (const e of eAllowed) {
        const N = U + e; if (N <= 9 || N < g.rows.length) continue;
        const p = THUMB_RANGE / (N - 9), start = Math.round(g.off / p), err = Math.abs(g.off - start * p);
        if (err > Math.min(1.5, 0.3 * p) || start + g.rows.length > N) continue;
        if (start < e ? g.q !== e - start : start === 0 && g.q > 0) continue; // 맨 위에 보이는 장착 줄 수가 맞아야 함 (아래쪽 화면은 장착 표시 오인식에 흔들리지 않게 보지 않음)
        out.push({ e, start, mis: (err / p) ** 2 });
      }
      return out;
    });
    if (cand.some((c) => !c.length)) return null;
    const cells = new Map(); // U 안의 위치 → Map(내용 → 표 수)
    const add = (g, c, sign = 1) => g.keys.forEach((k, j) => {
      const u = c.start + j - c.e; if (u < 0) return; // 장착 줄은 따로
      const m = cells.get(u) ?? new Map(); m.set(k, (m.get(k) ?? 0) + sign); cells.set(u, m);
    });
    const clash = (g, c) => g.keys.reduce((n, k, j) => { const u = c.start + j - c.e; if (u < 0) return n; const m = cells.get(u); if (!m) return n; const tot = [...m.values()].reduce((a, b) => a + b, 0); return n + tot - (m.get(k) ?? 0); }, 0);
    const order = groups.map((g, i) => i).sort((a, b) => cand[a].length - cand[b].length || groups[b].frames.length - groups[a].frames.length);
    const pick = new Array(groups.length); let mis = 0;
    for (const i of order) {
      let best = null;
      for (const c of cand[i]) { const x = clash(groups[i], c) * 10 + c.mis; if (!best || x < best.x) best = { c, x }; }
      pick[i] = best.c; mis += best.c.mis; add(groups[i], best.c);
    }
    let conflicts = 0;
    for (const m of cells.values()) { const tot = [...m.values()].reduce((a, b) => a + b, 0); conflicts += tot - Math.max(...m.values()); }
    const uncovered = U - [...cells.keys()].filter((u) => u < U).length;
    return { U, pick, conflicts, uncovered, score: (conflicts * 3 + uncovered) * 1000 + mis };
  };
  let best = null;
  for (let U = Math.max(1, maxLen - 4); U <= 200; U++) { const r = place(U); if (r && (!best || r.score < best.score)) best = r; }
  if (!best) { // 스크롤 위치로 못 맞춤 (손잡이 인식 이상): 위치 순서대로 단순히 잇고 경고
    const rows = groups.flatMap((g) => g.rows);
    return { rows, total: rows.length, gaps: [], consistent: false, conflicts: 0, equippedSets: 0 };
  }
  // 장착 젬: 선택한 코어마다 다른 묶음 → 내용이 같은 묶음은 하나로
  const eqSets = new Map();
  groups.forEach((g, i) => {
    const c = best.pick[i], n = Math.max(0, c.e - c.start);
    if (!n || c.start !== 0) return;
    const set = g.rows.slice(0, n), k = set.map(rowKey).sort().join(',');
    if (!eqSets.has(k)) eqSets.set(k, set);
  });
  // 미장착 U줄: 칸마다 가장 많이 읽힌 내용 (다르게 읽힌 칸은 경고)
  const slots = new Array(best.U).fill(null);
  groups.forEach((g, i) => g.rows.forEach((row, j) => {
    const u = best.pick[i].start + j - best.pick[i].e; if (u < 0 || u >= best.U) return;
    const m = slots[u] ?? (slots[u] = new Map());
    const v = m.get(g.keys[j]) ?? { n: 0, row }; v.n += g.frames.length; if (v.row.warn.length && !row.warn.length) v.row = row; m.set(g.keys[j], v);
  }));
  const eRows = [...eqSets.values()].flat().map((r) => ({ ...r, warn: [...r.warn] }));
  const rows = [...eRows], gaps = [];
  const eShow = eAllowed.length === 1 ? eAllowed[0] : 0; // 게임 목록에서의 줄 번호 = 장착 줄 수 + U 안의 위치
  for (let u = 0; u < best.U; u++) {
    const m = slots[u];
    if (!m) {
      const last = gaps[gaps.length - 1];
      if (last && last.to === u + eShow) { last.missing++; last.to = u + eShow + 1; } else gaps.push({ after: rows.length, missing: 1, from: u + eShow + 1, to: u + eShow + 1 });
      continue;
    }
    const vs = [...m.values()].sort((a, b) => b.n - a.n);
    const row = { ...vs[0].row, warn: [...vs[0].row.warn] };
    if (vs.length > 1 && !row.warn.includes('화면마다 다르게 읽힘')) row.warn.push('화면마다 다르게 읽힘');
    rows.push(row);
  }
  return { rows, total: best.U + eRows.length, gaps, consistent: best.conflicts === 0, conflicts: best.conflicts, equippedSets: eqSets.size };
}
