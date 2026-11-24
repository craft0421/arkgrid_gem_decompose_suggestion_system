// 게임 규칙 상수와 측정 계수 (docs/GAME_DATA.md, data/coefficients.json)
// 브라우저·Node 공용: 계수는 data/coefficients.json에서 생성한 JS 모듈로 읽음 (scripts/build-coef.js)
import COEF_DATA from './coefficients.js';

export const COEF = COEF_DATA;

export const FAMILIES = ['질서', '혼돈'];
export const SLOTS = ['해', '달', '별'];

// 젬 타입: 기본 의지력과 효과 풀 (풀 순서는 고정, 효과는 풀 인덱스로 다룸)
export const GEM_TYPES = {
  안정: { family: '질서', baseWill: 8, pool: ['공격력', '추가피해', '아군피해강화', '낙인력'] },
  견고: { family: '질서', baseWill: 9, pool: ['공격력', '보스피해', '아군피해강화', '아군공격강화'] },
  불변: { family: '질서', baseWill: 10, pool: ['추가피해', '보스피해', '낙인력', '아군공격강화'] },
  침식: { family: '혼돈', baseWill: 8, pool: ['공격력', '추가피해', '아군피해강화', '낙인력'] },
  왜곡: { family: '혼돈', baseWill: 9, pool: ['공격력', '보스피해', '아군피해강화', '아군공격강화'] },
  붕괴: { family: '혼돈', baseWill: 10, pool: ['추가피해', '보스피해', '낙인력', '아군공격강화'] },
};
export const TYPES_BY_FAMILY = { 질서: ['안정', '견고', '불변'], 혼돈: ['침식', '왜곡', '붕괴'] };

// 효과 이름 표기 흔들림 정리 (API는 "추가 피해", "보스 피해" 처럼 띄어 씀)
const EFFECT_ALIASES = {
  '추가 피해': '추가피해', '보스 피해': '보스피해', '아군 피해 강화': '아군피해강화',
  '아군 공격 강화': '아군공격강화',
};
export function normEffect(name) {
  const n = String(name).trim();
  return EFFECT_ALIASES[n] ?? n.replace(/\s+/g, '');
}

// 딜러 효과 계수: 레벨 1당 전투력 %
// 정확한 분수(1/30, 7/120, 1/12)로 둬야 floor(레벨합×계수, 0.01%)에서 부동소수 오차가 안 생김
export const DEALER_EFFECT_FRAC = { 공격력: [1, 30], 추가피해: [7, 120], 보스피해: [1, 12] };
export const DEALER_EFFECT_COEF = Object.fromEntries(
  Object.entries(DEALER_EFFECT_FRAC).map(([k, [n, d]]) => [k, n / d]));
export const DEALER_EFFECTS = Object.keys(DEALER_EFFECT_COEF);
// coefficients.json 값과 어긋나면 바로 알 수 있게 확인
for (const k of DEALER_EFFECTS) {
  if (Math.abs(COEF.gem_effects_dealer[k] - DEALER_EFFECT_COEF[k]) > 1e-6) {
    throw new Error(`딜러 효과 계수 불일치: ${k}`);
  }
}

// 코어 등급: 공급 의지력과 활성 가능한 최대 구간
export const CORE_GRADES = {
  고대: { will: 17, maxTier: 20 },
  유물: { will: 15, maxTier: 20 },
  전설: { will: 12, maxTier: 14 },
  영웅: { will: 9, maxTier: 10 },
};
export const TIERS = [10, 14, 17, 18, 19, 20];

// 가공 규칙 (GAME_DATA 4-1)
export const PROCESS_GRADES = {
  고급: { attempts: 5, rerolls: 0 },
  희귀: { attempts: 7, rerolls: 1 },
  영웅: { attempts: 9, rerolls: 2 },
};
