// 사이트 데이터 모델: 젬·코어 입력 검증, 엔진 입력 변환, CSV 가져오기/내보내기
import COEF from '../../engine/coefficients.js';

export const GEM_TYPES = {
  안정: { family: '질서', baseWill: 8, pool: ['공격력', '추가피해', '아군피해강화', '낙인력'] },
  견고: { family: '질서', baseWill: 9, pool: ['공격력', '보스피해', '아군피해강화', '아군공격강화'] },
  불변: { family: '질서', baseWill: 10, pool: ['추가피해', '보스피해', '낙인력', '아군공격강화'] },
  침식: { family: '혼돈', baseWill: 8, pool: ['공격력', '추가피해', '아군피해강화', '낙인력'] },
  왜곡: { family: '혼돈', baseWill: 9, pool: ['공격력', '보스피해', '아군피해강화', '아군공격강화'] },
  붕괴: { family: '혼돈', baseWill: 10, pool: ['추가피해', '보스피해', '낙인력', '아군공격강화'] },
};
export const TYPE_NAMES = Object.keys(GEM_TYPES);
export const EFFECT_LABEL = { 공격력: '공격력', 추가피해: '추가 피해', 보스피해: '보스 피해', 아군피해강화: '아군 피해 강화', 아군공격강화: '아군 공격 강화', 낙인력: '낙인력' };
export const DEALER_EFFECTS = ['공격력', '추가피해', '보스피해'];
export const CORE_GRADES = ['고대', '유물', '전설', '영웅'];
export const SLOTS = ['해', '달', '별'];

const normEffect = (s) => {
  const t = String(s ?? '').replace(/\s+/g, '');
  return Object.keys(EFFECT_LABEL).find((k) => k === t) ?? t;
};

// 혼돈 코어 이름 목록 (slot별). coefficients.json 의 members ("해:재빠른 공격")에서 만듦
export const CHAOS_CORES = (() => {
  const out = { 해: [], 달: [], 별: [] };
  for (const kind of ['A형', 'B형', '무기형', '딜러 0']) {
    for (const m of COEF.cores.혼돈[kind].members) {
      const [slot, name] = m.split(':');
      out[slot].push(name);
    }
  }
  return out;
})();

let seq = 0;
export const newId = () => `g${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** 편집기용 젬 객체: { id, type, will, points, e1, l1, e2, l2, locked } */
export function blankGem(type = '안정') {
  const pool = GEM_TYPES[type].pool;
  return { id: newId(), type, will: GEM_TYPES[type].baseWill - 3, points: 3, e1: pool[0], l1: 1, e2: pool[1], l2: 1, locked: false };
}

/** 엔진 입력 형식({type, willEff|will, points, effects}) → 편집기 젬 */
export function fromEngineGem(g) {
  const t = GEM_TYPES[g.type];
  const list = Array.isArray(g.effects) ? g.effects : Object.entries(g.effects || {});
  const will = g.will ?? (t ? t.baseWill - g.willEff : null);
  return {
    id: g.id && !/^g\d+$/.test(g.id) ? g.id : newId(), type: g.type, will, points: g.points,
    e1: normEffect(list[0]?.[0]), l1: list[0]?.[1], e2: normEffect(list[1]?.[0]), l2: list[1]?.[1], locked: !!g.locked,
  };
}

/** 편집기 젬 → 엔진 입력 */
export function toEngineGem(g) {
  return { id: g.id, type: g.type, will: g.will, points: g.points, effects: [[g.e1, g.l1], [g.e2, g.l2]], locked: g.locked };
}

/** 젬 하나 검사 → 오류 메시지 배열 (빈 배열이면 정상) */
export function validateGem(g) {
  const err = [];
  const t = GEM_TYPES[g.type];
  if (!t) return ['타입을 고르세요'];
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!isInt(g.will, t.baseWill - 5, t.baseWill - 1)) err.push(`${g.type} 젬의 필요 의지력은 ${t.baseWill - 5}~${t.baseWill - 1}`);
  if (!isInt(g.points, 1, 5)) err.push('포인트는 1~5');
  if (!t.pool.includes(g.e1) || !t.pool.includes(g.e2)) err.push(`${g.type} 젬에 없는 효과`);
  else if (g.e1 === g.e2) err.push('두 효과가 같음');
  if (!isInt(g.l1, 1, 5) || !isInt(g.l2, 1, 5)) err.push('효과 Lv는 1~5');
  return err;
}

/** 코어 설정: { family, slot, name, grade, enabled } × 6 + 무기 코어 파라미터 */
export function defaultCores() {
  return [
    ...SLOTS.map((slot) => ({ family: '질서', slot, name: '', grade: '고대', enabled: true })),
    { family: '혼돈', slot: '해', name: '재빠른 공격', grade: '고대', enabled: true },
    { family: '혼돈', slot: '달', name: '불타는 일격', grade: '고대', enabled: true },
    { family: '혼돈', slot: '별', name: '공격', grade: '고대', enabled: true },
  ];
}
// 무기 코어 입력값 (게임/API에서 보는 값). 기본값: 측정 캐릭터(차원술사 11-24)
export function defaultWeapon() {
  return { F: 242927, pPct: 6.0, c: 5980, baseAtk: 218298, basePct: 14.1 };
}
export function weaponToEngine(w) {
  const p = w.pPct / 100;
  const X = w.baseAtk / (1 + w.basePct / 100) - w.c;
  return { F: w.F, p, c: w.c, X };
}

/** 사이트 상태 → 엔진 입력 */
export function toEngineInput(state) {
  const cores = state.cores.filter((c) => c.enabled).map((c) => {
    const core = { family: c.family, slot: c.slot, name: c.name || `${c.family} ${c.slot}`, grade: c.grade };
    if (c.family === '혼돈' && c.name === '무기') core.weapon = weaponToEngine(state.weapon);
    return core;
  });
  return { cores, gems: state.gems.map(toEngineGem), settings: { ...state.settings } };
}

// ---- CSV ----
const CSV_HEAD = ['타입', '필요의지력', '포인트', '효과1', 'Lv1', '효과2', 'Lv2', '잠금'];
export function gemsToCsv(gems) {
  const rows = gems.map((g) => [g.type, g.will, g.points, EFFECT_LABEL[g.e1] ?? g.e1, g.l1, EFFECT_LABEL[g.e2] ?? g.e2, g.l2, g.locked ? 'O' : '']);
  return [CSV_HEAD, ...rows].map((r) => r.join(',')).join('\r\n');
}
/** CSV 텍스트 → { gems, errors:[{line, msg}] } (머리줄 있어도 없어도 됨) */
export function csvToGems(text) {
  const gems = [], errors = [];
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const cells = line.split(/[,\t]/).map((c) => c.trim());
    if (!line.trim() || cells[0] === '타입') return;
    const [type, will, points, e1, l1, e2, l2, locked] = cells;
    const g = { id: newId(), type, will: Number(will), points: Number(points), e1: normEffect(e1), l1: Number(l1), e2: normEffect(e2), l2: Number(l2), locked: /^(o|y|1|true|잠금)$/i.test(locked || '') };
    const err = validateGem(g);
    if (err.length) errors.push({ line: i + 1, msg: err.join(', ') });
    else gems.push(g);
  });
  return { gems, errors };
}
