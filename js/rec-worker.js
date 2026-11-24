// 화면 인식 Web Worker: 캡처 한 장(ImageData 형식)을 받아 readFrame 결과를 돌려줌
import { readFrame, prepareTemplates } from './recognize.js';
import raw from './rec-templates.js';

const T = prepareTemplates(raw);
let hint = null; // 직전 화면의 기준 위치 (같은 크기 화면일 때만)
self.onmessage = (e) => {
  const { id, width, height, buffer, tol } = e.data;
  try {
    const h = hint && hint.w === width && hint.h === height ? hint : null;
    const fr = readFrame({ width, height, data: new Uint8ClampedArray(buffer) }, T, { tol: tol ?? 1, hint: h });
    hint = fr.ok && fr.anchor ? { x: fr.anchor.x, y: fr.anchor.y, w: width, h: height } : null;
    self.postMessage({ id, ok: true, frame: { ok: fr.ok, reason: fr.reason, scale: fr.scale, anchor: fr.anchor ? { x: fr.anchor.x, y: fr.anchor.y, score: fr.anchor.score } : null, thumb: fr.thumb, family: fr.family, rows: fr.rows ?? [] } });
  } catch (err) {
    self.postMessage({ id, ok: false, message: String(err?.message || err) });
  }
};
