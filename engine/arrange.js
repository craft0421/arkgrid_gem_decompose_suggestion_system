// 계열 하나(질서 또는 혼돈)의 최적 젬 배치 (PLAN.md 3-4)
// 목표: Σ_코어 ln(1 + 코어%/100) + Σ_젬 효과가치/100 최대화
//  - 코어마다 젬 ≤ 4개, 필요 의지력 합 ≤ 코어 공급 의지력
//  - 젬 효과는 원래 전체 레벨합에 floor를 취해 곱하지만, 젬 하나의 효과가 작아 배치 비교에는 선형 근사를 쓴다
//    (최종 전투력은 cp.placementMultiplier로 정확히 다시 계산)
// 구현: 4개 이하 부분집합을 타입 배열로 열거 → 코어별 가치 정렬 → 겹치지 않게 분기 한정 탐색.
//       부분집합의 젬 구성은 96비트 마스크(Int32 ×3)로 겹침 검사.
import { undominatedIndices } from './dominance.js';

const MAX_PER_CORE = 4;
const MAX_CAND = 96;
const EPS = 1e-13;

function coreLogValue(core, pts) { return Math.log1p(core.pct(pts) / 100); }

/**
 * cores: makeCore 결과 배열 (같은 계열), gems: makeGem 결과 배열 (같은 계열)
 * 옵션 bias(g): 동점일 때 덜 선호할수록 큰 값 (예: 미래 젬에 1e-9) — 보유 젬을 우선 쓰게 함
 * 반환: { value, assign: [[gem 인덱스...] per core] }
 */
export function bestArrangement(cores, gems, opts = {}) {
  const K = cores.length;
  if (!K) return { value: 0, assign: [] };
  // 같은 코어(공급 의지력·포인트별 가치가 모두 같음)는 서로 바꿔도 값이 같으므로 뒤쪽에 붙여 대칭을 제거한다
  const sig = cores.map((c) => `${c.will}|${Array.from({ length: 21 }, (_, p) => coreLogValue(c, p)).join(',')}`);
  const order = cores.map((_, k) => k).sort((a, b) => {
    const ca = sig.filter((s) => s === sig[a]).length, cb = sig.filter((s) => s === sig[b]).length;
    return ca - cb || (sig[a] < sig[b] ? -1 : sig[a] > sig[b] ? 1 : a - b);
  });
  const res = solve(order.map((k) => cores[k]), gems, opts, order.map((k) => sig[k]));
  const assign = new Array(K);
  order.forEach((k, pos) => { assign[k] = res.assign[pos]; });
  return { value: res.value, assign };
}

