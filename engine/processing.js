// 젬 가공 확률 모델 + 기대값 최적 가공 정책(DP) + 정책을 따른 젬 생성 시뮬레이션
// 규칙: docs/GAME_DATA.md 4절, 정책 설계: PLAN.md 5-1
//
// 단순화 (문서화된 근사):
//  - 골드 무시 → 가공 비용 ±100% 항목은 "아무 변화 없는 항목"으로 취급.
//    비용 비율 상한(±100% 도달 시 미등장) 조건은 무시하고 '남은 횟수 1회' 조건만 적용
//  - 초기화(1회)는 정책에서 쓰지 않음 (보수적: 실제보다 결과가 약간 나쁠 수 있음)
//  - 다른 항목 보기 횟수는 RR_CAP까지만 추적 (넘치면 버림)
import { GEM_TYPES, DEALER_EFFECT_COEF, PROCESS_GRADES } from './data.js';
import { makeRng, drawDistinct } from './rng.js';

const MAX_ATTEMPTS = 9;
const RR_CAP = 3;
const OFFER_SAMPLES = 64; // 상태당 제시 항목 표본 수 (DP 기대값 근사)

// 항목 코드: 옵션 X(0=의지력효율,1=포인트,2=효과1,3=효과2) × 종류(0:+1,1:+2,2:+3,3:+4,4:-1) = X*5+종류
const OPT_WEIGHTS = [11.65, 4.40, 1.75, 0.45, 3.00];
const OPT_DELTA = [1, 2, 3, 4, -1];
const IT_CHANGE1 = 20, IT_CHANGE2 = 21, IT_COST_UP = 22, IT_COST_DOWN = 23, IT_KEEP = 24, IT_RR1 = 25, IT_RR2 = 26;
const OTHER_ITEMS = [
  [IT_CHANGE1, 3.25, false], [IT_CHANGE2, 3.25, false],
  [IT_COST_UP, 1.75, true], [IT_COST_DOWN, 1.75, true], [IT_KEEP, 1.75, false],
  [IT_RR1, 2.50, true], [IT_RR2, 0.75, true],
]; // [코드, 표기확률, 남은 횟수 1회일 때 미등장]

export const ITEM_NAMES = (() => {
  const n = [];
  const opt = ['의지력 효율', '포인트', '첫번째 효과', '두번째 효과'];
  const kind = ['+1', '+2', '+3', '+4', '-1'];
  for (let x = 0; x < 4; x++) for (let k = 0; k < 5; k++) n.push(`${opt[x]} ${kind[k]}`);
  return n.concat(['첫번째 효과 변경', '두번째 효과 변경', '가공 비용 +100%', '가공 비용 -100%',
    '가공 상태 유지', '다른 항목 보기 +1', '다른 항목 보기 +2']);
})();

/** 현재 옵션값(o[4], 각 1~5)과 '남은 가공 1회' 여부로 등장 가능한 항목과 표기확률 */
export function eligibleItems(o, lastAttempt) {
  const codes = [], weights = [];
  for (let x = 0; x < 4; x++) {
    for (let k = 0; k < 5; k++) {
      const nv = o[x] + OPT_DELTA[k];
      if (nv < 1 || nv > 5) continue;
      codes.push(x * 5 + k);
      weights.push(OPT_WEIGHTS[k]);
    }
  }
  for (const [c, w, hideOnLast] of OTHER_ITEMS) {
    if (hideOnLast && lastAttempt) continue;
    codes.push(c);
    weights.push(w);
  }
  return { codes, weights };
}

// ---- 상태 인덱스 ----
// 효과 쌍 (e1,e2: 풀 인덱스 0~3, 서로 다름) → 0~11
function pairIndex(e1, e2) { return e1 * 3 + (e2 < e1 ? e2 : e2 - 1); }
const PAIRS = [];
for (let e1 = 0; e1 < 4; e1++) for (let e2 = 0; e2 < 4; e2++) if (e1 !== e2) PAIRS[pairIndex(e1, e2)] = [e1, e2];

function baseIndex(pair, o) { // o 값 1~5
  return (((pair * 5 + o[0] - 1) * 5 + o[1] - 1) * 5 + o[2] - 1) * 5 + o[3] - 1;
}
const N_BASE = 12 * 625;
function stateIndex(base, r, rr) { return (base * MAX_ATTEMPTS + (r - 1)) * (RR_CAP + 1) + rr; }

