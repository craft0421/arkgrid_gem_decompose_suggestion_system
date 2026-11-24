// 젬 분해 판정 파이프라인 (PLAN.md 3-2, 3-3) — 딜러 기준
//  1단계 지배 필터 → 2단계 현재 최적 배치 → 3단계 미래 젬 몬테카를로
//  prepare → runMonteCarlo(여러 워커로 나눠 돌릴 수 있음) → finalize
import { FAMILIES, TYPES_BY_FAMILY } from './data.js';
import { makeCore, placementMultiplier } from './cp.js';
import { makeGem, gemLabel } from './gem.js';
import { dominatorCounts } from './dominance.js';
import { bestArrangement } from './arrange.js';
import { getPolicy, simulateGem } from './processing.js';
import { makeRng } from './rng.js';

export const DEFAULT_SETTINGS = {
  role: '딜러',             // '딜러' | '서폿' (서폿은 E3 계수 확정 전까지 미지원)
  k: 10,                    // 확보할 공간 (추천 개수)
  N: 30,                    // 앞으로 깎을 젬 수
  iterations: 200,          // 몬테카를로 반복 수
  orderShare: 0.5,          // 미래 젬 중 질서 비율 (나머지 혼돈)
  gradeDist: { 영웅: 1 },   // 미래 젬 가공 등급 분포
  utilityA: 0.3,            // 가공 정책 목표값 u의 효율·포인트 가중치 (processing.makeUtility)
  useThreshold: 0.03,       // 쓰일 확률의 95% 상한(보수적 값)이 이 값 미만이면 '분해 권장' (100회 중 0번, 200회 중 1번 이하, 400회 중 5번 이하)
  dominanceMode: 'scalar',  // 'scalar' | 'vector'
  seed: 12345,
};

const SLOTS_PER_CORE = 4;
const NEW_GEM_BIAS = 1e-9; // 동점이면 보유 젬을 우선 사용

/** 1·2단계. withDelta=false면 현재 사용 젬의 기여도 계산을 건너뜀 (워커용) */
export function prepare(input, { withDelta = true } = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  if (s.role !== '딜러') throw new Error(`역할 '${s.role}'은 아직 지원하지 않음 (서포터 계수 측정 후 추가 예정)`);
  const warnings = [];
  const cores = input.cores.map((c) => makeCore(c));
  for (const c of cores) warnings.push(...c.warnings);
  const gems = input.gems.map((g, i) => makeGem({ ...g, source: 'held' }, i));

  const byFam = {};
  for (const f of FAMILIES) {
    byFam[f] = {
      cores: cores.filter((c) => c.family === f),
      idx: gems.map((g, i) => i).filter((i) => gems[i].family === f && !gems[i].locked),
    };
    if (byFam[f].cores.length > 3) throw new Error(`${f} 코어는 최대 3개`);
  }

  // ---- 1단계: 지배 필터 ----
  const domCount = new Array(gems.length).fill(0);
  const safe = new Array(gems.length).fill(false);
  for (const f of FAMILIES) {
    const { cores: fc, idx } = byFam[f];
    const cnt = dominatorCounts(idx.map((i) => gems[i]), s.dominanceMode);
    const limit = fc.length * SLOTS_PER_CORE;
    idx.forEach((gi, j) => {
      domCount[gi] = cnt[j];
      if (fc.length && cnt[j] >= limit) safe[gi] = true;
    });
  }

  // ---- 2단계: 현재 최적 배치 ----
  const placement = [];
  const usedNow = new Array(gems.length).fill(false);
  const famArr = {};
  for (const f of FAMILIES) {
    const { cores: fc, idx } = byFam[f];
    const candIdx = idx.filter((i) => !safe[i]);
    const arr = bestArrangement(fc, candIdx.map((i) => gems[i]));
    famArr[f] = arr.assign.map((a) => a.map((j) => candIdx[j]));
    fc.forEach((core, k) => {
      const gi = famArr[f][k];
      gi.forEach((i) => { usedNow[i] = true; });
      placement.push({ core, gems: gi.map((i) => gems[i]), gemIdx: gi });
    });
  }
  const multNow = placementMultiplier(placement);

  // 가공 정책표 미리 계산 (병렬 실행 시 워커에 그대로 넘김)
  for (const t of [...TYPES_BY_FAMILY.질서, ...TYPES_BY_FAMILY.혼돈]) getPolicy(t, { A: s.utilityA });

  // 현재 사용 젬의 기여도: 그 젬 없이 다시 최적 배치했을 때의 전투력 손실(%)
  const delta = new Array(gems.length).fill(0);
  if (withDelta) {
    for (const f of FAMILIES) {
      const { cores: fc, idx } = byFam[f];
      const others = placement.filter((p) => p.core.family !== f);
      for (const gi of famArr[f].flat()) {
        const candIdx = idx.filter((i) => !safe[i] && i !== gi);
        const arr = bestArrangement(fc, candIdx.map((i) => gems[i]));
        const pl = others.concat(fc.map((core, k) => ({ core, gems: arr.assign[k].map((j) => gems[candIdx[j]]) })));
        delta[gi] = 100 * (multNow / placementMultiplier(pl) - 1);
      }
    }
  }
  return { s, warnings, cores, gems, byFam, domCount, safe, placement, usedNow, multNow, delta };
}

