// 测试 6：后台 service worker 的重试 / 兜底 / 缓存
// 直接 vm 跑 extension/background.js，用桩 fetch 模拟 busy、故障、有道兜底
import fs from 'node:fs';
import vm from 'node:vm';

const CODE = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

function makeBg(fetchStub) {
  let listener = null;
  const store = {};
  const calls = { transmart: 0, youdao: 0 };

  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { listener = fn; } },
      onSuspend: { addListener: () => {} }
    },
    commands: { onCommand: { addListener: () => {} } },
    tabs: { query: async () => [], sendMessage: async () => {} },
    storage: {
      sync: { get: async (d) => Object.assign({}, d, { engine: 'free', mode: 'replace' }) },
      local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (o) => { Object.assign(store, o); },
        remove: async (k) => { delete store[k]; }
      }
    }
  };

  const ctx = vm.createContext({
    chrome, console, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, URLSearchParams, fetch: fetchStub(calls), Date
  });
  vm.runInContext(CODE, ctx);

  const send = (msg) => new Promise((res) => listener(msg, {}, res));
  return { send, calls, store };
}

const OK = (texts) => ({
  ok: true, status: 200,
  json: async () => ({
    header: { ret_code: 'succ' },
    auto_translation: texts.map(t => '译:' + t)
  }),
  text: async () => ''
});
const BUSY = () => ({
  ok: true, status: 200,
  json: async () => ({ header: { ret_code: 'busy' } }),
  text: async () => ''
});
const YD = (q) => ({
  ok: true, status: 200,
  json: async () => ({ translation: ['有道:' + q] }),
  text: async () => ''
});

let pass = 0, total = 0;
const chk = (n, ok, extra) => { total++; if (ok) pass++; console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (extra ? '   ' + extra : '')); };

/* ---- 1) busy → 重试成功 ---- */
console.log('===== 1) 遇到 busy 应退避重试，而不是判定失败 =====');
{
  let n = 0;
  const bg = makeBg((c) => async (url, opt) => {
    c.transmart++;
    n++;
    if (n === 1) return BUSY();
    return OK(JSON.parse(opt.body).source.text_list);
  });
  const r = await bg.send({ type: 'translate', texts: ['Run All Cells', 'Restart Kernel'] });
  chk('busy 后重试成功', r.ok && r.results[0] === '译:Run All Cells', JSON.stringify(r.results));
  chk('确实调用了 2 次', bg.calls.transmart === 2, '调用 ' + bg.calls.transmart + ' 次');
}

/* ---- 2) 一直 busy：小批量走有道兜底，且不逐条串行 ---- */
console.log('\n===== 2) transmart 彻底失败 → 有道兜底（并发，不串行）=====');
{
  const t0 = Date.now();
  const bg = makeBg((c) => async (url, opt) => {
    if (url.includes('youdao')) {
      c.youdao++;
      const q = new URLSearchParams(opt.body).get('q');
      await new Promise(r => setTimeout(r, 200));   // 模拟单条 200ms
      return YD(q);
    }
    c.transmart++;
    // 400 属不可重试错误 → 不做退避，直接进兜底，这样测到的是兜底本身的并发度
    return { ok: false, status: 400, json: async () => ({}), text: async () => 'bad' };
  });
  const texts = ['Save File', 'Open Folder', 'Close Tab', 'New Window', 'Export Data'];
  const r = await bg.send({ type: 'translate', texts });
  const ms = Date.now() - t0;
  chk('兜底后有译文', r.ok && r.results.every(v => v.startsWith('有道:')), JSON.stringify(r.results));
  // 5 条串行要 1000ms+；并发 3 应当明显更快
  chk('有道兜底是并发的（5 条 < 800ms）', ms < 800, ms + 'ms');
  chk('300/400 类错误不重试', bg.calls.transmart === 1, bg.calls.transmart + ' 次');
}

/* ---- 3) 大批量一直 busy：拆半重试，最终不卡死 ---- */
console.log('\n===== 3) 大批量持续失败：应拆半重试，且总耗时有界 =====');
{
  const t0 = Date.now();
  const bg = makeBg((c) => async () => { c.transmart++; return BUSY(); });
  const texts = Array.from({ length: 60 }, (_, i) => 'Menu Item Number ' + i);
  const r = await bg.send({ type: 'translate', texts });
  const ms = Date.now() - t0;
  // 全批失败时故意抛错：页面据此显示"N 批失败（保留原文）"，比静默返回原文更有用
  chk('全批失败时抛错（供页面提示失败批数）', r.ok === false && /transmart/.test(String(r.error)), String(r.error));
  chk('60 条全部失败也 < 30 秒（不逐条串行）', ms < 30000, ms + 'ms');
  console.log('    transmart 请求次数:', bg.calls.transmart);
}

/* ---- 4) 缓存：同样的文字第二次不走网络 ---- */
console.log('\n===== 4) 本地缓存生效 =====');
{
  const bg = makeBg((c) => async (url, opt) => {
    c.transmart++;
    return OK(JSON.parse(opt.body).source.text_list);
  });
  const texts = ['Run All Cells', 'Kernel', 'Restart'];
  const r1 = await bg.send({ type: 'translate', texts });
  const after1 = bg.calls.transmart;
  const t0 = Date.now();
  const r2 = await bg.send({ type: 'translate', texts });
  const ms = Date.now() - t0;
  chk('第一次请求了网络', after1 === 1, after1 + ' 次');
  chk('第二次命中缓存，没再请求', bg.calls.transmart === after1, '仍然 ' + bg.calls.transmart + ' 次');
  chk('缓存返回结果一致', JSON.stringify(r1.results) === JSON.stringify(r2.results));
  chk('缓存命中很快（< 50ms）', ms < 50, ms + 'ms');
}

console.log('\n' + pass + '/' + total + ' 通过');
process.exit(pass === total ? 0 : 1);
