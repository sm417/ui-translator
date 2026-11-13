// PubMed 类页面回归：
// 标题/摘要里夹着 <a> <i> 时，必须整段翻，不能把句子切成碎片，
// 也不能每个碎片各套一个 inline-block 框（那会把行高撑爆、英文被裁掉）。
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const CODE = fs.readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const CSS = fs.readFileSync(new URL('../extension/content.css', import.meta.url), 'utf8');

const PAGE = `<!DOCTYPE html><html lang="en"><body>
  <div class="article">
    <h1 class="heading-title">Gut metabolism links <a href="/a">precision nutrition</a>, exercise,
      and healthspan in <i>Drosophila melanogaster</i>.</h1>

    <div class="abstract">
      <h2>Abstract</h2>
      <div class="abstract-content selected">
        <p>Here, utilizing a chemically defined diet (CDD) in <i>Drosophila melanogaster</i>,
           we systematically evaluated a multimodal intervention combining methionine restriction (MR),
           taurine supplementation (Tau), and moderate exercise.</p>
      </div>
    </div>

    <div class="toolbar">
      <button id="cite" title="Cite this article">Cite</button>
      <span id="pmid">PMID: 41404613</span>
      <a id="disclaimer" href="/d">PubMed Disclaimer</a>
    </div>

    <div class="results">
      <a id="clamped" href="/x" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden">Longevity-promoting interventions commonly entail functional trade-offs, raising the unresolved question of whether lifespan extension necessarily compromises physiological performance</a>
    </div>
  </div>
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
  storage: { sync: { get: () => Promise.resolve(settings) } }
};

window.eval(CODE);
const doc = window.document;
const q = (s) => doc.querySelector(s);
const send = (m) => new Promise((res) => listener(m, {}, res));

const before = {
  h1: q('.heading-title').textContent.replace(/\s+/g, ' ').trim(),
  abs: q('.abstract-content p').textContent.replace(/\s+/g, ' ').trim(),
  h2: q('.abstract h2').textContent.trim(),
  html: q('.article').innerHTML
};

const r = await send({ type: 'run' });
await new Promise((x) => setTimeout(x, 300));

const h1 = q('.heading-title');
const absP = q('.abstract-content p');
const h1Blk = h1.querySelectorAll('.uizh-blk');
const absBlk = absP.querySelectorAll('.uizh-blk');
const zhOf = (el) => el.querySelector('.uizh-blk')?.textContent.trim() || '';

const checks = [
  ['标题只生成 1 条块级译文', h1Blk.length === 1],
  ['标题里没有任何行内碎块', h1.querySelectorAll('.uizh-pair').length === 0],
  ['标题英文原文完整保留', h1.textContent.replace(/\s+/g, ' ').includes(before.h1)],
  ['标题译文是整句（含"果蝇"且长度 > 20）', /果蝇/.test(zhOf(h1)) && zhOf(h1).length > 20],
  ['标题译文不再出现"精度 营养"式伪分段', !/^\s*精度/.test(zhOf(h1))],
  ['摘要段落只生成 1 条块级译文', absBlk.length === 1],
  ['摘要段落里没有行内碎块', absP.querySelectorAll('.uizh-pair').length === 0],
  ['摘要译文整段（长度 > 60）', zhOf(absP).length > 60],
  ['摘要原文仍完整（含 Drosophila）', absP.textContent.includes('Drosophila melanogaster')],
  ['h2 Abstract 得到"摘要"', /摘要/.test(zhOf(q('.abstract h2')))],
  ['按钮仍是行内对照（不撑坏工具栏）', !!q('#cite').querySelector('.uizh-pair')],
  ['按钮 title 属性照样翻译', /[\u4e00-\u9fff]/.test(q('#cite').getAttribute('title'))],
  ['块级译文是块级显示', /\.uizh-blk\s*\{[^}]*display:\s*block/.test(CSS)],
  ['块级译文在 flex 容器里独占整行', /\.uizh-blk\s*\{[^}]*width:\s*100%/.test(CSS)],
  ['被 line-clamp 截断的标题：译文放在元素外面（不会被裁掉）', (() => {
    const blk = q('#clamped').nextElementSibling;
    return !!blk && blk.classList.contains('uizh-blk') && /[\u4e00-\u9fff]/.test(blk.textContent);
  })()],
  ['有产出', r.ok && r.translated >= 3]
];

const titleZh = zhOf(h1);
const absZh = zhOf(absP);

await send({ type: 'restore' });
await new Promise((x) => setTimeout(x, 200));

checks.push(['还原后无 .uizh-blk 残留', doc.querySelectorAll('.uizh-blk').length === 0]);
checks.push(['还原后无 .uizh-pair 残留', doc.querySelectorAll('.uizh-pair').length === 0]);
checks.push(['还原后无 data-uizh-done 残留', doc.querySelectorAll('[data-uizh-done]').length === 0]);
checks.push(['还原后标题逐字复原', h1.textContent.replace(/\s+/g, ' ').trim() === before.h1]);
checks.push(['还原后摘要逐字复原', absP.textContent.replace(/\s+/g, ' ').trim() === before.abs]);
checks.push(['还原后 DOM 结构完全一致', q('.article').innerHTML === before.html]);

console.log('run:', JSON.stringify(r));
console.log('标题译文:', titleZh || '(空)');
console.log('摘要译文:', (absZh || '(空)').slice(0, 80) + '…');
console.log('');
let pass = 0;
for (const [n, ok] of checks) { console.log((ok ? '  PASS  ' : '  FAIL  ') + n); if (ok) pass++; }
console.log('\n' + pass + '/' + checks.length + ' 通过');
process.exit(pass === checks.length ? 0 : 1);
