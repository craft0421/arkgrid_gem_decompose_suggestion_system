// 사이트 본체: 상태 보관(브라우저 저장), 코어 설정, 젬 편집, 계산 실행, 결과 표시
import { evaluateInBrowser } from '../../engine/browser/run.js';
import {
  GEM_TYPES, CHAOS_CORES, CORE_GRADES, defaultCores, defaultWeapon, blankGem, fromEngineGem,
  validateGem, toEngineInput,
} from './model.js';
import { createEditor } from './editor.js';
import { createResults } from './results.js';
import { createCapture } from './capture.js';

const $ = (id) => document.getElementById(id);
const KEY = 'arkgrid-helper-v1';
const store = {
  load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } },
  save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* 저장 불가(사생활 보호 모드 등): 무시 */ } },
};

const saved = store.load();
const state = {
  cores: saved?.cores ?? defaultCores(),
  weapon: saved?.weapon ?? defaultWeapon(),
  gems: saved?.gems ?? [],
  // 기본값: 당장 깎을 젬 5개, 비울 칸 5개. 예전 기본값(30/10)으로 저장된 설정은 한 번 새 기본값으로 바꿈(v:2)
  settings: { iterations: 200, seed: 12345, role: '딜러', ...(saved?.settings ?? {}), ...(saved?.settings?.v === 2 ? {} : { N: 5, k: 5 }), v: 2 },
  grade: saved?.grade ?? '영웅',
  famFilter: 'all',
  last: saved?.last ?? null,   // { result, meta, sig:[[id,서명]...], key }
  prev: saved?.prev ?? null,
  example: saved?.example ?? false,
};
const persist = () => store.save({ cores: state.cores, weapon: state.weapon, gems: state.gems, settings: state.settings, grade: state.grade, last: state.last, prev: state.prev, example: state.example });

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---- 안내 접기 기억 ----
const notice = $('notice');
try { if (localStorage.getItem(KEY + '-notice') === '0') notice.open = false; } catch (e) {}
notice.addEventListener('toggle', () => { try { localStorage.setItem(KEY + '-notice', notice.open ? '1' : '0'); } catch (e) {} });

