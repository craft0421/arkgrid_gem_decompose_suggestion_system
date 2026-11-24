// 화면 인식 Web Worker: 캡처 한 장(ImageData 형식)을 받아 readFrame 결과를 돌려줌
import { readFrame, prepareTemplates } from './recognize.js';
import raw from './rec-templates.js';

const T = prepareTemplates(raw);
self.onmessage = (e) => {
  const { id, width, height, buffer, tol } = e.data;
  try {
    const fr = readFrame({ width, height, data: new Uint8ClampedArray(buffer) }, T, { tol: tol ?? 1 });
    self.postMessage({ id, ok: true, frame: { ok: fr.ok, reason: fr.reason, scale: fr.scale, anchor: fr.anchor ? { x: fr.anchor.x, y: fr.anchor.y, score: fr.anchor.score } : null, thumb: fr.thumb, family: fr.family, rows: fr.rows ?? [] } });
  } catch (err) {
    self.postMessage({ id, ok: false, message: String(err?.message || err) });
  }
};
