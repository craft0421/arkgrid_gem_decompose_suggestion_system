// 젬 데이터 모델
import { GEM_TYPES, DEALER_EFFECT_COEF, normEffect } from './data.js';

/** 딜러 기준 효과 가치 (전투력 %, 레벨당 계수 합. floor 무시한 선형 근사) */
export function dealerEff(effects) {
  let v = 0;
  for (const [e, lv] of Object.entries(effects)) v += (DEALER_EFFECT_COEF[e] || 0) * lv;
  return v;
}

/**
 * 입력을 정규화한 젬 객체를 만든다.
 * 입력: { type:'안정', willEff:1~5 또는 will(필요 의지력), points:1~5,
 *         effects: [['공격력',1],['추가피해',4]] 또는 {공격력:1, 추가피해:4}, id?, locked? }
 */
export function makeGem(input, idx = 0) {
  const t = GEM_TYPES[input.type];
  if (!t) throw new Error(`젬 타입 오류: ${input.type}`);
  let willEff = input.willEff;
  if (willEff == null && input.will != null) willEff = t.baseWill - input.will;
  check(willEff, '의지력 효율', input);
  check(input.points, '포인트', input);
  const effects = {};
  const list = Array.isArray(input.effects) ? input.effects : Object.entries(input.effects || {});
  if (list.length !== 2) throw new Error(`젬 효과는 2개여야 함: ${JSON.stringify(input)}`);
  for (const [name, lv] of list) {
    const e = normEffect(name);
    if (!t.pool.includes(e)) throw new Error(`${input.type} 젬에 없는 효과: ${name}`);
    if (effects[e]) throw new Error(`같은 효과 중복: ${name}`);
    check(lv, `${e} 레벨`, input);
    effects[e] = lv;
  }
  return {
    id: input.id ?? `g${idx}`,
    type: input.type,
    family: t.family,
    willEff,
    will: t.baseWill - willEff,
    points: input.points,
    effects,
    eff: dealerEff(effects),
    locked: !!input.locked,
    source: input.source ?? 'held',
  };
}

function check(v, what, input) {
  if (!Number.isInteger(v) || v < 1 || v > 5) {
    throw new Error(`${what} 값 오류(1~5): ${v} in ${JSON.stringify(input)}`);
  }
}

/** 표시용 한 줄 요약 */
export function gemLabel(g) {
  const ef = Object.entries(g.effects).map(([e, l]) => `${e}${l}`).join('/');
  return `${g.type} 의지${g.will}(효율${g.willEff}) P${g.points} ${ef}`;
}