// ---- 1. 코어 ----
function renderCores() {
  $('cores').innerHTML = state.cores.map((c, i) => {
    const gradeSel = `<select class="sel" data-i="${i}" data-f="grade" aria-label="${c.family} ${c.slot} 등급">${CORE_GRADES.map((g) => `<option${g === c.grade ? ' selected' : ''}>${g}</option>`).join('')}</select>`;
    let nameSel = '';
    if (c.family === '혼돈') {
      nameSel = `<select class="sel" data-i="${i}" data-f="name" aria-label="혼돈 ${c.slot} 코어 종류">${CHAOS_CORES[c.slot].map((n) => `<option${n === c.name ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
    }
    const meta = c.family === '질서' ? (c.slot === '별' ? '질서 별 전용 계수' : '해·달 같은 계수') : '종류별 계수';
    return `<div class="card core${c.enabled ? '' : ' off'}"><div class="core-head"><b>${c.family} ${c.slot}</b>` +
      `<label class="check"><input type="checkbox" data-i="${i}" data-f="enabled"${c.enabled ? ' checked' : ''}> 장착</label></div>${nameSel}${gradeSel}<span class="meta">${meta}</span></div>`;
  }).join('');
  const weaponOn = state.cores.some((c) => c.enabled && c.family === '혼돈' && c.name === '무기');
  $('weapon').hidden = !weaponOn;
  const on = state.cores.filter((c) => c.enabled);
  $('cores-sum').textContent = `장착 ${on.length}개 · 질서 ${on.filter((c) => c.family === '질서').length} / 혼돈 ${on.filter((c) => c.family === '혼돈').length}`;
}
$('cores').addEventListener('change', (e) => {
  const el = e.target, i = Number(el.dataset.i), f = el.dataset.f;
  if (!f) return;
  state.cores[i][f] = f === 'enabled' ? el.checked : el.value;
  renderCores(); changed();
});
const WEAPON_FIELDS = [
  ['F', '무기 공격력 고정값 합 (장비)', 1], ['pPct', '무기 공격력 % 합 (장비 + 깨달음 카르마 레벨×0.1)', 0.01],
  ['c', '완갑 기본 공격력 (고정값)', 1], ['baseAtk', '기본 공격력 (캐릭터 정보 공격력 툴팁)', 1], ['basePct', '기본 공격력 % 합 (완갑·스톤·보석)', 0.01],
];
function renderWeapon() {
  $('weapon-grid').innerHTML = WEAPON_FIELDS.map(([k, label, step]) =>
    `<label>${label}<input class="nin" type="number" step="${step}" data-k="${k}" value="${state.weapon[k]}"></label>`).join('');
}
$('weapon-grid').addEventListener('change', (e) => {
  const k = e.target.dataset.k; if (!k) return;
  const v = Number(e.target.value);
  if (Number.isFinite(v) && v >= 0) { state.weapon[k] = v; changed(); } else e.target.value = state.weapon[k];
});

// ---- 1-1. 캐릭터 불러오기: 무기 코어 값만 (혼돈 별 = 무기일 때만 보임). 서버 /api/character → 공식 API 대리 호출 ----
$('char-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('char-name').value.trim(), msg = $('char-msg');
  if (!name) { msg.textContent = '캐릭터 이름을 넣어 주세요.'; return; }
  $('char-go').disabled = true;
  msg.textContent = '불러오는 중… (서버가 잠들어 있었다면 처음 한 번은 30초쯤 걸릴 수 있습니다)';
  try {
    const res = await fetch('api/character', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data?.error || (res.status === 404 || res.status === 405 ? '이 주소에서는 캐릭터 불러오기를 쓸 수 없습니다.' : `오류 ${res.status}`));
    if (!data.weapon) throw new Error(`무기 코어 값을 읽지 못했습니다 (${data.weaponError || '알 수 없음'}). 직접 넣어 주세요.`);
    state.weapon = { F: data.weapon.F, pPct: data.weapon.pPct, c: data.weapon.c, baseAtk: data.weapon.baseAtk, basePct: data.weapon.basePct };
    renderWeapon(); changed();
    const p = data.profile;
    msg.innerHTML = '';
    const b = document.createElement('b'); b.textContent = `${p.name} (${p.server} · ${p.className})`;
    msg.append(b, ' 값을 채웠습니다.');
    if (!data.cores.some((c) => c.family === '혼돈' && c.slot === '별' && c.name === '무기')) msg.append(' 참고: 이 캐릭터는 지금 혼돈 별에 무기 코어를 끼고 있지 않습니다.');
    toast('무기 코어 값을 불러왔습니다');
  } catch (err) {
    msg.textContent = `불러오지 못했습니다: ${err.message}`;
  } finally {
    $('char-go').disabled = false;
  }
});

// ---- 2. 젬 ----
const results = createResults({
  table: $('tbl'), fchips: $('fchips'), onlyChanged: $('only-changed'), more: $('more'), diff: $('diff'),
  placement: $('placement'), sub: $('result-sub'), tip: $('tip'),
}, { onEdit: (id) => editor.focusGem(id) });

