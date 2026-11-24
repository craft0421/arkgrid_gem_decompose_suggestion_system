// 1단계 지배 필터 (PLAN.md 3-2)
// A가 B를 지배: 같은 계열, 필요 의지력 A ≤ B, 포인트 A ≥ B, 효과 가치 A ≥ B.
// 완전히 같은 젬끼리는 앞쪽(인덱스 작은) 젬이 뒤쪽을 지배한다고 본다 (사본 중 하나만 남기기 위함).
// B를 지배하는 젬이 계열 동시 장착 한도(코어 수 × 4) 이상이면 B는 어떤 상황에서도 최적 배치에 필요 없다.
import { DEALER_EFFECTS } from './data.js';

const EPS = 1e-12;

/**
 * mode 'scalar': 효과를 딜러 전투력 가치 합(eff)으로 비교 (기본)
 * mode 'vector': 딜러 효과별 레벨을 각각 비교 (보수적: 계수 오차에 영향 안 받음)
 */
export function dominates(a, b, ia, ib, mode = 'scalar') {
  if (a.family !== b.family) return false;
  if (a.will > b.will || a.points < b.points) return false;
  let effGe, effGt;
  if (mode === 'vector') {
    effGe = true; effGt = false;
    for (const e of DEALER_EFFECTS) {
      const x = a.effects[e] || 0, y = b.effects[e] || 0;
      if (x < y) { effGe = false; break; }
      if (x > y) effGt = true;
    }
  } else {
    effGe = a.eff >= b.eff - EPS;
    effGt = a.eff > b.eff + EPS;
  }
  if (!effGe) return false;
  const strict = a.will < b.will || a.points > b.points || effGt;
  return strict || ia < ib;
}

/** 각 젬을 지배하는 젬 수 (gems: 같은 판정 대상 목록) */
export function dominatorCounts(gems, mode = 'scalar') {
  const n = gems.length;
  const cnt = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && dominates(gems[j], gems[i], j, i, mode)) cnt[i]++;
    }
  }
  return cnt;
}

/** 한도 이상 지배당하는 젬을 뺀 인덱스 목록 (배치 계산 전 후보 줄이기) */
export function undominatedIndices(gems, limit, mode = 'scalar') {
  const cnt = dominatorCounts(gems, mode);
  const out = [];
  for (let i = 0; i < gems.length; i++) if (cnt[i] < limit) out.push(i);
  return out;
}
