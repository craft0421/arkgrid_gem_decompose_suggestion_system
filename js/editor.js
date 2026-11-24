// 보유 젬 편집 표. 줄 단위로 바로 고치고, 잘못된 값은 그 줄에 표시한다.
import { GEM_TYPES, TYPE_NAMES, EFFECT_LABEL, validateGem } from './model.js';


/**
 * opts: { table, getGems(), setGems(gems), onChange(), famFilter(), resetFam(), reveal()? }
 */
export function createEditor(opts) {
  const { table } = opts;
  table.tHead.innerHTML = '<tr><th class="r">#</th><th>계열</th><th>타입</th><th class="r">필요 의지력</th><th class="r">포인트</th><th>효과 1</th><th>Lv</th><th>효과 2</th><th>Lv</th><th title="다른 프리셋에서 쓰는 젬 등: 판정에서 빼고 절대 분해 추천 안 함">잠금</th><th>확인</th><th></th></tr>';

  function effectOptions(type, selected) {
    return GEM_TYPES[type].pool.map((e) => `<option value="${e}"${e === selected ? ' selected' : ''}>${EFFECT_LABEL[e]}</option>`).join('');
  }
  function rowHtml(g, idx) {
    const t = GEM_TYPES[g.type];
    const errs = validateGem(g);
    return `<td class="r num">${idx + 1}</td>` +
      `<td><span class="fam-tag">${t ? t.family : ''}</span></td>` +
      `<td><select class="cell-in" data-f="type" aria-label="타입">${TYPE_NAMES.map((n) => `<option${n === g.type ? ' selected' : ''}>${n}</option>`).join('')}</select></td>` +
      `<td class="r"><input class="cell-in n" data-f="will" type="number" min="${t.baseWill - 5}" max="${t.baseWill - 1}" value="${g.will ?? ''}" aria-label="필요 의지력"></td>` +
      `<td class="r"><input class="cell-in n" data-f="points" type="number" min="1" max="5" value="${g.points ?? ''}" aria-label="포인트"></td>` +
      `<td><select class="cell-in" data-f="e1" aria-label="효과 1">${effectOptions(g.type, g.e1)}</select></td>` +
      `<td><input class="cell-in lv" data-f="l1" type="number" min="1" max="5" value="${g.l1 ?? ''}" aria-label="효과 1 레벨"></td>` +
      `<td><select class="cell-in" data-f="e2" aria-label="효과 2">${effectOptions(g.type, g.e2)}</select></td>` +
      `<td><input class="cell-in lv" data-f="l2" type="number" min="1" max="5" value="${g.l2 ?? ''}" aria-label="효과 2 레벨"></td>` +
      `<td><input type="checkbox" data-f="locked"${g.locked ? ' checked' : ''} aria-label="잠금 (다른 프리셋용)"></td>` +
      `<td>${errs.length ? `<span class="row-err">${errs.join(' · ')}</span>` : ''}${g.check ? ` <span class="chk-tag" title="값을 고치면 사라집니다">인식 확인: ${g.check}</span>` : ''}</td>` +
      `<td><button class="btn small danger" data-act="del" title="잘못 들어간 줄 지우기">삭제</button></td>`;
  }

  function render() {
    const gems = opts.getGems();
    const fam = opts.famFilter();
    const body = table.tBodies[0];
    body.innerHTML = '';
    gems.forEach((g, idx) => {
      if (fam !== 'all' && GEM_TYPES[g.type]?.family !== fam) return;
      const tr = document.createElement('tr');
      tr.dataset.id = g.id;
      tr.innerHTML = rowHtml(g, idx);
      if (validateGem(g).length) tr.classList.add('bad');
      else if (g.check) tr.classList.add('chk');
      body.appendChild(tr);
    });
  }

  function refreshRow(tr, g) {
    const idx = opts.getGems().indexOf(g);
    const focusedField = document.activeElement?.dataset?.f;
    tr.innerHTML = rowHtml(g, idx);
    tr.classList.toggle('bad', validateGem(g).length > 0);
    tr.classList.toggle('chk', !!g.check && !validateGem(g).length);
    if (focusedField) tr.querySelector(`[data-f="${focusedField}"]`)?.focus();
  }

  table.tBodies[0].addEventListener('change', (e) => {
    const el = e.target, tr = el.closest('tr');
    if (!tr || !el.dataset.f) return;
    const gems = opts.getGems();
    const g = gems.find((x) => x.id === tr.dataset.id);
    const f = el.dataset.f;
    if (f === 'type') {
      // 타입이 바뀌면 효과 풀이 달라지므로 없는 효과는 새 풀의 효과로 바꿈
      const pool = GEM_TYPES[el.value].pool;
      g.type = el.value;
      if (!pool.includes(g.e1)) g.e1 = pool.find((x) => x !== g.e2) ?? pool[0];
      if (!pool.includes(g.e2) || g.e2 === g.e1) g.e2 = pool.find((x) => x !== g.e1);
    } else if (f === 'locked') g.locked = el.checked;
    else if (f === 'e1' || f === 'e2') g[f] = el.value;
    else g[f] = el.value === '' ? null : Number(el.value);
    g.check = null; // 사용자가 확인·수정함
    refreshRow(tr, g);
    opts.onChange();
  });

  table.tBodies[0].addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const tr = b.closest('tr');
    const gems = opts.getGems();
    const i = gems.findIndex((x) => x.id === tr.dataset.id);
    if (b.dataset.act === 'del') gems.splice(i, 1);
    opts.setGems(gems);
    render();
    opts.onChange();
  });

  /** 젬 줄로 이동해서 강조 (결과 표의 '수정' 버튼에서 사용) */
  function focusGem(id) {
    opts.reveal?.();
    let tr = table.querySelector(`tr[data-id="${id}"]`);
    if (!tr && opts.famFilter() !== 'all') { opts.resetFam(); render(); tr = table.querySelector(`tr[data-id="${id}"]`); }
    if (!tr) return;
    tr.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash');
    tr.querySelector('[data-f="will"]')?.focus({ preventScroll: true });
  }

  return { render, focusGem };
}
