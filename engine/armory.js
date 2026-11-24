// 공식 API(/armories/characters/{이름}) 응답에서 코어·장착 젬·무기 코어 파라미터 추출 (Phase 2.5 선행)
// API로는 장착 젬만 받을 수 있음 (GAME_DATA.md 8-2)
import { weaponParams } from './cp.js';

const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const parseTooltip = (t) => (typeof t === 'string' ? JSON.parse(t) : t);

function tooltipText(tip) {
  const out = [];
  const walk = (x) => {
    if (x == null) return;
    if (typeof x === 'string') out.push(strip(x));
    else if (typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(parseTooltip(tip));
  return out.join(' ');
}

/** "질서의 해 코어 : 왜곡된 시간선" → { family, slot, name } */
export function parseCoreName(full) {
  const m = /(질서|혼돈)의\s*(해|달|별)\s*코어\s*:\s*(.+)$/.exec(strip(full));
  if (!m) throw new Error(`코어 이름 해석 실패: ${full}`);
  return { family: m[1], slot: m[2], name: m[3].trim() };
}

/** 젬 툴팁 → makeGem 입력 */
export function parseGem(gem) {
  const tip = parseTooltip(gem.Tooltip);
  const title = strip(tip.Element_000?.value);
  const tm = /(질서|혼돈)의\s*젬\s*:\s*(\S+)/.exec(title);
  if (!tm) throw new Error(`젬 이름 해석 실패: ${title}`);
  const text = tooltipText(tip);
  const wm = /의지력 효율\s*(\d)/.exec(text);
  const pm = /(?:질서|혼돈) 포인트\s*:\s*(\d)/.exec(text);
  const effects = [...text.matchAll(/\[([^\]]+)\]\s*Lv\.(\d)/g)].map((m) => [m[1], Number(m[2])]);
  return { type: tm[2], willEff: Number(wm[1]), points: Number(pm[1]), effects, active: gem.IsActive !== false };
}

/** ArkGrid → { cores:[...], placement:[{coreIdx, gems:[...]}] } */
export function parseArkGrid(armory) {
  const cores = [], gems = [], placement = [];
  for (const slot of armory.ArkGrid?.Slots ?? []) {
    const core = { ...parseCoreName(slot.Name), grade: slot.Grade, apiPoint: slot.Point };
    const ci = cores.push(core) - 1;
    const gi = [];
    for (const g of slot.Gems ?? []) {
      const pg = parseGem(g);
      if (!pg.active) continue;
      gi.push(gems.push({ ...pg, id: `${core.family}${core.slot}-${gi.length + 1}` }) - 1);
    }
    placement.push({ coreIdx: ci, gems: gi });
  }
  return { cores, gems, placement };
}

/**
 * 무기 코어 파라미터 (GAME_DATA.md 7-5):
 *  F = 장비 '무기 공격력 +N' 합, p = 장비 '무기 공격력 +N%' 합 + 0.001 × 깨달음 카르마 레벨,
 *  c = 완갑 '기본 공격력 +N', X = API 기본 공격력 / (1 + Σ기본공%) − c
 *  (API 기본 공격력은 조회 시점 버프를 포함 → X가 약간 달라질 수 있으나 d에만 쓰여 영향 작음)
 */
export function weaponParamsFromArmory(armory) {
  let F = 0, pEquip = 0, c = 0, basePct = 0;
  for (const e of armory.ArmoryEquipment ?? []) {
    const t = tooltipText(e.Tooltip);
    for (const m of t.matchAll(/무기 공격력 \+([\d.]+)(%?)/g)) {
      if (m[2]) pEquip += Number(m[1]) / 100; else F += Number(m[1]);
    }
    for (const m of t.matchAll(/기본 공격력 \+([\d.]+)(%?)/g)) {
      if (m[2]) basePct += Number(m[1]) / 100; else c += Number(m[1]);
    }
  }
  const gemDesc = strip(armory.ArmoryGem?.Effects?.Description);
  const gm = /기본 공격력 총합\s*:\s*([\d.]+)%/.exec(gemDesc);
  if (gm) basePct += Number(gm[1]) / 100;
  const karma = (armory.ArkPassive?.Points ?? []).find((p) => p.Name === '깨달음');
  const km = /(\d+)레벨/.exec(karma?.Description ?? '');
  const karmaLevel = km ? Number(km[1]) : 0;
  const p = pEquip + 0.001 * karmaLevel;
  const stat = (armory.ArmoryProfile?.Stats ?? []).find((s) => s.Type === '공격력');
  const bm = /기본 공격력은\s*([\d,]+)/.exec((stat?.Tooltip ?? []).map(strip).join(' '));
  const baseAtk = bm ? Number(bm[1].replace(/,/g, '')) : null;
  if (!baseAtk) throw new Error('API 응답에서 기본 공격력을 찾지 못함 (무기 코어 파라미터 계산 불가)');
  const X = baseAtk / (1 + basePct) - c;
  return { ...weaponParams({ F, p, c, X }), karmaLevel, basePct, baseAtk };
}

export function combatPower(armory) {
  return Number(String(armory.ArmoryProfile?.CombatPower ?? '').replace(/,/g, ''));
}

/**
 * 사이트에 보낼 요약 (서버에서 사용): 화면에 필요한 값만 남기고 툴팁 원문은 버린다.
 * { profile, cores:[{family,slot,name,grade,point}], gems:[엔진 젬 + core], weapon:{F,pPct,c,baseAtk,basePct,karmaLevel}|null, weaponError }
 */
export function summarizeArmory(armory) {
  const p = armory.ArmoryProfile ?? {};
  const profile = {
    name: p.CharacterName ?? '', server: p.ServerName ?? '', className: p.CharacterClassName ?? '',
    itemLevel: p.ItemAvgLevel ?? '', combatPower: combatPower(armory) || null, arkPassive: armory.ArkPassive?.Title ?? '',
  };
  const { cores, gems, placement } = parseArkGrid(armory);
  const outGems = [];
  placement.forEach(({ coreIdx, gems: gi }) => gi.forEach((i) => {
    const { active, ...g } = gems[i];
    outGems.push({ ...g, core: `${cores[coreIdx].family} ${cores[coreIdx].slot}` });
  }));
  let weapon = null, weaponError = null;
  try {
    const w = weaponParamsFromArmory(armory);
    const r = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
    weapon = { F: w.F, pPct: r(w.p * 100, 2), c: w.c, baseAtk: w.baseAtk, basePct: r(w.basePct * 100, 2), karmaLevel: w.karmaLevel };
  } catch (e) { weaponError = e.message; }
  return {
    profile,
    cores: cores.map(({ family, slot, name, grade, apiPoint }) => ({ family, slot, name, grade, point: apiPoint })),
    gems: outGems, weapon, weaponError,
  };
}
