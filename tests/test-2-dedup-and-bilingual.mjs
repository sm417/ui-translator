// 补充测试：去重 + 双语对照模式 + 长文本拆分
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const CODE = fs.readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');

const PAGE = `<!DOCTYPE html><html><body>
  <p class="a">Save changes</p>
  <p class="a">Save changes</p>
  <p class="a">Save changes</p>
  <button title="Save changes">OK</button>
  <p id="long">${('This paragraph is deliberately long so that the splitter has to break it into pieces before sending it to the translator. ').repeat(8)}</p>
</body></html>`;

const dom = new JSDOM(PAGE, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

const settings = { engine: 'free', mode: 'bilingual', hover: true, auto: false };
let listener = null;
let calls = [];

window.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg, cb) => {
      calls.push(msg.texts);
      (async () => {
        try {
          const r = await fetch('https://transmart.qq.com/api/imt', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/157.0.0.0',
              'Referer': 'https://transmart.qq.com/'
            },
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
const send = (msg) => new Promise((res) => listener(msg, {}, res));

const r = await send({ type: 'run' });
await new Promise(r2 => setTimeout(r2, 300));

const doc = window.document;
const zhSpans = doc.querySelectorAll('.uizh-zh');
const firstP = doc.querySelector('p.a');

const checks = [
  ['3 句相同文字只发 1 条', calls.length >= 1 && calls[0].filter(t => t === 'Save changes').length === 1],
  ['长段落被拆成多段发送', calls[0].length > 2],
  ['双语模式插入了译文节点', zhSpans.length >= 4],
  ['原文仍然保留', firstP.textContent.includes('Save changes')],
  ['译文出现在同级', firstP.textContent.includes('保存') || firstP.textContent.includes('保存更改')]
];

console.log('run:', JSON.stringify(r), '| 批次数', calls.length, '| 首批条数', calls[0].length);
console.log('第一个 p 的完整文本:', JSON.stringify(firstP.textContent));
console.log('双语节点数:', zhSpans.length);
console.log('');
let pass = 0;
for (const [n, ok] of checks) { console.log((ok ? '  PASS  ' : '  FAIL  ') + n); if (ok) pass++; }
console.log('\n' + pass + '/' + checks.length + ' 通过');
process.exit(pass === checks.length ? 0 : 1);