const editor = createEditor({
  table: $('editor'),
  getGems: () => state.gems,
  setGems: (g) => { state.gems = g; },
  onChange: () => changed(),
  reveal: () => { $('gem-list').open = true; },
  famFilter: () => state.famFilter,
  resetFam: () => { state.famFilter = 'all'; renderGemFam(); },
});
function renderGemFam() { document.querySelectorAll('#gem-fam button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === state.famFilter))); }
document.querySelectorAll('#gem-fam button').forEach((b) => b.addEventListener('click', () => { state.famFilter = b.dataset.f; renderGemFam(); editor.render(); }));

function renderGemSummary() {
  const n = state.gems.length;
  const bad = state.gems.filter((g) => validateGem(g).length).length;
  const fam = (f) => state.gems.filter((g) => GEM_TYPES[g.type]?.family === f).length;
  $('gem-count').textContent = `${n}개`;
  $('gems-sum').innerHTML = `질서 ${fam('질서')} · 혼돈 ${fam('혼돈')} · 잠금 ${state.gems.filter((g) => g.locked).length}` +
    (bad ? ` · <span class="err">입력 오류 ${bad}줄</span>` : '') + (state.example ? ' · <b>예시 데이터</b>(장착 24개는 실제, 나머지 76개는 가상)' : '') + (n > 100 ? ' · <span class="err">젬 탭 한도 100개 초과</span>' : '');
  $('gems-empty').hidden = n > 0;
  $('gem-list-sub').textContent = n ? `${n}개 · 펼쳐서 고치거나, 새로 깎은 젬을 젬 추가로 넣으세요` : '비어 있음';
}

$('add-gem').addEventListener('click', () => {
  const last = state.gems[state.gems.length - 1];
  const g = blankGem(last?.type ?? '안정');
  state.gems.push(g);
  $('gem-list').open = true;
  editor.render(); changed();
  editor.focusGem(g.id);
});
$('clear-btn').addEventListener('click', () => {
  if ($('clear-btn').dataset.armed !== '1') {
    $('clear-btn').dataset.armed = '1'; $('clear-btn').textContent = '정말 모두 지우기';
    setTimeout(() => { $('clear-btn').dataset.armed = ''; $('clear-btn').textContent = '모두 지우기'; }, 3000);
    return;
  }
  state.gems = []; state.example = false; $('clear-btn').dataset.armed = ''; $('clear-btn').textContent = '모두 지우기';
  editor.render(); changed(); toast('젬 목록을 비웠습니다');
});
async function loadExample() {
  const res = await fetch('examples/demo_input.json');
  if (!res.ok) throw new Error('예시 파일을 못 읽음');
  const ex = await res.json();
  state.gems = ex.gems.map(fromEngineGem);
  state.cores = state.cores.map((c) => {
    const m = ex.cores.find((x) => x.family === c.family && x.slot === c.slot);
    return m ? { ...c, name: c.family === '혼돈' ? m.name : m.name, grade: m.grade, enabled: true } : c;
  });
  state.example = true;
}
$('example-btn').addEventListener('click', async () => {
  try { await loadExample(); renderCores(); editor.render(); changed(); toast('예시 젬 100개를 불러왔습니다'); }
  catch (e) { toast(`예시를 불러오지 못했습니다: ${e.message}`); }
});
// ---- 화면 인식 ----
$('rec-collapse').addEventListener('click', () => {
  const body = $('rec-body'), open = body.hidden;
  body.hidden = !open;
  $('rec-collapse').setAttribute('aria-expanded', String(open));
  $('rec-collapse').textContent = open ? '접기' : '펴기';
});
createCapture({
  start: $('rec-start'), stop: $('rec-stop'), files: $('rec-files'), status: $('rec-status'), tol: $('rec-tol'),
  viewBtn: $('rec-view-btn'), view: $('rec-view'), canvas: $('rec-canvas'), viewNote: $('rec-view-note'),
  tabs: $('rec-tabs'), cover: $('rec-cover'), table: $('rec-table'), empty: $('rec-empty'), notes: $('rec-notes'), total: $('rec-total'),
  apply: $('rec-apply'), reset: $('rec-reset'),
}, {
  // '확인'을 눌러야 들어옴: 보유 젬 목록을 인식 결과로 바꿈 (계산은 3. 계산의 버튼으로만)
  onApply: (gems) => {
    state.gems = gems.map((g) => ({ ...g, id: g.id || blankGem().id }));
    state.example = false;
    $('gem-list').open = false;
    editor.render(); changed();
    toast(`젬 ${gems.length}개를 보유 젬 목록에 반영했습니다. 아래 계산을 누르세요`);
  },
});

// ---- 3. 계산 ----
const nIn = $('n-in'), kIn = $('k-in'), itIn = $('it-in');
function renderSettings() {
  nIn.value = state.settings.N; kIn.value = state.settings.k; itIn.value = String(state.settings.iterations);
  document.querySelectorAll('#seg-g button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.g === state.grade)));
}
document.querySelectorAll('#seg-g button').forEach((b) => b.addEventListener('click', () => { state.grade = b.dataset.g; renderSettings(); changed(); }));
for (const [el, key, lo, hi] of [[nIn, 'N', 1, 300], [kIn, 'k', 1, 100]]) {
  el.addEventListener('change', () => {
    const v = Math.round(Number(el.value));
    if (Number.isFinite(v) && v >= lo && v <= hi) state.settings[key] = v; else el.value = state.settings[key];
    changed();
  });
}
itIn.addEventListener('change', () => { state.settings.iterations = Number(itIn.value); changed(); });

function engineInput() {
  const input = toEngineInput(state);
  input.settings.gradeDist = { [state.grade]: 1 };
  return input;
}
const inputKey = () => JSON.stringify(engineInput());
const isStale = () => !!state.last && state.last.key !== inputKey();
const gemSig = (g) => `${g.type}|${g.will}|${g.points}|${g.e1}${g.l1}|${g.e2}${g.l2}|${g.locked ? 1 : 0}`;

function inputProblems() {
  const p = [];
  if (!state.gems.length) p.push('젬이 없습니다');
  const bad = state.gems.filter((g) => validateGem(g).length).length;
  if (bad) p.push(`입력 오류가 있는 젬 ${bad}줄을 고치세요`);
  if (!state.cores.some((c) => c.enabled)) p.push('장착한 코어가 없습니다');
  return p;
}

let controller = null;
async function run() {
  const problems = inputProblems();
  if (problems.length) { $('status').innerHTML = `<span class="err">${problems.join(' · ')}</span>`; return; }
  const input = engineInput();
  const key = JSON.stringify(input);
  controller = new AbortController();
  $('run').disabled = true; $('cancel').hidden = false; document.body.classList.add('busy');
  $('status').innerHTML = '<span class="prog"><i id="pbar"></i></span><span id="ptext">준비 중 (가공 정책 계산)</span>';
  const t0 = performance.now();
  try {
    const result = await evaluateInBrowser(input, {
      signal: controller.signal,
      onProgress: (d, t) => { $('pbar').style.width = `${(d / t) * 100}%`; $('ptext').textContent = `시뮬레이션 ${d}/${t}`; },
    });
    const meta = { grade: state.grade, N: state.settings.N, iterations: state.settings.iterations, seconds: (performance.now() - t0) / 1000 };
    state.prev = state.last;
    state.last = { result, meta, key, sig: state.gems.map((g) => [g.id, gemSig(g)]) };
    persist();
    $('status').textContent = `계산 완료 · ${meta.seconds.toFixed(1)}초`;
    showResults();
    $('result-sec').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  } catch (err) {
    $('status').innerHTML = err.name === 'AbortError' ? '계산을 취소했습니다.' : `<span class="err">계산 실패: ${err.message}</span>`;
  } finally {
    $('run').disabled = false; $('cancel').hidden = true; controller = null; document.body.classList.remove('busy');
  }
}
$('run').addEventListener('click', run);
$('cancel').addEventListener('click', () => controller && controller.abort());

function showResults() {
  if (!state.last) { $('result-sec').hidden = true; return; }
  $('result-sec').hidden = false;
  const numbers = new Map(state.gems.map((g, i) => [g.id, i + 1]));
  const asRun = (r) => r && { ...r, sig: new Map(r.sig) };
  results.show(asRun(state.last), asRun(state.prev), numbers);
  editor.render();
  updateStale();
}
function updateStale() { $('stale').hidden = !isStale(); }

function changed() {
  renderGemSummary();
  updateStale();
  persist();
}

// ---- 시작 ----
(async function init() {
  if (!saved) {
    // 처음 열면 예시로 채워서 무엇을 하는 도구인지 바로 보이게 함 (예시 표시)
    try { await loadExample(); } catch (e) { /* 예시 없이 시작 */ }
  }
  renderCores(); renderWeapon(); renderSettings(); renderGemFam(); editor.render(); renderGemSummary();
  showResults();
  persist();
})();
