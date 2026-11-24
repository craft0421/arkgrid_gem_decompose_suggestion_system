// 결과 화면: 판정 표(사용 확률 낮은 순), 직전 계산 대비 변화, 현재 최적 배치, 사용 중 젬 막대
import { EFFECT_LABEL } from './model.js';

const CAT = { '유지': 'keep', '보류': 'hold', '분해 권장': 'rec', '분해 안전': 'safe', '잠금': 'lock' };
const CAT_ORDER = ['분해 안전', '분해 권장', '보류', '유지', '잠금'];
const PAGE = 40;
const pct = (x) => (x * 100).toFixed(1) + '%';
const effStr = (eff) => Object.entries(eff).map(([k, v]) => `${EFFECT_LABEL[k] || k} ${v}`).join(' · ');
const runLabel = (m) => `${m.grade} · ${m.N}개 · ${m.iterations}회`;

export function createResults(els, { onEdit }) {
  const view = { cats: new Set(CAT_ORDER), sort: { key: 'p', dir: 1 }, showAll: false, onlyChanged: false };
  let cur = null, prev = null, gemNo = new Map(), edited = new Set();

  const tip = els.tip;
  const showTip = (html, x, y) => {
    tip.innerHTML = html; tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tip.style.left = Math.max(8, left) + 'px'; tip.style.top = Math.max(8, top) + 'px';
  };
  addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

  const prevOf = (g) => (prev ? prev.byId.get(g.id) : null);
  const tie = (a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category) || b.dominators - a.dominators || a.index - b.index;
  const reasonText = (g) => {
    if (g.category === '분해 안전') return `의지력·포인트·효과가 모두 같거나 나은 젬 ${g.dominators}개`;
    if (g.category === '유지') return `현재 배치에 사용 · 빼면 전투력 −${g.delta.toFixed(3)}%`;
    if (g.category === '분해 권장') return '미래에 거의 안 쓰임';
    if (g.category === '잠금') return '잠금 (판정 제외)';
    return '미래에 쓰일 수 있음';
  };
  const changed = (g) => {
    const p = prevOf(g);
    return !p || edited.has(g.id) || p.category !== g.category || Math.abs(p.pUse - g.pUse) >= 0.005;
  };
  function deltaCell(g) {
    if (!prev) return '';
    const p = prevOf(g);
    if (!p) return '<span class="delta same">새 젬</span>';
    const d = g.pUse - p.pUse;
    const cls = Math.abs(d) < 0.0005 ? 'same' : d > 0 ? 'up' : 'down';
    const txt = Math.abs(d) < 0.0005 ? '±0' : `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(1)}%p`;
    const mv = p.category !== g.category ? `<span class="cat-move">${p.category} → ${g.category}</span>` : '';
    return `<span class="delta ${cls}">${txt}</span>${edited.has(g.id) ? ' <span class="delta same">(수정함)</span>' : ''}${mv}`;
  }

  const COLS = () => [
    { key: 'p', label: '사용 확률', get: (g) => (g.category === '잠금' ? 2 : g.pUse), fmt: (g) => (g.category === '잠금' ? '—' : `${pct(g.pUse)}<span class="pbar"><i style="width:${g.pUse * 100}%"></i></span>`), r: true, num: true },
    ...(prev ? [{ key: 'd', label: '직전 대비', get: (g) => { const p = prevOf(g); return p ? g.pUse - p.pUse : 9; }, fmt: deltaCell }] : []),
    { key: 'cat', label: '판정', get: (g) => CAT_ORDER.indexOf(g.category), fmt: (g) => `<span class="chip"><span class="sw ${CAT[g.category]}"></span>${g.category}</span>${cur.result.recommend.includes(g.index) ? '<span class="rec-tag">추천</span>' : ''}` },
    { key: 'i', label: '#', get: (g) => gemNo.get(g.id) ?? 999, r: true, num: true },
    { key: 'type', label: '계열·타입', get: (g) => g.family + g.type, fmt: (g) => `${g.family} ${g.type}` },
    { key: 'will', label: '필요 의지력', get: (g) => g.will, r: true, num: true },
    { key: 'pts', label: '포인트', get: (g) => g.points, r: true, num: true },
    { key: 'eff', label: '효과', get: (g) => effStr(g.effects), fmt: (g) => effStr(g.effects) },
    { key: 'why', label: '판정 이유', get: reasonText, fmt: (g) => `<span class="reason">${reasonText(g)}</span>` },
    { key: 'act', label: '', get: () => 0, fmt: (g) => `<button class="btn small" data-edit="${g.id}">수정</button>`, nosort: true },
  ];

  function renderChips() {
    const gs = cur.result.gems;
    els.fchips.innerHTML = CAT_ORDER.filter((c) => c !== '잠금' || gs.some((g) => g.category === '잠금')).map((c) =>
      `<button class="fchip" data-c="${c}" aria-pressed="${view.cats.has(c)}"><span class="sw ${CAT[c]}"></span>${c}<span class="n">${gs.filter((g) => g.category === c).length}</span></button>`).join('');
  }
  els.fchips.addEventListener('click', (e) => {
    const b = e.target.closest('.fchip'); if (!b) return;
    const c = b.dataset.c;
    if (view.cats.has(c)) { if (view.cats.size > 1) view.cats.delete(c); } else view.cats.add(c);
    view.showAll = false; renderChips(); renderTable();
  });
  els.onlyChanged.addEventListener('change', () => { view.onlyChanged = els.onlyChanged.checked; view.showAll = false; renderTable(); });

  function renderTable() {
    const cols = COLS();
    if (!cols.some((c) => c.key === view.sort.key)) view.sort = { key: 'p', dir: 1 };
    els.table.tHead.innerHTML = '<tr>' + cols.map((c) => {
      if (c.nosort) return '<th></th>';
      const on = view.sort.key === c.key;
      return `<th class="${c.r ? 'r' : ''}" aria-sort="${on ? (view.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button data-k="${c.key}">${c.label}${on ? (view.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`;
    }).join('') + '</tr>';
    const col = cols.find((c) => c.key === view.sort.key);
    let rows = cur.result.gems.filter((g) => view.cats.has(g.category));
    if (view.onlyChanged && prev) rows = rows.filter(changed);
    rows.sort((a, b) => { const x = col.get(a), y = col.get(b); return (x < y ? -1 : x > y ? 1 : 0) * view.sort.dir || tie(a, b); });
    const body = els.table.tBodies[0];
    body.innerHTML = '';
    for (const g of view.showAll ? rows : rows.slice(0, PAGE)) {
      const tr = document.createElement('tr');
      tr.innerHTML = cols.map((c) => `<td class="${c.r ? 'r' : ''} ${c.num ? 'num' : ''}">${c.fmt ? c.fmt(g) : c.get(g)}</td>`).join('');
      tr.addEventListener('mousemove', (e) => {
        const p = prevOf(g);
        showTip(`<b>#${gemNo.get(g.id) ?? '?'} ${g.family} ${g.type}</b><br>필요 의지력 ${g.will} · 포인트 ${g.points}<br>${effStr(g.effects)}<br><b>${g.category}</b>${g.category === '잠금' ? '' : ` · 사용 확률 ${pct(g.pUse)}`}${p ? `<br>직전(${runLabel(prev.meta)}) ${p.category} · ${pct(p.pUse)}` : ''}`, e.clientX, e.clientY);
      });
      tr.addEventListener('mouseleave', () => { tip.hidden = true; });
      body.appendChild(tr);
    }
    els.more.hidden = rows.length <= PAGE;
    els.more.textContent = view.showAll ? '처음 40개만 보기' : `나머지 ${rows.length - PAGE}개 더 보기`;
    if (!rows.length) body.innerHTML = `<tr><td colspan="${cols.length}" style="color:var(--fg-3)">조건에 맞는 젬이 없습니다.</td></tr>`;
  }
  els.table.tHead.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]'); if (!b) return;
    const k = b.dataset.k;
    view.sort = view.sort.key === k ? { key: k, dir: -view.sort.dir } : { key: k, dir: ['p', 'd', 'i', 'will', 'cat'].includes(k) ? 1 : -1 };
    renderTable();
  });
  els.table.tBodies[0].addEventListener('click', (e) => { const b = e.target.closest('button[data-edit]'); if (b) onEdit(b.dataset.edit); });
  els.more.addEventListener('click', () => { view.showAll = !view.showAll; renderTable(); });

  function renderDiff() {
    if (!prev) { els.diff.hidden = true; return; }
    const gs = cur.result.gems;
    const curIds = new Set(gs.map((g) => g.id));
    const added = gs.filter((g) => !prev.byId.has(g.id));
    const removed = [...prev.byId.values()].filter((p) => !curIds.has(p.id));
    const catMoves = gs.filter((g) => { const p = prevOf(g); return p && p.category !== g.category; });
    const bigMoves = gs.filter((g) => { const p = prevOf(g); return p && p.category === g.category && Math.abs(p.pUse - g.pUse) >= 0.05; });
    const items = [];
    if (edited.size) items.push(`수정한 젬 ${edited.size}개`);
    if (added.length) items.push(`추가한 젬 ${added.length}개`);
    if (removed.length) items.push(`뺀 젬 ${removed.length}개`);
    const settingsChanged = runLabel(prev.meta) !== runLabel(cur.meta);
    const lines = [...catMoves, ...bigMoves].slice(0, 10).map((g) => {
      const p = prevOf(g);
      return `<li>#${gemNo.get(g.id)} ${g.family} ${g.type} (의지력 ${g.will}·P${g.points}): ${p.category === g.category ? '' : `${p.category} → ${g.category}, `}사용 확률 ${pct(p.pUse)} → ${pct(g.pUse)}</li>`;
    });
    els.diff.hidden = false;
    els.diff.innerHTML = `<h3>직전 계산 대비</h3><p>${[settingsChanged ? `조건 ${runLabel(prev.meta)} → ${runLabel(cur.meta)}` : '같은 조건', ...items].join(' · ')}. 판정이 바뀐 젬 ${catMoves.length}개, 같은 판정에서 확률이 5%p 이상 바뀐 젬 ${bigMoves.length}개.</p>` +
      (lines.length ? `<ul>${lines.join('')}</ul>` : '<p style="color:var(--fg-3)">판정이나 확률이 크게 바뀐 젬은 없습니다.</p>') +
      (settingsChanged ? '' : '<p style="color:var(--fg-3);font-size:.8rem">같은 조건이면 미래 젬 시뮬레이션도 똑같은 세트를 쓰므로, 차이는 바꾼 젬 때문에 생긴 것입니다.</p>');
  }

  function renderPlacement() {
    els.placement.innerHTML = cur.result.placement.map((p) => {
      const gs = p.gems.map((i) => cur.result.gems[i]);
      return `<div class="card pcore"><div class="pcore-head"><b>${p.core}</b><span class="num">${p.points}P · ${p.corePct.toFixed(2)}%</span></div>` +
        `<div style="font-size:.78rem;color:var(--fg-3)">의지력 ${p.will}</div><ul>${gs.map((g) => `<li>#${gemNo.get(g.id)} ${g.type} · 의지력 ${g.will} · P${g.points} · ${effStr(g.effects)}</li>`).join('') || '<li>젬 없음</li>'}</ul></div>`;
    }).join('');
  }

  function renderBars() {
    els.legend.innerHTML = `<span><span class="sw keep"></span>${runLabel(cur.meta)} (이번)</span>` + (prev ? `<span><span class="tick-key"></span>${runLabel(prev.meta)} (직전)</span>` : '');
    const gs = cur.result.gems.filter((g) => g.usedNow).sort((a, b) => a.pUse - b.pUse || a.index - b.index);
    els.bars.innerHTML = gs.map((g) => {
      const p = prevOf(g);
      return `<div class="bar-row"><div class="bar-label"><b>#${gemNo.get(g.id)}</b> ${g.family} ${g.type} · 의지력 ${g.will} · P${g.points}</div>` +
        `<div class="track"><div class="fill" style="width:${g.pUse * 100}%"></div>${p ? `<div class="mark" style="left:${p.pUse * 100}%"></div>` : ''}</div><div class="bar-val num">${pct(g.pUse)}</div></div>`;
    }).join('');
  }

  /**
   * run = { result, meta:{grade,N,iterations,seconds}, sig: Map(id→서명) }, previous = 같은 형식 또는 null
   * numbers: Map(id → 편집 표 번호)
   */
  function show(run, previous, numbers) {
    cur = run; gemNo = numbers;
    prev = previous ? { ...previous, byId: new Map(previous.result.gems.map((g) => [g.id, g])) } : null;
    edited = new Set();
    if (prev) for (const [id, s] of run.sig) if (previous.sig.has(id) && previous.sig.get(id) !== s) edited.add(id);
    els.onlyChanged.closest('label').hidden = !prev;
    if (!prev) { view.onlyChanged = false; els.onlyChanged.checked = false; }
    const s = run.result.summary;
    els.sub.innerHTML = `계산 조건 <b>${runLabel(run.meta)}</b>${run.meta.seconds != null ? ` (${run.meta.seconds.toFixed(1)}초)` : ''} · 아크 그리드 전투력은 현재 최적 배치 기준 <b class="num">+${s.currentGainPct.toFixed(2)}%</b>` +
      (run.result.warnings.length ? `<br><span class="err">${run.result.warnings.join(' / ')}</span>` : '');
    renderDiff(); renderChips(); renderTable(); renderPlacement(); renderBars();
  }
  const resultFor = (id) => (cur ? cur.result.gems.find((g) => g.id === id) ?? null : null);
  return { show, resultFor };
}
