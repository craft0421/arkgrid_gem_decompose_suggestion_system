// 배포용 서버 (외부 의존성 없음): 사이트 파일 + 캐릭터 불러오기 API 대리 호출
//   node server.js            (deploy/ 폴더 안에서. 빌드: node scripts/build-dist.js)
//   환경변수 LOSTARK_API_KEY   로스트아크 Open API 키 (필수, 코드·로그·응답에 절대 남기지 않음)
//            PORT              Render가 넣어 줌 (기본 10000)
//            LOSTARK_API_BASE  시험용 (기본 공식 주소)
//   POST /api/character  {"name":"캐릭터명"} → 코어·장착 젬·무기 코어 값 요약 (engine/armory.js summarizeArmory)
//   GET  /healthz
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeArmory } from './engine/armory.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.LOSTARK_API_KEY || '';
const API_BASE = process.env.LOSTARK_API_BASE || 'https://developer-lostark.game.onstove.com';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const STATIC_DIRS = new Set(['css', 'js', 'engine', 'examples']); // server.js·package.json은 내보내지 않음
const SUPPORT_TITLES = new Set(['만개', '해방자', '절실한 구원', '축복의 오라']);

// ---- 호출 제한·캐시 (메모리) ----
const PER_IP = { limit: 10, windowMs: 60_000 }; // 한 사람당 분당 10회
const GLOBAL = { limit: 90, windowMs: 60_000 }; // 공식 API 키 한도(분당 100회) 아래로
const CACHE_MS = 5 * 60_000, CACHE_MAX = 500;
const hits = new Map(); let globalHits = [];
const cache = new Map();

function allow(ip) {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < GLOBAL.windowMs);
  const mine = (hits.get(ip) ?? []).filter((t) => now - t < PER_IP.windowMs);
  if (mine.length >= PER_IP.limit) return 'ip';
  if (globalHits.length >= GLOBAL.limit) return 'global';
  mine.push(now); hits.set(ip, mine); globalHits.push(now);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < PER_IP.windowMs)) hits.delete(k);
  return null;
}

const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(status, {
    'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'cache-control': 'no-cache', ...extra,
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const fail = (res, status, message) => send(res, status, { error: message });

async function readBody(req, max = 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw new Error('too large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

async function character(req, res) {
  if (!API_KEY) return fail(res, 503, '서버에 API 키가 설정되지 않았습니다.');
  let name;
  try { name = String(JSON.parse(await readBody(req)).name ?? '').trim(); } catch { return fail(res, 400, '요청 형식이 잘못되었습니다.'); }
  if (!/^[가-힣A-Za-z0-9]{2,12}$/.test(name)) return fail(res, 400, '캐릭터 이름은 한글·영문·숫자 2~12자입니다.');

  const key = name.toLowerCase(), hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return send(res, 200, hit.data);

  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
  const blocked = allow(ip);
  if (blocked) return fail(res, 429, blocked === 'ip' ? '잠시 후 다시 시도해 주세요. (1분에 10회까지)' : '지금 이용자가 많습니다. 1분 뒤 다시 시도해 주세요.');

  let up;
  try {
    up = await fetch(`${API_BASE}/armories/characters/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/json', authorization: `bearer ${API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return fail(res, 504, '로스트아크 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (up.status === 429) return fail(res, 429, '로스트아크 API 호출 한도에 걸렸습니다. 1분 뒤 다시 시도해 주세요.');
  if (up.status === 503) return fail(res, 503, '로스트아크 서버 점검 중입니다.');
  if (up.status === 401 || up.status === 403) { console.error(`[api] upstream ${up.status} (키 확인 필요)`); return fail(res, 502, '서버 API 키에 문제가 있습니다.'); }
  if (!up.ok) { console.error(`[api] upstream ${up.status}`); return fail(res, 502, `로스트아크 API 오류 (${up.status})`); }

  let armory;
  try { armory = await up.json(); } catch { armory = null; }
  if (!armory || !armory.ArmoryProfile) return fail(res, 404, '캐릭터를 찾지 못했습니다. 이름을 확인해 주세요.');
  if (!armory.ArkGrid?.Slots?.length) return fail(res, 404, '이 캐릭터는 아크 그리드 정보가 없습니다.');

  let data;
  try { data = summarizeArmory(armory); } catch (e) { console.error(`[api] 해석 실패: ${e.message}`); return fail(res, 500, '캐릭터 정보를 해석하지 못했습니다.'); }
  data.role = SUPPORT_TITLES.has(data.profile.arkPassive) ? '서폿' : '딜러';
  cache.set(key, { at: Date.now(), data });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return send(res, 200, data);
}

async function serveStatic(path, res) {
  const rel = path === '/' ? 'index.html' : normalize(decodeURIComponent(path)).replace(/^[\\/]+/, '');
  const parts = rel.split(/[\\/]/);
  if (parts.includes('..') || !(rel === 'index.html' || STATIC_DIRS.has(parts[0]))) return fail(res, 404, 'not found');
  try {
    send(res, 200, await readFile(join(ROOT, rel)), TYPES[extname(rel)] || 'application/octet-stream');
  } catch { fail(res, 404, 'not found'); }
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (pathname === '/api/character') {
      if (req.method !== 'POST') return fail(res, 405, 'POST만 됩니다.');
      return await character(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
    return await serveStatic(pathname, res);
  } catch (e) {
    console.error(`[server] ${e.message}`);
    if (!res.headersSent) fail(res, 500, '서버 오류');
  }
}).listen(PORT, () => console.log(`listening on ${PORT}${API_KEY ? '' : ' (LOSTARK_API_KEY 없음: 캐릭터 불러오기 꺼짐)'}`));