function solve(cores, gems, { bias = () => 0, prefilter = true } = {}, sig) {
  const K = cores.length;
  const limit = K * MAX_PER_CORE;
  let cand = prefilter ? undominatedIndices(gems, limit) : gems.map((_, i) => i);
  if (cand.length > MAX_CAND) throw new Error(`배치 후보 젬이 너무 많음 (${cand.length} > ${MAX_CAND})`);
  const n = cand.length;
  const W = new Int32Array(n), P = new Int32Array(n), E = new Float64Array(n);
  cand.forEach((gi, j) => { W[j] = gems[gi].will; P[j] = gems[gi].points; E[j] = gems[gi].eff / 100 - bias(gems[gi]); });
  const maxBudget = Math.max(...cores.map((c) => c.will));
  // 코어별 포인트→가치 표 (포인트 0~20)
  const CV = cores.map((c) => Float64Array.from({ length: 21 }, (_, p) => coreLogValue(c, p)));

  // 크기 0~4 부분집합 열거
  let cap = 1 + n + (n * (n - 1)) / 2 + (n * (n - 1) * (n - 2)) / 6 + (n * (n - 1) * (n - 2) * (n - 3)) / 24;
  const sW = new Int32Array(cap), sP = new Int32Array(cap), sE = new Float64Array(cap);
  const m0 = new Int32Array(cap), m1 = new Int32Array(cap), m2 = new Int32Array(cap);
  const mem = new Int32Array(cap * 4).fill(-1);
  let S = 0;
  const bit = (j, word) => ((j >> 5) === word ? 1 << (j & 31) : 0);
  const add = (w, p, e, a, b, c, d) => {
    sW[S] = w; sP[S] = p; sE[S] = e;
    let x0 = 0, x1 = 0, x2 = 0;
    for (const j of [a, b, c, d]) if (j >= 0) { x0 |= bit(j, 0); x1 |= bit(j, 1); x2 |= bit(j, 2); }
    m0[S] = x0; m1[S] = x1; m2[S] = x2;
    mem[S * 4] = a; mem[S * 4 + 1] = b; mem[S * 4 + 2] = c; mem[S * 4 + 3] = d;
    S++;
  };
  add(0, 0, 0, -1, -1, -1, -1);
  for (let a = 0; a < n; a++) {
    const wa = W[a]; if (wa > maxBudget) continue;
    add(wa, P[a], E[a], a, -1, -1, -1);
    for (let b = a + 1; b < n; b++) {
      const wb = wa + W[b]; if (wb > maxBudget) continue;
      const pb = P[a] + P[b], eb = E[a] + E[b];
      add(wb, pb, eb, a, b, -1, -1);
      for (let c = b + 1; c < n; c++) {
        const wc = wb + W[c]; if (wc > maxBudget) continue;
        const pc = pb + P[c], ec = eb + E[c];
        add(wc, pc, ec, a, b, c, -1);
        for (let d = c + 1; d < n; d++) {
          const wd = wc + W[d]; if (wd > maxBudget) continue;
          add(wd, pc + P[d], ec + E[d], a, b, c, d);
        }
      }
    }
  }

  // 코어별 가치
  const vals = cores.map((core, k) => {
    const v = new Float64Array(S);
    const cv = CV[k];
    for (let s = 0; s < S; s++) v[s] = sW[s] > core.will ? -Infinity : cv[sP[s] > 20 ? 20 : sP[s]] + sE[s];
    return v;
  });

  let u0 = 0, u1 = 0, u2 = 0;
  const free = (s) => ((m0[s] & u0) | (m1[s] & u1) | (m2[s] & u2)) === 0;
  const take = (s) => { u0 |= m0[s]; u1 |= m1[s]; u2 |= m2[s]; };
  const drop = (s) => { u0 &= ~m0[s]; u1 &= ~m1[s]; u2 &= ~m2[s]; };

  // 하한: 코어 순서대로 겹치지 않게 최선 선택
  let lb = 0;
  for (let k = 0; k < K; k++) {
    let best = -Infinity, bs = 0;
    const v = vals[k];
    for (let s = 0; s < S; s++) if (v[s] > best && free(s)) { best = v[s]; bs = s; }
    lb += best; take(bs);
  }
  u0 = u1 = u2 = 0;
  const maxV = vals.map((v) => { let m = -Infinity; for (let s = 0; s < S; s++) if (v[s] > m) m = v[s]; return m; });
  const sumMax = maxV.reduce((t, x) => t + x, 0);

  // 하한으로 가지치기 후 내림차순 정렬. 탐색 중 캐시 효율을 위해 정렬 순서대로 마스크·가치를 복사해 둠
  const lists = vals.map((v, k) => {
    const need = lb - (sumMax - maxV[k]) - 1e-12;
    const ids = [];
    for (let s = 0; s < S; s++) if (v[s] >= need) ids.push(s);
    ids.sort((x, y) => v[y] - v[x] || x - y);
    const L = ids.length;
    const a0 = new Int32Array(L), a1 = new Int32Array(L), a2 = new Int32Array(L), av = new Float64Array(L);
    for (let i = 0; i < L; i++) { const s = ids[i]; a0[i] = m0[s]; a1[i] = m1[s]; a2[i] = m2[s]; av[i] = v[s]; }
    return { ids, a0, a1, a2, av, L };
  });
  // 바로 앞 코어와 같은 코어면 목록도 같으므로 위치가 앞 코어 선택 이상인 것만 본다 (대칭 제거)
  const sameAsPrev = sig.map((s, k) => k > 0 && s === sig[k - 1]);

  // 남은 코어 j의 상한: 지금 비어 있는 젬만으로 만들 수 있는 최선 (남은 코어끼리의 겹침만 무시)
  const bestFree = (j) => {
    const { a0, a1, a2, av, L } = lists[j];
    for (let i = 0; i < L; i++) if (((a0[i] & u0) | (a1[i] & u1) | (a2[i] & u2)) === 0) return av[i];
    return -Infinity;
  };
  const restFree = (fromK) => {
    let t = 0;
    for (let j = fromK; j < K; j++) t += bestFree(j);
    return t;
  };

  let bestVal = -Infinity;
  const pick = new Int32Array(K), bestPick = new Int32Array(K), pos = new Int32Array(K);
  const dfs = (k, cur) => {
    const { a0, a1, a2, av, L } = lists[k];
    const last = k === K - 1;
    const R = last ? 0 : restFree(k + 1); // 부모 상태 기준 상한 (s를 더 고르면 줄어들기만 함)
    for (let i = sameAsPrev[k] ? pos[k - 1] : 0; i < L; i++) {
      const val = cur + av[i];
      if (val + R <= bestVal + EPS) return;
      if (((a0[i] & u0) | (a1[i] & u1) | (a2[i] & u2)) !== 0) continue;
      pick[k] = lists[k].ids[i]; pos[k] = i;
      if (last) {
        bestVal = val; bestPick.set(pick);
        return; // 마지막 코어: 처음 가능한 것이 최선
      }
      u0 |= a0[i]; u1 |= a1[i]; u2 |= a2[i];
      if (val + restFree(k + 1) > bestVal + EPS) dfs(k + 1, val);
      u0 &= ~a0[i]; u1 &= ~a1[i]; u2 &= ~a2[i];
    }
  };
  dfs(0, 0);

  const assign = [];
  for (let k = 0; k < K; k++) {
    const s = bestPick[k], out = [];
    for (let t = 0; t < 4; t++) { const j = mem[s * 4 + t]; if (j >= 0) out.push(cand[j]); }
    assign.push(out);
  }
  return { value: bestVal, assign };
}

/** 검증용 완전 탐색 (젬 8개 이하 권장): 각 젬을 미사용 또는 코어 k에 배정 */
export function bruteForceArrangement(cores, gems) {
  const n = gems.length, K = cores.length;
  let best = -Infinity, bestAssign = null;
  const slot = new Array(n).fill(-1);
  (function rec(i) {
    if (i === n) {
      let v = 0;
      const assign = cores.map(() => []);
      for (let j = 0; j < n; j++) if (slot[j] >= 0) assign[slot[j]].push(j);
      for (let k = 0; k < K; k++) {
        const g = assign[k];
        if (g.length > MAX_PER_CORE) return;
        const w = g.reduce((s, j) => s + gems[j].will, 0);
        if (w > cores[k].will) return;
        v += coreLogValue(cores[k], g.reduce((s, j) => s + gems[j].points, 0)) + g.reduce((s, j) => s + gems[j].eff / 100, 0);
      }
      if (v > best + 1e-15) { best = v; bestAssign = assign; }
      return;
    }
    for (let k = -1; k < K; k++) { slot[i] = k; rec(i + 1); }
  })(0);
  return { value: best, assign: bestAssign };
}
