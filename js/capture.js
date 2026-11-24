// 화면 인식 패널: 화면 공유(자동 캡처) 또는 캡처 파일 → 인식 → 오른쪽 목록에 실시간 표시 → 표에서 수정 → '확인'으로 반영·분석
//  - 공유 중에는 목록이 계속 갱신되므로 읽기 전용, 공유를 끝내면 수정 가능
//  - 브라우저 탭이 가려져(게임 창을 보는 중) 타이머가 느려지는 것을 피하려고 캡처 주기는 Worker 타이머로 줌
import { stitch } from './recognize.js';
import { GEM_TYPES, newId } from './model.js';
import { createEditor } from './editor.js';

const CAPTURE_MS = 350;
const TOP_THUMB = 59; // 스크롤 손잡이가 맨 위일 때 위치 (1080 기준, 원점 기준)
const rowKey = (g) => `${g.type}|${g.will}|${g.points}|${g.e1}${g.l1}|${g.e2}${g.l2}|${g.equipped ? 1 : 0}`;

export function createCapture(els, { onApply }) {
  let worker = null, busy = false, seq = 0;
  const pending = new Map();
  let frames = [], rejected = 0, lowRes = false;
  let stream = null, video = null, ticker = null;
  const cap = document.createElement('canvas');
  const capCtx = cap.getContext('2d', { willReadFrequently: true });
  let lastFrame = null;  // 공유 화면 보기용 (마지막 인식 결과)
  let review = [];       // 오른쪽 목록 (편집기 젬)
  let tab = '질서';
  let edited = false;    // 인식 뒤 사용자가 표에서 고쳤는지
  let sum = null;

  // ---- 인식 Worker ----
  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./rec-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); busy = false; p?.(e.data); };
    worker.onerror = (e) => { busy = false; setStatus(`<span class="err">인식기 오류: ${e.message}</span>`); };
    return worker;
  }
  function recognize(imageData) {
    return new Promise((resolve) => {
      const id = ++seq; busy = true;
      pending.set(id, resolve);
      const buf = imageData.data.buffer;
      ensureWorker().postMessage({ id, width: imageData.width, height: imageData.height, buffer: buf, tol: Number(els.tol.value) || 1 }, [buf]);
    });
  }
  /** 새 화면이면 true */
  function addFrame(fr) {
    if (!fr.ok) { rejected++; return false; }
    if (!fr.rows.length) return false;
    if (fr.scale < 0.95) lowRes = true;
    const key = `${fr.family}|${fr.thumb}|${fr.rows.map(rowKey).join(',')}`;
    if (frames.some((f) => f.key === key)) return false;
    frames.push({ ...fr, key });
    return true;
  }

  // ---- 이어 붙이기 (계열별). 맨 위 화면이 장착 구성만 다른 여러 종류면, 첫 종류로 잇고 나머지에서 장착 젬만 더함 ----
  function summarize() {
    const out = {};
    for (const fam of ['질서', '혼돈']) {
      const fs = frames.filter((f) => f.family === fam);
      if (!fs.length) continue;
      const tops = fs.filter((f) => f.thumb != null && f.thumb <= TOP_THUMB + 1);
      const eqKey = (f) => f.rows.filter((g) => g.equipped).map(rowKey).join(',');
      const mainKey = tops.length ? eqKey(tops[0]) : null;
      const main = fs.filter((f) => !(tops.includes(f) && eqKey(f) !== mainKey));
      const seen = new Set(), extra = [];
      for (const f of tops.filter((f) => eqKey(f) !== mainKey)) {
        const k = eqKey(f); if (seen.has(k)) continue; seen.add(k);
        extra.push(...f.rows.filter((g) => g.equipped));
      }
      const s = stitch(main);
      out[fam] = { ...s, rows: [...s.rows, ...extra], extraEquipped: extra.length, frames: fs.length };
    }
    return out;
  }
  /** 인식한 줄 → 편집기 젬 (타입을 못 정한 줄도 후보 타입으로 넣고 확인 표시) */
  function toEditorGem(g, fam) {
    let type = g.type; const check = g.warn.slice();
    if (!type) {
      const fits = Object.entries(GEM_TYPES).filter(([, t]) => t.family === fam && t.pool.includes(g.e1) && t.pool.includes(g.e2)).map(([k]) => k);
      type = fits[0] ?? Object.keys(GEM_TYPES).find((k) => GEM_TYPES[k].family === fam);
      if (!check.some((c) => c.startsWith('타입'))) check.push('타입 확인 필요');
    }
    const pool = GEM_TYPES[type].pool;
    const e1 = pool.includes(g.e1) ? g.e1 : pool[0];
    const e2 = pool.includes(g.e2) && g.e2 !== e1 ? g.e2 : pool.find((x) => x !== e1);
    return { id: newId(), type, will: g.will, points: g.points, e1, l1: g.l1, e2, l2: g.l2, locked: false, check: check.length ? check.join(', ') : null };
  }

  // ---- 오른쪽 목록 (표에서 바로 수정) ----
  const editor = createEditor({
    table: els.table, getGems: () => review, setGems: (g) => { review = g; },
    onChange: () => { edited = true; renderCounts(); },
    resultFor: () => null, famFilter: () => tab, resetFam: () => {},
  });
  const famOf = (g) => GEM_TYPES[g.type]?.family;
  function renderCounts() {
    const n = (f) => review.filter((g) => famOf(g) === f).length;
    const w = (f) => review.filter((g) => famOf(g) === f && g.check).length;
    els.tabs.querySelectorAll('button[data-f]').forEach((b) => {
      const f = b.dataset.f;
      b.setAttribute('aria-pressed', String(f === tab));
      b.innerHTML = `${f} <span class="n">${n(f)}</span>${w(f) ? ` <span class="warn-dot" title="확인이 필요한 줄 ${w(f)}개">${w(f)}</span>` : ''}`;
    });
    els.total.innerHTML = `인식한 젬 <b class="num">${review.length}</b> / 100 <span class="sub">(질서 ${n('질서')}개, 혼돈 ${n('혼돈')}개)</span>`;
    const warns = review.filter((g) => g.check).length;
    const notes = [];
    if (warns) notes.push(`<span class="err">확인이 필요한 줄 ${warns}개</span>(노란 줄) — 틀린 값은 표에서 고치세요`);
    if (sum) for (const f of ['질서', '혼돈']) {
      const s = sum[f]; if (!s) continue;
      if (s.extraEquipped) notes.push(`${f}: 다른 코어 장착 젬 ${s.extraEquipped}개 포함`);
      if (s.gaps.length) notes.push(`<span class="err">${f}: 스크롤을 너무 많이 내려 ${s.gaps.reduce((a, g) => a + g.missing, 0)}줄을 놓쳤습니다 — 그 부분을 다시 보여 주세요</span>`);
      if (!s.consistent) notes.push(`<span class="err">${f}: 화면 순서를 확실히 맞추지 못했습니다 — 개수를 게임 보유 수량과 비교하세요</span>`);
    }
    els.notes.innerHTML = notes.join('<br>');
    els.apply.disabled = !review.length || !!stream;
    els.empty.hidden = review.length > 0;
    els.table.closest('.rec-list').hidden = review.length === 0;
  }
  function renderList() {
    els.table.closest('.rec-list').classList.toggle('readonly', !!stream);
    els.table.querySelectorAll('input, select, button').forEach((x) => { x.disabled = !!stream; });
    editor.render();
    els.table.querySelectorAll('input, select, button').forEach((x) => { x.disabled = !!stream; });
    renderCounts();
  }
  els.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    tab = b.dataset.f; renderList();
  });
  /** 인식 결과로 목록을 새로 만듦 (사용자가 고친 내용은 사라짐) */
  function rebuild() {
    sum = summarize();
    review = ['질서', '혼돈'].flatMap((f) => (sum[f] ? sum[f].rows.map((g) => toEditorGem(g, f)) : []));
    edited = false;
    if (review.length && !review.some((g) => famOf(g) === tab)) tab = famOf(review[0]);
    renderList();
  }

  function setStatus(html) { els.status.innerHTML = html; }
  function extraStatus() {
    const extra = [];
    if (rejected) extra.push(`젬 목록이 아닌 화면 ${rejected}장 건너뜀`);
    if (lowRes) extra.push('<span class="err">해상도가 낮아 오인식이 많을 수 있음(1920×1080 이상 권장)</span>');
    return extra.length ? ` · ${extra.join(' · ')}` : '';
  }

  // ---- 공유 화면 보기: 마지막 캡처 위에 읽는 영역 표시 ----
  function drawView() {
    if (els.view.hidden) return;
    if (!lastFrame || !cap.width) { els.viewNote.textContent = '아직 캡처한 화면이 없습니다. 화면 공유를 시작하세요.'; return; }
    const cv = els.canvas, w = Math.max(240, Math.min(els.view.clientWidth || 480, 900));
    cv.width = w; cv.height = Math.round(w * cap.height / cap.width);
    const ctx = cv.getContext('2d');
    ctx.drawImage(cap, 0, 0, cv.width, cv.height);
    const fr = lastFrame;
    if (!fr.ok || !fr.anchor) {
      els.viewNote.innerHTML = '<span class="err">젬 목록을 찾지 못했습니다.</span> 아크 그리드 → 젬 탭이 보이는지, 해상도가 1920×1080 이상인지 확인하세요.';
      return;
    }
    const s = fr.scale * (cv.width / cap.width), ax = fr.anchor.x, ay = fr.anchor.y;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2a78d6';
    ctx.strokeRect(ax * s, ay * s, 428 * s, 32 * s);
    fr.rows.forEach((g, r) => {
      ctx.strokeStyle = g.warn.length ? '#e0a100' : '#1b9e5a';
      ctx.strokeRect((ax - 4) * s, (ay + 56 + 63 * r - 9) * s, 404 * s, 56 * s);
    });
    els.viewNote.textContent = `${fr.family ?? ''} 목록 ${fr.rows.length}줄 읽음 · 파란 상자 = 기준 위치, 초록 = 읽음, 노랑 = 확인 필요. 상자가 젬 줄과 어긋나면 해상도·창 모드를 확인하세요.`;
  }
  els.viewBtn.addEventListener('click', () => {
    els.view.hidden = !els.view.hidden;
    els.viewBtn.setAttribute('aria-pressed', String(!els.view.hidden));
    drawView();
  });

  // ---- 화면 공유 ----
  let restartArmed = false;
  async function startShare() {
    if (!navigator.mediaDevices?.getDisplayMedia) { setStatus('<span class="err">이 브라우저는 화면 공유를 지원하지 않습니다. PC의 크롬·엣지를 쓰거나 캡처 파일 넣기를 쓰세요.</span>'); return; }
    if (edited && !restartArmed) {
      restartArmed = true;
      setStatus('<span class="err">표에서 고친 내용은 새 인식 결과가 들어오면 사라집니다.</span> 먼저 <b>확인</b>으로 반영하거나, 그래도 시작하려면 한 번 더 누르세요.');
      return;
    }
    restartArmed = false;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    } catch (err) {
      stream = null;
      setStatus(err.name === 'NotAllowedError' ? '화면 공유를 취소했습니다.' : `<span class="err">화면 공유 실패: ${err.message}</span>`); return;
    }
    video = document.createElement('video');
    video.srcObject = stream; video.muted = true; video.playsInline = true; await video.play();
    stream.getVideoTracks()[0].addEventListener('ended', stopShare);
    els.start.hidden = true; els.stop.hidden = false;
    renderList();
    setStatus('공유 중 — 게임에서 젬 목록을 맨 위부터 천천히 끝까지 스크롤하세요. 질서와 혼돈을 모두 보여 주세요.');
    // 가려진 탭에서도 느려지지 않는 Worker 타이머로 캡처 주기를 줌
    const src = `setInterval(() => postMessage(0), ${CAPTURE_MS});`;
    ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    ticker.onmessage = tick;
  }
  async function tick() {
    if (busy || !video?.videoWidth) return;
    cap.width = video.videoWidth; cap.height = video.videoHeight;
    capCtx.drawImage(video, 0, 0);
    const res = await recognize(capCtx.getImageData(0, 0, cap.width, cap.height));
    if (!stream) return;
    if (!res.ok) { setStatus(`<span class="err">인식 오류: ${res.message}</span>`); return; }
    lastFrame = res.frame;
    if (addFrame(res.frame)) rebuild();
    drawView();
    setStatus(`공유 중 — 스크롤하며 질서·혼돈 목록을 끝까지 보여 주세요. 끝나면 <b>공유 끝내기</b>${extraStatus()}`);
  }
  function stopShare() {
    ticker?.terminate(); ticker = null;
    stream?.getTracks().forEach((t) => t.stop()); stream = null; video = null;
    els.start.hidden = false; els.stop.hidden = true;
    renderList();
    setStatus(review.length ? `공유를 끝냈습니다. 목록을 확인하고 틀린 값은 표에서 고친 뒤 <b>확인</b>을 누르세요${extraStatus()}` : `인식한 젬이 없습니다. 아크 그리드 → 젬 탭이 보이는지 확인하세요${extraStatus()}`);
  }

  // ---- 캡처 파일 ----
  async function readFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    for (let i = 0; i < list.length; i++) {
      setStatus(`캡처 파일 읽는 중 ${i + 1}/${list.length}`);
      const bmp = await createImageBitmap(list[i]);
      cap.width = bmp.width; cap.height = bmp.height;
      capCtx.drawImage(bmp, 0, 0); bmp.close?.();
      const res = await recognize(capCtx.getImageData(0, 0, cap.width, cap.height));
      if (res.ok) { lastFrame = res.frame; addFrame(res.frame); } else setStatus(`<span class="err">${list[i].name}: ${res.message}</span>`);
    }
    rebuild(); drawView();
    setStatus(`캡처 ${list.length}장을 읽었습니다. 목록을 확인하고 틀린 값은 표에서 고친 뒤 <b>확인</b>을 누르세요${extraStatus()}`);
  }

  // ---- 반영 / 초기화 ----
  els.apply.addEventListener('click', () => {
    if (!review.length || stream) return;
    onApply(review.map(({ check, ...g }) => g));
    edited = false;
    setStatus(`젬 ${review.length}개를 보유 젬 목록에 반영하고 분석을 시작했습니다.`);
  });
  els.reset.addEventListener('click', () => {
    if (els.reset.dataset.armed !== '1') {
      els.reset.dataset.armed = '1'; els.reset.textContent = '정말 초기화';
      setTimeout(() => { els.reset.dataset.armed = ''; els.reset.textContent = '초기화'; }, 3000);
      return;
    }
    els.reset.dataset.armed = ''; els.reset.textContent = '초기화';
    frames = []; rejected = 0; lowRes = false; review = []; edited = false; lastFrame = null; sum = null;
    renderList(); drawView();
    setStatus('인식 결과를 지웠습니다.');
  });
  els.start.addEventListener('click', startShare);
  els.stop.addEventListener('click', stopShare);
  els.files.addEventListener('change', (e) => { readFiles(e.target.files); e.target.value = ''; });
  addEventListener('resize', drawView);
  renderList();
  return { readFiles };
}