// 옵션값 조합별 '등장 가능 항목'과 표본 제시 세트 (공통 난수: 같은 조합이면 같은 표본 사용)
const configCache = new Map();
function offerConfig(o, last, M) {
  const key = `${o.join('')}${last ? 1 : 0}`;
  let c = configCache.get(key);
  if (c) return c;
  const { codes, weights } = eligibleItems(o, last);
  const rng = makeRng(hash(key));
  const offers = new Uint8Array(M * 4);
  for (let m = 0; m < M; m++) {
    const d = drawDistinct(weights, 4, rng);
    for (let j = 0; j < 4; j++) offers[m * 4 + j] = d[j];
  }
  c = { codes, weights, offers, M };
  configCache.set(key, c);
  return c;
}
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/**
 * 완성 젬의 단독 가치 u (전투력 % 단위의 근사 점수). 가공 정책의 목표값.
 *   u = A × (의지력 효율 + 포인트) + Σ 딜러 효과 계수 × 레벨
 * A: 의지력 효율·포인트 1당 가치. 기본 0.3 → 효율·포인트가 효과보다 우선, 효과는 동점 깨기 이상.
 */
export function makeUtility({ A = 0.3 } = {}) {
  return function u(o, e1, e2, pool) {
    const c1 = DEALER_EFFECT_COEF[pool[e1]] || 0;
    const c2 = DEALER_EFFECT_COEF[pool[e2]] || 0;
    return A * (o[0] + o[1]) + c1 * o[2] + c2 * o[3];
  };
}

/**
 * 효과 풀 하나에 대한 가치표 V[상태] 계산.
 * V(상태) = 다음 제시 세트를 보기 전, 이미 1회 이상 가공한 상태의 기대 가치.
 */
export function buildPolicy(pool, { utility = makeUtility(), samples = OFFER_SAMPLES } = {}) {
  const V = new Float32Array(N_BASE * MAX_ATTEMPTS * (RR_CAP + 1));
  const o = [1, 1, 1, 1];
  const after = new Float64Array(32);
  for (let r = 1; r <= MAX_ATTEMPTS; r++) {
    for (let pair = 0; pair < 12; pair++) {
      const [e1, e2] = PAIRS[pair];
      for (o[0] = 1; o[0] <= 5; o[0]++) for (o[1] = 1; o[1] <= 5; o[1]++)
        for (o[2] = 1; o[2] <= 5; o[2]++) for (o[3] = 1; o[3] <= 5; o[3]++) {
          const cfg = offerConfig(o, r === 1, samples);
          const base = baseIndex(pair, o);
          const uNow = utility(o, e1, e2, pool);
          for (let rr = 0; rr <= RR_CAP; rr++) {
            // 각 항목을 적용했을 때의 가치 (가공 1회 소모)
            for (let i = 0; i < cfg.codes.length; i++) {
              after[i] = afterValue(V, cfg.codes[i], o, e1, e2, r, rr, pool, utility);
            }
            let T = uNow; // 가공 완료
            if (rr > 0) T = Math.max(T, V[stateIndex(base, r, rr - 1)]); // 다른 항목 보기
            let sum = 0;
            const off = cfg.offers;
            for (let m = 0; m < samples; m++) {
              const q = (after[off[m * 4]] + after[off[m * 4 + 1]] + after[off[m * 4 + 2]] + after[off[m * 4 + 3]]) / 4;
              sum += q > T ? q : T;
            }
            V[stateIndex(base, r, rr)] = sum / samples;
          }
        }
    }
  }
  return { pool, V, utility, samples };
}

function afterValue(V, code, o, e1, e2, r, rr, pool, utility) {
  const nr = r - 1;
  const val = (no, ne1, ne2, nrr) => (nr === 0
    ? utility(no, ne1, ne2, pool)
    : V[stateIndex(baseIndex(pairIndex(ne1, ne2), no), nr, Math.min(nrr, RR_CAP))]);
  if (code < 20) {
    const x = (code / 5) | 0, k = code % 5;
    const no = o.slice();
    no[x] += OPT_DELTA[k];
    return val(no, e1, e2, rr);
  }
  if (code === IT_CHANGE1 || code === IT_CHANGE2) {
    let s = 0, n = 0;
    for (let c = 0; c < 4; c++) {
      if (c === e1 || c === e2) continue;
      s += code === IT_CHANGE1 ? val(o, c, e2, rr) : val(o, e1, c, rr);
      n++;
    }
    return s / n;
  }
  if (code === IT_RR1) return val(o, e1, e2, rr + 1);
  if (code === IT_RR2) return val(o, e1, e2, rr + 2);
  return val(o, e1, e2, rr); // 비용 ±, 유지
}

