// 测试 8：引擎把原文原样吐回时，不能污染缓存，也不能当成译文写进页面
//
// 真实故障（2026-11-12，PubMed）：标题 "Growth and size control during development."
// 在页面上出现了两行一模一样的英文。根因是某次降级把原文当结果返回，而缓存不加判断
// 就收下了，此后这句永远返回英文；页面侧又因为比的是未规范化的原文（带首尾空白），
// 判定「和原文不同」，就把英文当成译文插了进去。
//
// A) 后台：echo（原样返回）的结果不得进缓存 —— 下次有正常引擎时应当拿到真译文
// B) 后台：结果和原文不同、但一个汉字都没有，同样不算翻译
// C) 页面：译文中没有汉字时不得插入第二行；有汉字时必须插入（反向对照，防止假通过）
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const BG = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const CONTENT = fs.readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');

let pass = 0, total = 0;
const chk = (n, ok, extra) => {
  total++; if (ok) pass++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (extra ? '   ' + extra : ''));
};

/* ================= A / B：后台缓存 ================= */

function makeBg(getImpl) {
  let listener = null;
  const store = {};
  const chrome = {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, onSuspend: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
    tabs: { query: async () => [], sendMessage: async () => {} },
    storage: {
      sync: { get: async (d) => Object.assign({}, d, { engine: 'free' }) },
      local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (o) => { Object.assign(store, o); },
        remove: async (k) => { delete store[k]; }
      }
    }
  };
  const ctx = vm.createContext({
    chrome, console, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, URLSearchParams, Date,
    fetch: (url, opt) => getImpl()(url, opt)
  });
  vm.runInContext(BG, ctx);
  const send = (msg) => new Promise((res) => listener(msg, {}, res));
  return { send, store };
}

const OK = (arr) => ({ ok: true, status: 200, json: async () => ({ header: { ret_code: 'succ' }, auto_translation: arr }), text: async () => '' });

// 引擎把输入原样吐回（模拟排队降级 / 无效字符）
const ECHO = () => async (url, opt) => OK(JSON.parse(opt.body).source.text_list);
// 引擎只改了标点，仍全是英文
const STRIP_DOT = () => async (url, opt) => OK(JSON.parse(opt.body).source.text_list.map(t => t.replace(/\.$/, '')));
// 正常引擎
const REAL = () => async (url, opt) => OK(JSON.parse(opt.body).source.text_list.map(t => '开发期间的生长和大小控制。'));

const TITLE = 'Growth and size control during development.';

console.log('===== A) 引擎原样返回：结果不得进缓存 =====');
{
  let impl = ECHO();
  const bg = makeBg(() => impl);
  const r1 = await bg.send({ type: 'translate', texts: [TITLE] });
  chk('第一次拿到的是原文（引擎没翻）', r1.ok && r1.results[0] === TITLE, JSON.stringify(r1.results));
  chk('后台自报「未翻译」条数 = 1', r1.untranslated === 1, 'untranslated=' + r1.untranslated);

  impl = REAL();                     // 换成正常引擎，等价于「下次打开同一页」
  const r2 = await bg.send({ type: 'translate', texts: [TITLE] });
  chk('第二次拿到真译文（说明没被缓存毒住）', r2.results[0] === '开发期间的生长和大小控制。', JSON.stringify(r2.results));
  chk('第二次确实走了网络（untranslated=0）', r2.untranslated === 0, 'untranslated=' + r2.untranslated);
}

console.log('\n===== B) 结果与原文不同但无汉字：同样不算翻译 =====');
{
  let impl = STRIP_DOT();
  const bg = makeBg(() => impl);
  const r1 = await bg.send({ type: 'translate', texts: [TITLE] });
  chk('去掉句号的英文不算译文', r1.untranslated === 1, JSON.stringify(r1.results));

  impl = REAL();
  const r2 = await bg.send({ type: 'translate', texts: [TITLE] });
  chk('第二次仍能拿到真译文', r2.results[0] === '开发期间的生长和大小控制。', JSON.stringify(r2.results));
}

console.log('\n===== C) 页面侧：无汉字的「译文」不得插入 =====');
async function pageWith(resultsFn, nodeHtml) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>' + nodeHtml + '</body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  let listener = null;
  window.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => { listener = fn; } },
      sendMessage: (msg, cb) => {
        setTimeout(() => cb({ ok: true, results: resultsFn(msg.texts) }), 0);
      }
    },
    storage: { sync: { get: () => Promise.resolve({ engine: 'free', mode: 'bilingual', hover: false, auto: false }) } }
  };
  window.eval(CONTENT);
  const send = (m) => new Promise((res) => listener(m, {}, res));
  const r = await send({ type: 'run' });
  await new Promise(x => setTimeout(x, 120));
  return { doc: window.document, r, window };
}

// C1：原节点带换行/缩进（真实页面几乎都是这样），引擎原样返回
{
  const { doc, r } = await pageWith(
    (texts) => texts.slice(),
    '<h1 id="t">\n            Growth and size control during development.\n          </h1>');
  chk('原样返回时不插入 .uizh-zh', doc.querySelectorAll('.uizh-zh').length === 0,
    '数量 ' + doc.querySelectorAll('.uizh-zh').length);
  chk('原样返回时不产生 .uizh-pair', doc.querySelectorAll('.uizh-pair').length === 0);
  chk('原文一字未动', doc.querySelector('#t').textContent === '\n            Growth and size control during development.\n          ');
  chk('页面如实报告 0 处', r.ok && r.translated === 0, 'translated=' + r.translated);
}

// C2：引擎返回「只差一个句号」的英文
{
  const { doc } = await pageWith(
    (texts) => texts.map(t => t.replace(/\.$/, '')),
    '<h1 id="t">Growth and size control during development.</h1>');
  chk('只差标点的英文也不插入', doc.querySelectorAll('.uizh-zh').length === 0,
    '数量 ' + doc.querySelectorAll('.uizh-zh').length);
}

// C3：反向对照 —— 真给中文时必须插入，否则上面的断言可能是假通过
{
  const { doc } = await pageWith(
    () => ['开发期间的生长和大小控制。'],
    '<h1 id="t">\n            Growth and size control during development.\n          </h1>');
  const zh = doc.querySelectorAll('.uizh-zh');
  chk('给中文时正常插入 1 行（反向对照）', zh.length === 1, '数量 ' + zh.length);
  chk('插入的文字是中文', zh[0] && zh[0].textContent === '开发期间的生长和大小控制。',
    zh[0] && JSON.stringify(zh[0].textContent));
}

console.log('\n' + pass + '/' + total + ' 通过');
process.exit(pass === total ? 0 : 1);