export const BATCH_SIZE = 2;
export const batchSeed = (seed, b) => (seed + Math.imul(b + 1, 0x9e3779b1)) >>> 0;

/**
 * 3단계: 미래 젬 N개를 iterations번 생성해 보유 젬별 사용 횟수를 센다.
 * 반복은 BATCH_SIZE개씩 묶음 시드로 돌려서, 병렬(parallel.js)로 나눠 돌려도 결과가 같다.
 */
export function runMonteCarlo(ctx, iterations, seed = ctx.s.seed, onProgress) {
  const sum = new Array(ctx.gems.length).fill(0);
  for (let b = 0, done = 0; done < iterations; b++) {
    const n = Math.min(BATCH_SIZE, iterations - done);
    runBatch({ ...ctx, s: { ...ctx.s, seed } }, b, n).forEach((x, i) => { sum[i] += x; });
    done += n;
    if (onProgress) onProgress(done, iterations);
  }
  return sum;
}

/** 묶음 b (n회 반복) — 시드는 (설정 시드, 묶음 번호)로 결정 */
export function runBatch(ctx, b, iterations) {
  const { s, gems, byFam, safe } = ctx;
  const useCount = new Array(gems.length).fill(0);
  const rng = makeRng(batchSeed(s.seed, b));
  const grades = Object.entries(s.gradeDist).filter(([, w]) => w > 0);
  if (!grades.length) throw new Error('gradeDist가 비어 있음');
  const gradeTotal = grades.reduce((t, [, w]) => t + w, 0);
  const pickGrade = () => {
    let r = rng() * gradeTotal;
    for (const [g, w] of grades) { if ((r -= w) < 0) return g; }
    return grades[grades.length - 1][0];
  };
  const policyOpts = { A: s.utilityA };
  const simFams = FAMILIES.filter((f) => byFam[f].cores.length);
  const heldIdx = {};
  for (const f of simFams) heldIdx[f] = byFam[f].idx.filter((i) => !safe[i]);

  for (let it = 0; it < iterations; it++) {
    const fresh = { 질서: [], 혼돈: [] };
    for (let n = 0; n < s.N; n++) {
      const f = rng() < s.orderShare ? '질서' : '혼돈';
      const t = TYPES_BY_FAMILY[f][(rng() * 3) | 0];
      const g = simulateGem(t, pickGrade(), rng, getPolicy(t, policyOpts));
      fresh[f].push(makeGem({ ...g, source: 'new' }, `n${it}_${n}`));
    }
    for (const f of simFams) {
      const hi = heldIdx[f];
      const pool = hi.map((i) => gems[i]).concat(fresh[f]);
      const arr = bestArrangement(byFam[f].cores, pool, { bias: (g) => (g.source === 'new' ? NEW_GEM_BIAS : 0) });
      for (const j of arr.assign.flat()) if (j < hi.length) useCount[hi[j]]++;
    }
  }
  return useCount;
}

/**
 * 쓰일 확률의 보수적 값: n회 중 k회 쓰였을 때 95% 단측 신뢰 상한 (Clopper-Pearson).
 * 예: 200회 중 0회 → 1.5%, 100회 중 0회 → 3.0%. 시뮬레이션 횟수가 적을수록 크게 잡힘.
 */
export function upperBound95(k, n) {
  if (!n || k >= n) return 1;
  const cdf = (p) => { // P(X ≤ k), X ~ Bin(n, p)
    let term = Math.pow(1 - p, n), sum = term;
    for (let i = 1; i <= k; i++) { term *= ((n - i + 1) / i) * (p / (1 - p)); sum += term; }
    return sum;
  };
  let lo = k / n, hi = 1;
  for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (cdf(mid) > 0.05) lo = mid; else hi = mid; }
  return hi;
}

