// 딜러 전투력 모델 (docs/GAME_DATA.md 7-5, data/coefficients.json)
//   전투력 = 기준 × Π(1 + 코어%/100) × Π(1 + floor(레벨합 × 계수, 0.01%)/100)
import { COEF, CORE_GRADES, TIERS, DEALER_EFFECT_FRAC, DEALER_EFFECTS } from './data.js';

const C = COEF.cores;

/** 포인트 합이 도달한 구간 (등급 최대 구간으로 제한). 10 미만이면 0 */
export function tierOf(points, grade) {
  const max = CORE_GRADES[grade].maxTier;
  let t = 0;
  for (const x of TIERS) if (points >= x && x <= max) t = x;
  return t;
}

/** 혼돈 코어 이름 → 'A형' | 'B형' | '무기형' | '딜러 0' */
export function chaosKind(slot, name) {
  const key = `${slot}:${String(name).trim()}`;
  for (const kind of ['A형', 'B형', '무기형', '딜러 0']) {
    if (C.혼돈[kind].members.includes(key)) return kind;
  }
  return null;
}

/**
 * 무기 코어 파라미터.
 *   F: 무공 고정 합(API 장비), p: 무공% 합(장비 + 0.001×깨달음 카르마 레벨),
 *   c: 완갑 '기본 공격력' 고정값, X: √(주스탯×F(1+p)/6) 또는 stat(주스탯)을 주면 계산
 */
export function weaponParams({ F, p, c, X, stat }) {
  if (X == null) {
    if (stat == null) throw new Error('무기 코어: X 또는 stat(주스탯) 필요');
    X = Math.sqrt(stat * F * (1 + p) / 6);
  }
  return { F, p, c, X, d: X / (X + c) };
}

// 측정 캐릭터(차원술사, 2026-11-11 장비) 값. 사용자 값이 없을 때만 쓰는 기본값
export const DEFAULT_WEAPON = weaponParams({ F: 230111, p: 0.06, c: 3690, stat: 788064 });

function weaponPct(tier, w, grade) {
  if (!tier) return 0;
  const opts = grade === '유물' ? C.혼돈.무기형.core_options_유물 : C.혼돈.무기형.core_options;
  const [flat, pct] = opts[String(tier)];
  const ratio = Math.sqrt((w.F + flat) * (1 + w.p + pct) / (w.F * (1 + w.p)));
  return 100 * w.d * (ratio - 1);
}

function tableValue(table, tier) {
  return tier ? table[String(tier)] : 0;
}

/**
 * 코어 하나의 전투력 % 함수를 만든다.
 * core = { family:'질서'|'혼돈', slot:'해'|'달'|'별', name, grade, weapon? }
 * 반환: { pct(points), will, kind, warnings[] }
 */
export function makeCore(core) {
  const grade = core.grade;
  if (!CORE_GRADES[grade]) throw new Error(`코어 등급 오류: ${grade}`);
  const warnings = [];
  let kind, base;
  if (core.family === '질서') {
    kind = core.slot === '별' ? '질서_별' : '질서_해달';
    const t = C[kind].고대;
    base = (tier) => tableValue(t, tier);
  } else if (core.family === '혼돈') {
    kind = chaosKind(core.slot, core.name);
    if (!kind) {
      warnings.push(`혼돈 코어 '${core.slot}:${core.name}'는 계수 미확인 → 딜러 0으로 계산`);
      kind = '딜러 0';
    }
    if (kind === '딜러 0') base = () => 0;
    else if (kind === '무기형') {
      const w = core.weapon ? weaponParams(core.weapon) : DEFAULT_WEAPON;
      if (!core.weapon) warnings.push('무기 코어 파라미터 미입력 → 측정 캐릭터(차원술사) 값으로 근사');
      base = (tier) => weaponPct(tier, w, grade); // 유물은 17P 옵션이 고대의 2/3 (E10 확정)
    } else {
      const t = C.혼돈[kind].고대;
      base = (tier) => tableValue(t, tier);
    }
  } else throw new Error(`계열 오류: ${core.family}`);

  // 유물: 17P 이상 구간이 고대보다 1.0%p 낮음 (질서 해·달·별, 혼돈 A/B형). 무기형은 옵션 자체가 달라 위에서 처리
  const relicPenalty = grade === '유물' && kind !== '딜러 0' && kind !== '무기형';
  const pct = (points) => {
    const tier = tierOf(points, grade);
    let v = base(tier);
    if (relicPenalty && tier >= 17) v -= 1.0;
    return v;
  };
  return { ...core, kind, will: CORE_GRADES[grade].will, pct, warnings };
}

/** 효과별 레벨합 → 젬 효과 전투력 배율 (floor 0.01% 반영, 정수 연산) */
export function effectMultiplier(levelSums) {
  let m = 1;
  for (const e of DEALER_EFFECTS) {
    const L = levelSums[e] || 0;
    const [n, d] = DEALER_EFFECT_FRAC[e];
    const hundredths = Math.floor((L * 100 * n) / d); // 0.01% 단위
    m *= 1 + hundredths / 10000;
  }
  return m;
}

/**
 * 배치 전체의 전투력 배율.
 * placement = [{ core(makeCore 결과), gems:[gem...] }]
 */
export function placementMultiplier(placement) {
  let m = 1;
  const sums = {};
  for (const { core, gems } of placement) {
    let pts = 0;
    for (const g of gems) {
      pts += g.points;
      for (const [e, lv] of Object.entries(g.effects)) sums[e] = (sums[e] || 0) + lv;
    }
    m *= 1 + core.pct(pts) / 100;
  }
  return m * effectMultiplier(sums);
}