// 정책 캐시: 효과 풀(타입 계열 무관하게 3종)별로 한 번만 계산
const policyCache = new Map();
const policyKey = (pool, opts) => `${pool.join(',')}|${opts.A ?? 0.3}|${opts.samples ?? OFFER_SAMPLES}`;
export function getPolicy(gemType, opts = {}) {
  const pool = GEM_TYPES[gemType].pool;
  const key = policyKey(pool, opts);
  let p = policyCache.get(key);
  if (!p) {
    p = buildPolicy(pool, { utility: makeUtility({ A: opts.A }), samples: opts.samples });
    p.opts = { A: opts.A, samples: opts.samples };
    policyCache.set(key, p);
  }
  return p;
}

/** 계산된 정책표를 워커로 넘기기 위한 직렬화/복원 (워커마다 다시 계산하지 않게) */
export function exportPolicies() {
  return [...policyCache.entries()].map(([key, p]) => ({ key, pool: p.pool, opts: p.opts, samples: p.samples, V: p.V }));
}
export function importPolicies(list) {
  for (const { key, pool, opts, samples, V } of list) {
    if (!policyCache.has(key)) policyCache.set(key, { pool, V, samples, opts, utility: makeUtility({ A: opts?.A }) });
  }
}

/**
 * 정책을 따라 젬 하나를 분배부터 가공 완료까지 시뮬레이션.
 * 반환: makeGem 입력 형식 { type, willEff, points, effects:[[이름,lv],[이름,lv]] }
 */
export function simulateGem(gemType, grade, rng, policy = getPolicy(gemType)) {
  const { pool, V, utility } = policy;
  const g = PROCESS_GRADES[grade];
  if (!g) throw new Error(`가공 등급 오류: ${grade}`);
  const o = [1, 1, 1, 1];
  let e1 = (rng() * 4) | 0;
  let e2 = (rng() * 3) | 0; if (e2 >= e1) e2++;
  let r = g.attempts, rr = g.rerolls, started = false;
  while (r > 0) {
    const { codes, weights } = eligibleItems(o, r === 1);
    const offer = drawDistinct(weights, 4, rng).map((i) => codes[i]);
    const q = offer.reduce((s, c) => s + afterValue(V, c, o, e1, e2, r, rr, pool, utility), 0) / 4;
    if (started) {
      const uNow = utility(o, e1, e2, pool);
      const vRe = rr > 0 ? V[stateIndex(baseIndex(pairIndex(e1, e2), o), r, Math.min(rr, RR_CAP) - 1)] : -Infinity;
      if (uNow >= q && uNow >= vRe) break; // 가공 완료
      if (vRe > q) { rr--; continue; } // 다른 항목 보기
    }
    // 가공 하기: 4개 중 하나가 25%로 적용
    const code = offer[(rng() * 4) | 0];
    if (code < 20) o[(code / 5) | 0] += OPT_DELTA[code % 5];
    else if (code === IT_CHANGE1 || code === IT_CHANGE2) {
      const cand = [0, 1, 2, 3].filter((c) => c !== e1 && c !== e2);
      const c = cand[(rng() * cand.length) | 0];
      if (code === IT_CHANGE1) e1 = c; else e2 = c;
    } else if (code === IT_RR1) rr = Math.min(rr + 1, RR_CAP);
    else if (code === IT_RR2) rr = Math.min(rr + 2, RR_CAP);
    r--;
    started = true;
  }
  return { type: gemType, willEff: o[0], points: o[1], effects: [[pool[e1], o[2]], [pool[e2], o[3]]] };
}

/** 정책 없이 가공 횟수를 끝까지 쓰는 단순 정책 (비교·검증용) */
export function simulateGemNaive(gemType, grade, rng) {
  const pool = GEM_TYPES[gemType].pool;
  const o = [1, 1, 1, 1];
  let e1 = (rng() * 4) | 0;
  let e2 = (rng() * 3) | 0; if (e2 >= e1) e2++;
  for (let r = PROCESS_GRADES[grade].attempts; r > 0; r--) {
    const { codes, weights } = eligibleItems(o, r === 1);
    const code = codes[drawDistinct(weights, 4, rng)[(rng() * 4) | 0]];
    if (code < 20) o[(code / 5) | 0] += OPT_DELTA[code % 5];
    else if (code === IT_CHANGE1 || code === IT_CHANGE2) {
      const cand = [0, 1, 2, 3].filter((c) => c !== e1 && c !== e2);
      const c = cand[(rng() * cand.length) | 0];
      if (code === IT_CHANGE1) e1 = c; else e2 = c;
    }
  }
  return { type: gemType, willEff: o[0], points: o[1], effects: [[pool[e1], o[2]], [pool[e2], o[3]]] };
}
