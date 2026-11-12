// 端到端测试：把 content.js 真跑在 jsdom 里，翻译走真实网络接口
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const CODE = fs.readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');

const PAGE = `<!DOCTYPE html><html><head><title>t</title></head><body>
  <div id="toolbar">
    <button id="btn-run">Run All Cells</button>
    <button id="btn-restart" title="Restart Kernel">R</button>
    <span id="kernel">Kernel: Python 3 (ipykernel)</span>
  </div>
  <div class="jp-InputArea">
    <div class="cm-editor"><div class="cm-content" contenteditable="true">import pandas as pd</div></div>
    <pre id="codeblock"><code>df = pd.read_csv("data.csv")</code></pre>
  </div>
  <p id="md">This notebook shows how to compute the median lifespan of each group.</p>
  <input id="search" placeholder="Search files and commands">
  <p id="cn">已经是中文的段落，不该被翻译。</p>
  <p id="num">3.14</p>
  <p id="kbd">Press <kbd>Ctrl</kbd>+<kbd>S</kbd> to save</p>
</body></html>`;

const dom = new JSDOM(PAGE, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

/* ---- 桩：chrome.* ---- */
const settings = { engine: 'free', mode: 'replace', hover: true, auto: false };
let listener = null;
let netCalls = 0;

window.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg, cb) => {
      if (msg.type !== 'translate') return cb({ ok: false, error: 'unexpected' });
      netCalls++;
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
          if (d.header.ret_code !== 'succ') return cb({ ok: false, error: d.header.ret_code });
          cb({ ok: true, results: d.auto_translation });
        } catch (e) { cb({ ok: false, error: e.message }); }
      })();
    }
  },
  storage: {
    sync: { get: () => Promise.resolve(settings) }
  }
};

/* ---- 跑 content.js ---- */
window.eval(CODE);

const $ = (s) => window.document.querySelector(s);
const txt = (s) => ($(s) ? $(s).textContent.trim() : '(缺失)');

function snap() {
  return {
    run: txt('#btn-run'),
    kernel: txt('#kernel'),
    code: txt('#codeblock'),
    cm: txt('.cm-content'),
    md: txt('#md'),
    placeholder: $('#search').getAttribute('placeholder'),
    restartTitle: $('#btn-restart').getAttribute('title'),
    cn: txt('#cn'),
    num: txt('#num'),
    kbd: txt('#kbd'),
    kbdInner: $('#kbd kbd').textContent
  };
}

const before = snap();

const send = (msg) => new Promise((res) => listener(msg, {}, res));

const t0 = Date.now();
const r1 = await send({ type: 'run' });
console.log('run 响应:', JSON.stringify(r1), (Date.now() - t0) + 'ms', '| 网络请求次数', netCalls);

await new Promise(r => setTimeout(r, 200));
const after = snap();

const checks = [
  ['工具栏按钮已翻成中文', /[\u4e00-\u9fff]/.test(after.run)],
  ['内核标签已翻成中文', /[\u4e00-\u9fff]/.test(after.kernel)],
  ['<pre><code> 原样未动', after.code === before.code],
  ['CodeMirror 原样未动', after.cm === before.cm],
  ['正文段落已翻', /[\u4e00-\u9fff]/.test(after.md)],
  ['placeholder 已翻', after.placeholder !== before.placeholder && /[\u4e00-\u9fff]/.test(after.placeholder)],
  ['title 属性已翻', after.restartTitle !== before.restartTitle && /[\u4e00-\u9fff]/.test(after.restartTitle)],
  ['已是中文的段落没动', after.cn === before.cn],
  ['纯数字 3.14 没动', after.num === before.num],
  ['<kbd> 快捷键原样', after.kbdInner === 'Ctrl']
];

const r2 = await send({ type: 'restore' });
await new Promise(r => setTimeout(r, 100));
const back = snap();

checks.push(['还原后按钮回到英文', back.run === before.run]);
checks.push(['还原后 placeholder 回原样', back.placeholder === before.placeholder]);
checks.push(['还原后 title 回原样', back.restartTitle === before.restartTitle]);
checks.push(['还原后正文回原样', back.md === before.md]);
checks.push(['还原后 kbd 句回原样', back.kbd === before.kbd]);

console.log('\n--- 翻译结果 ---');
console.log('按钮     :', before.run, '=>', after.run);
console.log('内核     :', before.kernel, '=>', after.kernel);
console.log('正文     :', before.md.slice(0, 42) + '…', '=>', after.md.slice(0, 42) + '…');
console.log('placeholder:', before.placeholder, '=>', after.placeholder);
console.log('title    :', before.restartTitle, '=>', after.restartTitle);

console.log('\n--- 检查项 ---');
let pass = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  if (ok) pass++;
}
console.log('\n' + pass + '/' + checks.length + ' 通过');
process.exit(pass === checks.length ? 0 : 1);
