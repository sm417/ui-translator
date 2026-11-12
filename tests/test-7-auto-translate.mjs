// 测试 7：自动翻译（切到新页面也自动翻）
// 覆盖：自动开时自动翻 / 关时不翻 / 中文页不主动翻 / 无 lang 靠采样判定 /
//       手动翻一次即开启 / 还原即关闭 / 弹窗勾选立即生效 / 后台标签页延迟到可见
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const CODE = fs.readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');

function makeDom(html, settings) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/' });
  const { window } = dom;
  const store = Object.assign({ engine: 'free', mode: 'replace', hover: false, auto: false }, settings || {});
  const stats = { requests: 0, texts: [], sets: [], listener: null };

  window.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => { stats.listener = fn; } },
      sendMessage: (msg, cb) => {
        if (msg.type !== 'translate') return cb({ ok: false, error: 'unexpected' });
        stats.requests++;
        stats.texts.push(...msg.texts);
        setTimeout(() => cb({ ok: true, results: msg.texts.map(t => '译:' + t) }), 20);
      }
    },
    storage: {
      sync: {
        get: (d) => Promise.resolve(Object.assign({}, d, store)),
        set: (o) => { Object.assign(store, o); stats.sets.push(JSON.parse(JSON.stringify(o))); return Promise.resolve(); }
      }
    }
  };

  window.eval(CODE);
  const send = (m) => new Promise((res) => stats.listener(m, {}, res));
  return { window, store, stats, send };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

const EN_PAGE = (lang) => `<!DOCTYPE html><html${lang ? ` lang="${lang}"` : ''}><head><title>t</title></head><body>
  <button>Run All Cells</button>
  <div>Restart Kernel</div>
  <p>This notebook shows how to compute the median lifespan of each group.</p>
</body></html>`;

const ZH_PAGE = `<!DOCTYPE html><html><head><title>测试</title></head><body>
  <button>运行所有单元格</button>
  <div>重启内核</div>
  <p>这个笔记本展示了如何计算每组的平均寿命。</p>
</body></html>`;

let pass = 0, total = 0;
const chk = (n, ok, extra) => { total++; if (ok) pass++; console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (extra ? '   ' + extra : '')); };
const bodyText = (w) => w.document.body.textContent;