/** 판정·추천 정리 */
export function finalize(ctx, useCount, iterations) {
  const { s, warnings, gems, byFam, domCount, safe, placement, usedNow, multNow, delta } = ctx;
  const results = gems.map((g, i) => {
    const famCores = byFam[g.family].cores.length;
    const pUse = iterations ? useCount[i] / iterations : 0;
    // 화면에는 이 보수적 값을 씀. 분해 안전 젬은 시뮬레이션에서 빼므로(더 나은 젬이 칸 수 이상 → 증명상 0) 상한도 0
    const pHigh = safe[i] ? 0 : upperBound95(useCount[i], iterations);
    let category, reason;
    if (g.locked) { category = '잠금'; reason = '사용자가 잠금 (판정 제외)'; }
    else if (!famCores) { category = '보류'; reason = `${g.family} 코어가 없어 판정 불가`; }
    else if (safe[i]) { category = '분해 안전'; reason = `의지력·포인트·효과 모두 같거나 나은 젬 ${domCount[i]}개 보유 (한도 ${famCores * SLOTS_PER_CORE})`; }
    else if (usedNow[i]) { category = '유지'; reason = `현재 최적 배치에 사용 (빼면 전투력 -${delta[i].toFixed(3)}%)`; }
    else if (pHigh < s.useThreshold) { category = '분해 권장'; reason = `미래 젬 ${s.N}개를 더 깎는 경우 ${iterations}번 중 ${useCount[i]}번 쓰임 → 쓰일 확률 최대 ${(pHigh * 100).toFixed(1)}%`; }
    else { category = '보류'; reason = `미래 젬 ${s.N}개를 더 깎는 경우 ${iterations}번 중 ${useCount[i]}번 쓰임 → 쓰일 확률 최대 ${(pHigh * 100).toFixed(1)}%`; }
    return { index: i, id: g.id, label: gemLabel(g), family: g.family, type: g.type, will: g.will, willEff: g.willEff,
      points: g.points, effects: g.effects, dominators: domCount[i], usedNow: usedNow[i], delta: delta[i], pUse, pHigh, uses: useCount[i], category, reason };
  });

  // 추천: 분해 안전(지배 많은 순) → 분해 권장(P_use 낮은 순) → 보류(P_use 낮은 순)까지 k개
  const byCat = (c) => results.filter((r) => r.category === c);
  const ordered = [
    ...byCat('분해 안전').sort((a, b) => b.dominators - a.dominators),
    ...byCat('분해 권장').sort((a, b) => a.pHigh - b.pHigh || b.dominators - a.dominators),
    ...byCat('보류').filter((r) => byFam[r.family].cores.length).sort((a, b) => a.pHigh - b.pHigh || b.dominators - a.dominators),
  ];
  const recommend = ordered.slice(0, s.k).map((r) => r.index);
  const warn = warnings.slice();
  if (recommend.length < s.k) warn.push(`분해 후보가 ${recommend.length}개뿐 (요청 ${s.k}개)`);
  const riskyPick = recommend.filter((i) => results[i].category === '보류');
  if (riskyPick.length) warn.push(`요청 개수를 채우려고 '보류' 젬 ${riskyPick.length}개 포함 (미래에 쓰일 수 있음)`);

  return {
    settings: { ...s, iterations },
    summary: {
      gems: gems.length,
      counts: Object.fromEntries(['유지', '분해 안전', '분해 권장', '보류', '잠금'].map((c) => [c, byCat(c).length])),
      currentGainPct: 100 * (multNow - 1),
    },
    placement: placement.map((p) => ({
      core: `${p.core.family} ${p.core.slot} ${p.core.name ?? ''} (${p.core.grade})`.replace(/\s+/g, ' '),
      will: `${p.gems.reduce((t, g) => t + g.will, 0)}/${p.core.will}`,
      points: p.gems.reduce((t, g) => t + g.points, 0),
      corePct: p.core.pct(p.gems.reduce((t, g) => t + g.points, 0)),
      gems: p.gemIdx,
    })),
    gems: results,
    recommend,
    warnings: warn,
  };
}

/** 단일 스레드 전체 실행 */
export function evaluate(input, onProgress) {
  const ctx = prepare(input);
  const counts = runMonteCarlo(ctx, ctx.s.iterations, ctx.s.seed, onProgress);
  return finalize(ctx, counts, ctx.s.iterations);
}
