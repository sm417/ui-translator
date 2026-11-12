// 中英对照专项：结构、flex 布局占位、还原
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const EXT = fileURLToPath(new URL('../extension/', import.meta.url));
const CODE = fs.readFileSync(EXT + '/content.js', 'utf8');

const PAGE = `<!DOCTYPE html><html><body>
  <button id="flexbtn" style="display:flex;align-items:center;gap:6px">
    <span id="lbl">Run All Cells</span>
  </button>
  <div id="flexrow" style="display:flex;gap:8px">
    <span id="c1">Open</span><span id="c2">Close</span>
  </div>
  <p id="p1">This paragraph is about the median lifespan of each group.</p>
</body></html>`;

const dom = new JSDOM(PAGE, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const settings = { engine: 'free', mode: 'bilingual', hover: true, auto: false };
let listener = null;

window.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg, cb) => {
      (async () => {
        try {
          const r = await fetch('https://transmart.qq.com/api/imt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0' },
              type: 'plain', model_category: 'normal', text_domain: 'general',
              source: { lang: 'en', text_list: msg.texts },
              target: { lang: 'zh' }
            })
          });
          const d = await r.json();
          cb({ ok: true, results: d.auto_translation });
        } catch (e) { cb({ ok: false, error: e.message }); }
      })();
    }
  },
  storage: { sync: { get: () => Promise.resolve(settings) } }
};

window.eval(CODE);
const send = (m) => new Promise((res) => listener(m, {}, res));
const doc = window.document;
const q = (s) => doc.querySelector(s);

const orig = {
  lbl: q('#lbl').textContent,
  c1: q('#c1').textContent,
  p1: q('#p1').textContent
};

const r = await send({ type: 'run' });
await new Promise(x => setTimeout(x, 250));

const pairs = [...doc.querySelectorAll('.uizh-pair')];
const pairInLabel = q('#lbl').querySelector('.uizh-pair');

const checks = [
  ['翻译有产出', r.ok && r.translated >= 3],
  ['每个译文都包在 .uizh-pair 里', pairs.length >= 3],
  ['pair 结构正确（src + zh 两个块）', pairs.every(p =>
    p.children.length === 2 &&
    p.children[0].classList.contains('uizh-src') &&
    p.children[1].classList.contains('uizh-zh'))],
  ['按钮里的 span 只多出一个子元素（不破坏 flex 排布）', q('#lbl').children.length === 1],
  ['按钮文字原文仍在', q('#lbl').textContent.includes(orig.lbl)],
  ['按钮文字译文已加', /[\u4e00-\u9fff]/.test(q('#lbl').textContent)],
  ['原文与译文顺序是"原文在上"', pairInLabel && pairInLabel.textContent.indexOf(orig.lbl) === 0],
  ['同一行两个 span 各自独立成对', q('#c1').children.length === 1 && q('#c2').children.length === 1],
  ['段落也成对', !!q('#p1').querySelector('.uizh-pair')]
];

// 还原
await send({ type: 'restore' });
await new Promise(x => setTimeout(x, 150));

checks.push(['还原后 .uizh-pair 全部消失', doc.querySelectorAll('.uizh-pair').length === 0]);
checks.push(['还原后按钮文字逐字复原', q('#lbl').textContent === orig.lbl]);
checks.push(['还原后段落逐字复原', q('#p1').textContent === orig.p1]);
checks.push(['还原后 span 子元素数归位', q('#lbl').children.length === 0 || q('#lbl').textContent === orig.lbl]);

console.log('translated =', r.translated, '| pair 数 =', pairs.length);
console.log('按钮内文本 =', JSON.stringify(q('#lbl').textContent), '(还原后)');
console.log('');
let pass = 0;
for (const [n, ok] of checks) { console.log((ok ? '  PASS  ' : '  FAIL  ') + n); if (ok) pass++; }
console.log('\n' + pass + '/' + checks.length + ' 通过');
process.exit(pass === checks.length ? 0 : 1);
