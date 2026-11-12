/* 界面翻译 · content script
 * 只挑「界面文本」送翻译：跳过 code / pre / kbd / 编辑器 / contenteditable，
 * 已经是中文的不动，纯符号和数字不动。
 */
(() => {
  if (window.__UIZH__) return;
  window.__UIZH__ = { on: false };

  const SKIP_SEL = [
    'script', 'style', 'noscript', 'code', 'pre', 'kbd', 'samp', 'textarea',
    'svg', 'math', 'canvas',
    '.CodeMirror', '.cm-editor', '.cm-content', '.monaco-editor',
    '.jp-InputArea .cm-editor', '.jp-Cell-inputWrapper .cm-editor',
    '[contenteditable="true"]', '[contenteditable=""]',
    '.uizh-zh', '.uizh-tip', '.uizh-toast', '.uizh-pair', '.uizh-src'
  ].join(',');

  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const ATTR_SEL = ATTRS.map(a => '[' + a + ']').join(',');
  const records = [];        // { node, orig, zhEl }
  let doneNodes = new WeakSet();
  const hoverMap = new WeakMap();

  // 扫描期的缓存：同一个父元素常被多个文本节点共享，避免重复 getComputedStyle / closest
  let visCache = new Map();
  let skipCache = new Map();

  const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/g;

  function cjkRatio(s) {
    const solid = s.replace(/\s+/g, '');
    if (!solid) return 0;
    const m = solid.match(CJK);
    return m ? m.length / solid.length : 0;
  }

  function worthTranslating(s) {
    const t = s.trim();
    if (!t) return false;
    if (t.length < 2) return false;
    const latin = t.match(/[A-Za-z]/g);
    if (!latin || latin.length < 2) return false;
    if (cjkRatio(t) > 0.35) return false;          // 已经是中文
    if (/^[\s\d\p{P}\p{S}]+$/u.test(t)) return false; // 纯数字/符号
    return true;
  }

  function isVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    return true;
  }

  function visOf(el) {
    let v = visCache.get(el);
    if (v === undefined) { v = isVisible(el); visCache.set(el, v); }
    return v;
  }

  function inSkip(el) {
    let v = skipCache.get(el);
    if (v === undefined) { v = !!el.closest(SKIP_SEL); skipCache.set(el, v); }
    return v;
  }

  function collectTextNodes() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (doneNodes.has(node)) return NodeFilter.FILTER_REJECT;
        const t = node.nodeValue;
        if (!t || t.length < 2 || !worthTranslating(t)) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (inSkip(p)) return NodeFilter.FILTER_REJECT;
        if (!visOf(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function collectAttrEls() {
    const out = [];
    // 一次遍历拿全部四类属性，原来四个属性各扫一遍整棵树
    const list = document.body.querySelectorAll(ATTR_SEL);
    for (const el of list) {
      if (el.hasAttribute('data-uizh-attr')) continue;
      for (const attr of ATTRS) {
        if (!el.hasAttribute(attr)) continue;
        const v = el.getAttribute(attr);
        if (!v || !worthTranslating(v)) continue;
        if (inSkip(el)) break;
        if (!visOf(el)) continue;
        out.push({ el, attr, value: v });
      }
    }
    return out;
  }

  function splitLong(text) {
    if (text.length <= 400) return [text];
    const parts = text.split(/(?<=[.!?;。！？；])\s+/);
    const out = [];
    let cur = '';
    for (const p of parts) {
      if (cur && (cur.length + 1 + p.length) > 400) { out.push(cur); cur = p; }
      else cur = cur ? cur + ' ' + p : p;
    }
    if (cur) out.push(cur);
    return out.length ? out : [text];
  }

  /* ---------- UI 提示 ---------- */

  function toast(text, ms) {
    let el = document.querySelector('.uizh-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'uizh-toast';
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.style.opacity = '0'; }, ms || 1600);
  }

  function ensureTip() {
    let tip = document.querySelector('.uizh-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'uizh-tip';
      document.documentElement.appendChild(tip);
    }
    return tip;
  }

  document.addEventListener('mouseover', (e) => {
    if (!window.__UIZH__.on) return;
    const tip = ensureTip();
    let el = e.target;
    let orig = null;
    while (el && el !== document.body) {
      const v = hoverMap.get(el);
      if (v) { orig = v; break; }
      el = el.parentElement;
    }
    if (!orig) { tip.style.opacity = '0'; return; }
    tip.textContent = orig;
    const r = (el || e.target).getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - 20, Math.max(8, r.left)) + 'px';
    tip.style.top = Math.min(window.innerHeight - 40, r.bottom + 6) + 'px';
    tip.style.opacity = '1';
  }, true);

  /* ---------- 网络 ---------- */

  function ask(texts, engine) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; reject(new Error('翻译超时（30 秒）')); }
      }, 30000);
      try {
        chrome.runtime.sendMessage({ type: 'translate', texts, engine }, (res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message || '扩展后台失联，请刷新页面'));
          if (!res) return reject(new Error('后台无响应'));
          if (!res.ok) return reject(new Error(res.error || '翻译失败'));
          resolve(res.results);
        });
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      }
    });
  }

  /* ---------- 主流程 ---------- */

  async function translatePage(settings, opts) {
    const o = opts || {};
    const silent = !!o.silent;          // 自动触发：不闪进度提示
    if (window.__UIZH__.busy) return { translated: 0 };
    window.__UIZH__.busy = true;
    const tStart = Date.now();

    const engine = settings.engine || 'free';
    const bilingual = settings.mode === 'bilingual';
    // 实测（2026-11-11）：transmart 吞吐约 12~15ms/条且几乎与批大小无关，
    // 提速靠并发。并发 6 / 批次 40 跑 300 条约 3.5s，400 条稳定不触发 busy。
    // 自动模式可能同时有多个标签页在跑，压低到 4 避免一起撞 busy。
    const chunkSize = engine === 'llm' ? 20 : 40;
    const conc = engine === 'llm' ? 3 : (silent ? 4 : 6);

    try {
      visCache = new Map();
      skipCache = new Map();
      const nodes = collectTextNodes();
      const attrEls = collectAttrEls();
      visCache.clear();
      skipCache.clear();

      // 去重：同一段文字只翻一次
      const uniq = new Map();          // text -> refs[]
      const push = (text, ref) => {
        if (!uniq.has(text)) uniq.set(text, []);
        uniq.get(text).push(ref);
      };
      for (const n of nodes) push(n.nodeValue, { kind: 'text', node: n, orig: n.nodeValue });
      for (const a of attrEls) push(a.value, { kind: 'attr', el: a.el, attr: a.attr, orig: a.value });

      const keys = Array.from(uniq.keys());
      if (!keys.length) {
        if (!silent && !window.__UIZH__.on) toast('这页没找到需要翻译的界面文字');
        return { translated: 0 };
      }

      // 拆长句
      const jobs = keys.map((k) => ({ key: k, segs: splitLong(k) }));
      const flat = [];
      const flatJob = [];              // flat 下标 -> job 下标
      for (let ji = 0; ji < jobs.length; ji++) {
        const j = jobs[ji];
        j.base = flat.length;
        j.remain = j.segs.length;
        j.got = new Array(j.segs.length).fill(null);
        for (const s of j.segs) { flat.push(s); flatJob.push(ji); }
      }

      const total = flat.length;
      const starts = [];
      for (let i = 0; i < total; i += chunkSize) starts.push(i);
      const totalChunks = starts.length;

      let appeared = 0;
      let doneChunks = 0;
      let failChunks = 0;
      const toastStep = Math.max(1, Math.ceil(totalChunks / 10));
      if (!silent) toast('翻译中… 0/' + totalChunks);

      // 一段的译文全部到齐就立刻写回，不等其余批次
      const applyJob = (job) => {
        const pieces = job.got.map((v, si) => (v ? v : job.segs[si]));
        const zh = pieces.join(' ').replace(/\s+/g, ' ').trim();
        if (!zh || zh === job.key) return;
        const refs = uniq.get(job.key) || [];
        for (const ref of refs) {
          try {
            if (ref.kind === 'text') {
              const node = ref.node;
              if (!node.parentNode) continue;
              if (!bilingual) {
                doneNodes.add(node);
                node.nodeValue = zh;
                records.push({ node, orig: ref.orig, zhEl: null });
                if (settings.hover && node.parentElement) hoverMap.set(node.parentElement, ref.orig);
              } else {
                /* 中英对照：原文与译文包进同一个 inline-block 容器，
                 * 在 flex 容器里也只占一个位置，不会把译文甩到右边。 */
                const parent = node.parentNode;
                const pair = document.createElement('span');
                pair.className = 'uizh-pair';
                const src = document.createElement('span');
                src.className = 'uizh-src';
                const zhEl = document.createElement('span');
                zhEl.className = 'uizh-zh';
                zhEl.textContent = zh;
                parent.insertBefore(pair, node);
                src.appendChild(node);        // 原 Text 节点整体搬进 src
                pair.appendChild(src);
                pair.appendChild(zhEl);
                doneNodes.add(node);
                records.push({ node, orig: ref.orig, zhEl: null, pair });
              }
              appeared++;
            } else {
              ref.el.setAttribute('data-uizh-attr', ref.attr);
              ref.el.setAttribute('data-uizh-attr-orig', ref.orig);
              ref.el.setAttribute(ref.attr, zh);
              appeared++;
            }
          } catch (e) { /* 单个节点失败不中断 */ }
        }
      };

      // 工作池：conc 条流水线同时跑，谁先空谁去领下一批
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const ci = cursor++;
          if (ci >= totalChunks) return;
          const start = starts[ci];
          const slice = flat.slice(start, start + chunkSize);
          let results;
          try {
            results = await ask(slice, engine);
          } catch (e) {
            // 一批失败不拖垮整页：这批保留原文，继续领下一批
            results = slice.slice();
            failChunks++;
          }
          for (let k = 0; k < results.length; k++) {
            const fi = start + k;
            const job = jobs[flatJob[fi]];
            job.got[fi - job.base] = results[k];
            if (--job.remain === 0) applyJob(job);
          }
          doneChunks++;
          if (!silent && (doneChunks % toastStep === 0 || doneChunks === totalChunks)) {
            toast('翻译中… ' + doneChunks + '/' + totalChunks);
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(conc, totalChunks) }, () => worker())
      );

      const sec = ((Date.now() - tStart) / 1000).toFixed(1);
      window.__UIZH__.on = true;

      // 用户主动翻了一次 → 顺带打开自动模式，之后新页面自己翻
      const turnOnAuto = !!o.fromUser && appeared > 0;
      if (turnOnAuto) writeAuto(true);

      if (silent) {
        toast('已自动翻译 ' + appeared + ' 处 · Alt+T 停止自动', 2200);
      } else if (failChunks) {
        toast('已翻译 ' + appeared + ' 处，' + failChunks + ' 批失败（保留原文）· ' + sec + 's', 2800);
      } else {
        toast('已翻译 ' + appeared + ' 处' + (bilingual ? '（双语）' : '') + ' · ' + sec + 's · ' +
          (turnOnAuto ? '之后新页面自动翻，Alt+T 关闭' : 'Alt+T 还原'), 2600);
      }
      startObserver(settings);
      return { translated: appeared, autoOn: turnOnAuto };
    } finally {
      window.__UIZH__.busy = false;
    }
  }

  function restore() {
    for (const r of records) {
      try {
        if (r.pair) {
          // 对照模式：把原 Text 节点搬回原位，再丢掉包壳
          const host = r.pair.parentNode;
          if (host) host.insertBefore(r.node, r.pair);
          if (r.pair.parentNode) r.pair.parentNode.removeChild(r.pair);
        }
        if (r.zhEl && r.zhEl.parentNode) r.zhEl.parentNode.removeChild(r.zhEl);
        if (r.node) r.node.nodeValue = r.orig;
      } catch (e) { /* ignore */ }
    }
    records.length = 0;
    doneNodes = new WeakSet();
    document.querySelectorAll('[data-uizh-attr]').forEach(el => {
      const attr = el.getAttribute('data-uizh-attr');
      const orig = el.getAttribute('data-uizh-attr-orig');
      if (attr && orig !== null) el.setAttribute(attr, orig);
      el.removeAttribute('data-uizh-attr');
      el.removeAttribute('data-uizh-attr-orig');
    });
    window.__UIZH__.on = false;
    stopObserver();
  }

  /* ---------- 动态页面：新内容自动补翻 ---------- */

  let observer = null;
  let obsTimer = null;

  function startObserver(settings) {
    if (!settings.auto) return;
    stopObserver();
    observer = new MutationObserver(() => {
      clearTimeout(obsTimer);
      obsTimer = setTimeout(() => {
        if (!window.__UIZH__.on || window.__UIZH__.busy) return;
        translatePage(settings, { silent: true });
      }, 1200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    clearTimeout(obsTimer);
  }

  /* ---------- 自动模式：切到新页面也自动翻 ---------- */

  /* 守门人：不主动去翻中文/日韩站点，免得每开一页都白扫一遍 DOM。
   * lang 明确是英文的直接放行，省掉采样开销。 */
  function looksEnglishPage() {
    const lang = String(document.documentElement.lang || '').toLowerCase();
    if (lang.startsWith('en')) return true;
    if (/^(zh|ja|ko|ru|ar|he|th|vi)/.test(lang)) return false;

    const body = document.body;
    if (!body) return false;

    /* 采样前若干文本节点，而不是 body.innerText ——
     * innerText 会强制整页重新布局，大页面上要上百毫秒。 */
    let chars = 0, latin = 0, cjk = 0, seen = 0;
    const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('script,style,noscript')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = w.nextNode()) && chars < 3000 && seen < 4000) {
      seen++;
      const t = n.nodeValue || '';
      chars += t.length;
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) latin++;
        else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
      }
    }
    if (chars < 20) return false;          // 页面上几乎没字
    if (latin < 40) return false;          // 几乎没有英文
    if (cjk > latin * 0.5) return false;   // 中日韩占主导
    return true;
  }

  async function readSettings() {
    return chrome.storage.sync.get({
      engine: 'free', mode: 'bilingual', hover: true, auto: false
    });
  }

  let booted = false;

  async function autoBoot() {
    if (booted || window.__UIZH__.on || window.__UIZH__.busy) return;
    let got;
    try { got = await readSettings(); } catch (e) { return; }
    if (!got || !got.auto) return;

    // 后台标签页先不翻：一次恢复十来个标签时不会同时打出几十个请求
    if (document.visibilityState === 'hidden') {
      const onShow = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', onShow);
        autoBoot();
      };
      document.addEventListener('visibilitychange', onShow);
      return;
    }

    if (booted) return;
    booted = true;

    // 等首屏渲染：SPA（JupyterLab / GitHub）此刻 DOM 往往还是空的
    await new Promise(r => setTimeout(r, 400));
    if (window.__UIZH__.on || window.__UIZH__.busy) return;
    if (!looksEnglishPage()) return;

    try {
      await translatePage(got, { silent: true, fromUser: false });
    } catch (e) { /* 自动模式失败就安静地留着原文 */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { setTimeout(autoBoot, 0); }, { once: true });
  } else {
    setTimeout(autoBoot, 0);
  }

  /* 关掉全局自动开关。按 Alt+T 还原、或点「还原原文」，都是「停」的意思。 */
  function stopAuto() {
    writeAuto(false);
  }

  /* storage.sync.set 是异步的，配额满时会 reject —— 外层 try 接不住，
   * 这里显式吞掉，免得控制台飘 unhandled rejection。 */
  function writeAuto(v) {
    try {
      const p = chrome.storage.sync.set({ auto: v });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* ignore */ }
  }

  /* ---------- 消息 ---------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === 'run') {
          const got = await readSettings();
          const r = await translatePage(got, { fromUser: true });
          sendResponse({ ok: true, translated: r.translated, autoOn: !!r.autoOn });
        } else if (msg.type === 'restore') {
          restore();
          stopAuto();
          sendResponse({ ok: true });
        } else if (msg.type === 'toggle') {
          if (window.__UIZH__.on) {
            restore();
            stopAuto();
            sendResponse({ ok: true, on: false });
          } else {
            const got = await readSettings();
            const r = await translatePage(got, { fromUser: true });
            sendResponse({ ok: true, on: true, translated: r.translated, autoOn: !!r.autoOn });
          }
        } else if (msg.type === 'autoEnable') {
          // 弹窗里勾上「自动翻译新页面」：当前页也立即生效
          const got = await readSettings();
          booted = true;
          if (window.__UIZH__.on) {
            startObserver(got);
            sendResponse({ ok: true, on: true, translated: 0 });
          } else {
            const r = await translatePage(got, { silent: true, fromUser: false });
            sendResponse({ ok: true, on: true, translated: r.translated });
          }
        } else if (msg.type === 'autoDisable') {
          // 弹窗里取消勾选：当前页立刻停止观察，不再跟新内容
          stopObserver();
          sendResponse({ ok: true });
        } else if (msg.type === 'status') {
          sendResponse({ ok: true, on: window.__UIZH__.on, count: records.length });
        } else {
          sendResponse({ ok: false, error: 'unknown' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  });
})();