(async () => {

  /* ---------- A) 自动开 + 英文页 → 无需任何操作，自己翻 ---------- */
  console.log('===== A) 自动开 + 英文页（lang="en"）=====');
  {
    const { window, stats } = makeDom(EN_PAGE('en'), { auto: true });
    await wait(1100);
    chk('页面自己翻了（未发任何消息）', /译:Run All Cells/.test(bodyText(window)), bodyText(window).slice(0, 40));
    chk('确实打了网络请求', stats.requests >= 1, stats.requests + ' 批');
  }

  /* ---------- B) 自动关 + 英文页 → 一个请求都不该发 ---------- */
  console.log('\n===== B) 自动关 + 英文页 =====');
  {
    const { window, stats } = makeDom(EN_PAGE('en'), { auto: false });
    await wait(900);
    chk('没有发请求', stats.requests === 0, stats.requests + ' 批');
    chk('页面保持英文', !/译:/.test(bodyText(window)));
  }

  /* ---------- C) 自动开 + 中文页（无 lang，靠采样判定）→ 不主动翻 ---------- */
  console.log('\n===== C) 自动开 + 中文页（无 lang 属性）=====');
  {
    const { window, stats } = makeDom(ZH_PAGE, { auto: true });
    await wait(900);
    chk('中文页没有被扫', stats.requests === 0, stats.requests + ' 批');
    chk('中文原样保留', bodyText(window).includes('运行所有单元格'));
    chk('没有弹"没找到"提示', !String(window.document.querySelector('.uizh-toast')?.textContent || '').includes('没找到'));
  }

  /* ---------- D) 自动开 + 英文页但无 lang → 靠采样判定为英文 ---------- */
  console.log('\n===== D) 自动开 + 英文页（无 lang，靠采样）=====');
  {
    const { window, stats } = makeDom(EN_PAGE(''), { auto: true });
    await wait(1100);
    chk('采样判定为英文并翻译', /译:Run All Cells/.test(bodyText(window)), bodyText(window).slice(0, 40));
    chk('确实打了网络请求', stats.requests >= 1, stats.requests + ' 批');
  }

  /* ---------- E/F) 手动翻一次 → 开启自动；还原 → 关闭自动 ---------- */
  console.log('\n===== E/F) 点一次即开启自动 / 还原即停止 =====');
  {
    const { window, store, stats, send } = makeDom(EN_PAGE('en'), { auto: false });
    await wait(300);
    chk('初始 auto=false', store.auto === false);

    const r1 = await send({ type: 'run' });
    await wait(120);
    chk('手动翻译成功', r1.ok && r1.translated > 0, 'translated=' + r1.translated);
    chk('翻完即把 auto 写成 true（之后新页面自动翻）', store.auto === true, 'store.auto=' + store.auto);
    chk('写入的是 storage（不是只改内存）', stats.sets.some(o => o.auto === true));
    chk('返回体告诉弹窗已开自动', r1.autoOn === true);

    const r2 = await send({ type: 'restore' });
    await wait(120);
    chk('还原成功', r2.ok);
    chk('还原后 auto 变回 false（自动翻译已停）', store.auto === false, 'store.auto=' + store.auto);
    chk('页面文字逐字还原', bodyText(window).includes('Run All Cells') && !/译:/.test(bodyText(window)));
  }

  /* ---------- G) 弹窗里勾选「新页面自动翻」→ 当前页立即生效 ---------- */
  console.log('\n===== G) 弹窗勾选后当前页立即翻 =====');
  {
    const { window, stats, send } = makeDom(EN_PAGE('en'), { auto: true });
    // 这里等于「storage 已经是 true，但页面还没翻」（弹窗刚勾上）
    const r = await send({ type: 'autoEnable' });
    await wait(200);
    chk('autoEnable 返回成功', r.ok, JSON.stringify(r).slice(0, 60));
    chk('当前页立刻翻了', /译:Run All Cells/.test(bodyText(window)), bodyText(window).slice(0, 40));
    chk('有网络请求', stats.requests >= 1, stats.requests + ' 批');
  }

  /* ---------- H) 后台标签页：等可见了再翻 ---------- */
  console.log('\n===== H) 后台标签页延后到可见 =====');
  {
    const { window, stats } = makeDom(EN_PAGE('en'), { auto: true });
    let hidden = true;
    let okDefine = true;
    try {
      Object.defineProperty(window.document, 'visibilityState', {
        configurable: true, get: () => (hidden ? 'hidden' : 'visible')
      });
    } catch (e) { okDefine = false; }

    if (!okDefine) {
      console.log('  SKIP  jsdom 不允许覆盖 visibilityState，跳过该项');
    } else {
      // 重新跑一次 boot（首次 boot 已在可见状态下排队，这里换一个新实例更干净）
      const h = makeDom(EN_PAGE('en'), { auto: true });
      let hHidden = true;
      Object.defineProperty(h.window.document, 'visibilityState', {
        configurable: true, get: () => (hHidden ? 'hidden' : 'visible')
      });
      await wait(900);
      chk('隐藏时一个请求都不发', h.stats.requests === 0, h.stats.requests + ' 批');

      hHidden = false;
      h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));
      await wait(900);
      chk('变为可见后自动翻译', h.stats.requests >= 1 && /译:Run All Cells/.test(bodyText(h.window)),
        h.stats.requests + ' 批');
    }
  }

  /* ---------- I) 自动模式不闪"翻译中"进度 ---------- */
  console.log('\n===== I) 自动模式不打扰（无进度提示）=====');
  {
    const { window } = makeDom(EN_PAGE('en'), { auto: true });
    let sawProgress = false;
    const t = setInterval(() => {
      const el = window.document.querySelector('.uizh-toast');
      if (el && String(el.textContent).includes('翻译中')) sawProgress = true;
    }, 30);
    await wait(900);
    clearInterval(t);
    chk('全程没出现"翻译中…"进度条', !sawProgress);
    const el = window.document.querySelector('.uizh-toast');
    chk('完成后有简短告知（含 Alt+T 停止）',
      !!el && String(el.textContent).includes('自动翻译') && String(el.textContent).includes('Alt+T'),
      el ? String(el.textContent) : '(无)');
  }

  /* ---------- J) 取消勾选后，当前页不该再跟新内容 ---------- */
  console.log('\n===== J) 关闭自动后停止跟随新内容 =====');
  {
    const { window, stats, send } = makeDom(EN_PAGE('en'), { auto: true });
    await wait(1100);
    const before = stats.requests;

    await send({ type: 'autoDisable' });

    const d = window.document.createElement('div');
    d.textContent = 'Brand New Menu Item';
    window.document.body.appendChild(d);
    await wait(1800);      // 观察器防抖窗口是 1200ms

    chk('关闭后新插内容没被翻', !/译:Brand New Menu Item/.test(bodyText(window)),
      bodyText(window).slice(-30));
    chk('关闭后没有新增请求', stats.requests === before, (stats.requests - before) + ' 批新增');
  }

  /* ---------- K) 对照：开着时应跟随新内容（证明 J 不是假通过） ---------- */
  console.log('\n===== K) 开着时确实会跟随新内容 =====');
  {
    const { window, stats } = makeDom(EN_PAGE('en'), { auto: true });
    await wait(1100);
    const before = stats.requests;

    const d = window.document.createElement('div');
    d.textContent = 'Another Menu Item';
    window.document.body.appendChild(d);
    await wait(1800);

    chk('开着时新内容被补翻', stats.requests > before, (stats.requests - before) + ' 批新增');
    chk('新内容确实出现了译文', /译:Another Menu Item/.test(bodyText(window)), bodyText(window).slice(-30));
  }

  console.log('\n' + pass + '/' + total + ' 通过');
  process.exit(pass === total ? 0 : 1);
})();
