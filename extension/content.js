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
    '.uizh-zh', '.uizh-tip', '.uizh-toast', '.uizh-pair', '.uizh-src',
    '.uizh-blk', '[data-uizh-done]'
  ].join(',');

  /* 抽取块内文字时要跳过的东西：脚本、图形，以及我们自己插进去的节点。
   * 注意这里不含 code/samp —— 段落里夹着的行内代码要原样留在句子里送翻，
   * 拆出去反而会把语义切断。 */
  const TEXT_SKIP_SEL = 'script,style,noscript,svg,math,canvas,.uizh-blk,.uizh-pair,.uizh-src,.uizh-zh,.uizh-tip,.uizh-toast';

  /* 这些元素本身就是独立控件，绝不能被「整块翻译」吞掉 */
  const CTRL_SEL = 'button,select,input,textarea,progress,meter,' +
    '[role="button"],[role="tab"],[role="menuitem"],[role="switch"],[role="checkbox"],[role="radio"]';

  /* 可以整块翻、且译文挂在下面的块级显示类型 */
  const BLOCK_DISP = new Set([
    'block', 'flow-root', 'list-item', 'table', 'table-row', 'table-row-group',
    'table-header-group', 'table-footer-group', 'table-cell', 'table-caption',
    'flex', 'inline-flex', 'grid', 'inline-grid', '-webkit-box', '-webkit-flex'
  ]);

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

  /* ---------- 单元收集：整块优先，行内兜底 ----------
   *
   * 老做法是「一个文本节点 = 一条待翻文本」。遇到 PubMed 这种
   * `<h1>Gut metabolism links <a>precision nutrition</a>, … <i>Drosophila melanogaster</i>.</h1>`
   * 的结构，一句话被拆成五六段各自去翻：译文彼此不连贯（"精度 营养"），
   * 每段还各套一层 inline-block 框，行高被撑爆、英文被裁掉。
   *
   * 新做法：
   *   · 容器内部全是行内内容（p / h1 / li / td / div …）→ 整个容器当成**一个**单元，
   *     译文作为块级元素挂在容器末尾，原文的行内标签一个都不动。
   *   · 容器里有块级子元素 / flex / grid 子项 / 独立控件 → 继续往下拆，逐个处理。
   *   · 剩下的零散文本节点（导航链接、按钮文案）→ 走原来的行内对照。
   */

  let dispCache = new Map();

  /* getComputedStyle 拿不到 display 时（元素未渲染 / 环境没有默认样式表）
   * 用标签名兜底，免得把 <span> 当成块级容器。 */
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN',
    'EM', 'FONT', 'I', 'IMG', 'INS', 'KBD', 'LABEL', 'MARK', 'NOBR', 'OUTPUT', 'Q',
    'RP', 'RT', 'RUBY', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP',
    'TIME', 'TT', 'U', 'VAR', 'WBR', 'BUTTON', 'SELECT', 'INPUT', 'TEXTAREA',
    'PROGRESS', 'METER', 'CANVAS', 'SVG', 'IFRAME', 'AUDIO', 'VIDEO', 'PICTURE'
  ]);

  function dispOf(el) {
    let d = dispCache.get(el);
    if (d === undefined) {
      try { d = getComputedStyle(el).display || ''; } catch (e) { d = ''; }
      if (!d) d = INLINE_TAGS.has(el.tagName) ? 'inline' : 'block';
      dispCache.set(el, d);
    }
    return d;
  }

  function isFlexGrid(d) {
    return d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid';
  }

  /* 把容器里所有可见文字拼成一个字符串（跳过脚本/图形/自己的译文节点），
   * <br> 视作空格。段落里的 <i> <a> <span> 会自然拼回完整句子。 */
  function textOf(root) {
    let s = '';
    const rec = (node) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { s += c.nodeValue; continue; }
        if (c.nodeType !== 1) continue;
        if (c.tagName === 'BR') { s += ' '; continue; }
        if (c.matches(TEXT_SKIP_SEL)) continue;
        rec(c);
      }
    };
    rec(root);
    return s.replace(/\s+/g, ' ').trim();
  }

  /* 内部是否已经有「需要单独处理的子项」 */
  function hasSeparateChild(el) {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (inSkip(c)) continue;
      if (!visOf(c)) continue;
      const d = dispOf(c);
      if (d === 'contents' || isFlexGrid(d) || BLOCK_DISP.has(d)) return true;
      if (c.matches(CTRL_SEL)) return true;
    }
    return false;
  }

  /* 只有一个元素子节点、且没有实质文字（li>a、div>a）→ 取出那个子节点 */
  function onlyChildElement(el) {
    let elem = null;
    for (let k = el.firstChild; k; k = k.nextSibling) {
      if (k.nodeType === 3) { if (k.nodeValue.trim()) return null; continue; }
      if (k.nodeType !== 1) continue;
      if (elem) return null;
      elem = k;
    }
    return elem;
  }

  /* 短文案 + 控件语境 → 保持行内对照（按钮、表头、导航项塞块级译文会撑坏布局） */
  const INLINE_HOST_SEL = 'a,button,nav,menu,label,th,td,dt,dd,option,summary,' +
    '[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="navigation"],[role="search"]';

  function preferInline(el, text, d) {
    if (/^inline/.test(d) && !isFlexGrid(d)) return true;   // 行内元素里放不下块级译文
    if (text.length > 40) return false;
    if (el.matches(INLINE_HOST_SEL)) return true;
    if (el.closest(INLINE_HOST_SEL)) return true;
    /* flex/grid 的子项在计算样式里会被 blockify（display 变 block），
     * 但短文案（"Open"/"Close" 这类）塞块级译文会把一行拆成两段，仍走行内对照。 */
    const p = el.parentElement;
    if (p && isFlexGrid(dispOf(p))) return true;
    return false;
  }

  function collectTextNodes(root, out, directOnly) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (directOnly && node.parentNode !== root) return NodeFilter.FILTER_REJECT;
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
    while ((n = walker.nextNode())) out.push({ kind: 'text', node: n, text: n.nodeValue });
  }

  function walkItem(el, out) {
    if (!el || el.nodeType !== 1) return;
    if (el.hasAttribute('data-uizh-done')) return;
    if (inSkip(el) || !visOf(el)) return;

    const d = dispOf(el);

    // 单子节点外壳（li>a、td>a）直接下沉，别把壳也算一个单元
    const single = onlyChildElement(el);
    if (single && !isFlexGrid(d) && !inSkip(single) && !single.matches(CTRL_SEL)) {
      return walkItem(single, out);
    }

    // 容器：块级子元素 / flex 子项 / 控件 → 逐个往下
    if (d === 'contents' || isFlexGrid(d) || hasSeparateChild(el)) {
      for (let c = el.firstElementChild; c; c = c.nextElementSibling) walkItem(c, out);
      collectTextNodes(el, out, true);       // 直接挂在容器下的裸文字
      return;
    }

    // 到这里：内部全是行内内容
    const text = textOf(el);
    if (!text) return;
    if (!worthTranslating(text) || preferInline(el, text, d)) {
      collectTextNodes(el, out, false);
      return;
    }
    /* 短文本 + 多个行内子元素：多是标签堆叠 / 无分隔的链接列表，
     * 整块拼起来会变成 "Save changesSave changes"，得逐个处理。 */
    if (text.length <= 40 && el.childElementCount >= 2) {
      for (let c = el.firstElementChild; c; c = c.nextElementSibling) walkItem(c, out);
      collectTextNodes(el, out, true);
      return;
    }
    out.push({ kind: 'block', el, text });
  }

  function collectUnits() {
    const out = [];
    if (document.body) walkItem(document.body, out);
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

  /* 长文本切分。
   * 实测（2026-11-12）：把整段 ~1000 字符一次送翻，译文连贯；
   * 而按 400 字符硬切会把句子从中间断开，引擎还会把「exercise. This」当成术语
   * 保护起来，吐出「适度 exercises.This组合的方法…」这种半英半中的结果。
   * 所以阈值放到 1200，超长文本才切，且只在句末切。 */
  const SEG_MAX = 1200;

  function hardSplit(s, max) {
    const out = [];
    let rest = s;
    while (rest.length > max) {
      let cut = -1;
      for (let i = max; i > max * 0.6; i--) {
        const c = rest[i];
        if (c === ',' || c === ';' || c === ' ' || c === '\t') { cut = i; break; }
      }
      if (cut < 0) cut = max;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  function splitLong(text) {
    if (text.length <= SEG_MAX) return [text];
    const parts = text.split(/(?<=[.!?;。！？；])\s+/);
    const out = [];
    let cur = '';
    for (const p of parts) {
      if (p.length > SEG_MAX) {                 // 单句就超长：按逗号/空格再切
        if (cur) { out.push(cur); cur = ''; }
        out.push(...hardSplit(p, SEG_MAX));
        continue;
      }
      if (cur && (cur.length + 1 + p.length) > SEG_MAX) { out.push(cur); cur = p; }
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

  /* 被 -webkit-line-clamp 截断的元素（搜索结果里的两行标题最常见）：
   * 译文塞进元素内部会被一并裁掉，必须放到元素的兄弟位置。 */
  function isClamped(el) {
    try {
      const cs = getComputedStyle(el);
      const lc = cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp') ||
        cs.getPropertyValue('line-clamp') || 'none';
      return !!lc && lc !== 'none' && lc !== '0' && lc !== 'normal';
    } catch (e) { return false; }
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
      dispCache = new Map();
      const units = collectUnits();
      const attrEls = collectAttrEls();
      visCache.clear();
      skipCache.clear();
      dispCache.clear();

      // 去重：同一段文字只翻一次
      const uniq = new Map();          // text -> refs[]
      const push = (text, ref) => {
        if (!uniq.has(text)) uniq.set(text, []);
        uniq.get(text).push(ref);
      };
      for (const u of units) {
        if (u.kind === 'block') push(u.text, { kind: 'block', el: u.el, text: u.text });
        else push(u.text, { kind: 'text', node: u.node, orig: u.text });
      }
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
      /* 分批时同时受「条数」和「总字符数」约束：
       * 整段译文动辄上千字符，40 条拼一批会撑爆接口的请求体，
       * 失败一次就是整批回退原文，所以按字符数也压一道。 */
      const maxChars = engine === 'llm' ? 12000 : 6000;
      const batches = [];
      for (let i = 0; i < total;) {
        let acc = 0, n = 0;
        while (i + n < total && n < chunkSize) {
          const len = flat[i + n].length + 1;
          if (n > 0 && acc + len > maxChars) break;
          acc += len; n++;
        }
        batches.push({ start: i, size: n });
        i += n;
      }
      const totalChunks = batches.length;

      let appeared = 0;
      let doneChunks = 0;
      let failChunks = 0;
      const toastStep = Math.max(1, Math.ceil(totalChunks / 10));
      if (!silent) toast('翻译中… 0/' + totalChunks);

      // 一段的译文全部到齐就立刻写回，不等其余批次
      const applyBlock = (ref, zh) => {
        const el = ref.el;
        if (!el || el.hasAttribute('data-uizh-done')) return;
        if (el !== document.body && !document.body.contains(el)) return;
        el.setAttribute('data-uizh-done', '1');
        // 用 span + display:block，避免往 <p>/<h1> 里塞 <div> 造成非法嵌套
        const zhEl = document.createElement('span');
        zhEl.className = 'uizh-blk';
        zhEl.textContent = zh;
        const parent = el.parentNode;
        const clamped = isClamped(el) && parent && parent !== el;
        if (bilingual) {
          if (clamped) parent.insertBefore(zhEl, el.nextSibling);
          else el.appendChild(zhEl);
          records.push({ kind: 'block', el, zhEl });
        } else if (clamped) {
          // 截断元素没法「藏内容」还保持高度，干脆整块收起，译文紧跟在后面
          parent.insertBefore(zhEl, el.nextSibling);
          const prev = el.style.display;
          el.style.display = 'none';
          records.push({ kind: 'block', el, zhEl, prevDisplay: prev });
        } else {
          // 仅译文：原文整包藏起来（结构、链接都留着，还原时原样搬回）
          const box = document.createElement('span');
          box.className = 'uizh-src-hidden';
          while (el.firstChild) box.appendChild(el.firstChild);
          el.appendChild(box);
          el.appendChild(zhEl);
          records.push({ kind: 'block', el, zhEl, box });
        }
        if (settings.hover) hoverMap.set(el, ref.text);
        appeared++;
      };

      const applyJob = (job) => {
        const pieces = job.got.map((v, si) => (v ? v : job.segs[si]));
        // 分段拼接：中文之间不留空格，中英之间留一个
        const zh = pieces.reduce((acc, p) => {
          if (!acc) return p;
          const a = acc.slice(-1), b = p.slice(0, 1);
          const cjk = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff01-\uff65]/;
          return (cjk.test(a) && cjk.test(b)) ? acc + p : acc + ' ' + p;
        }, '').replace(/\s+/g, ' ').trim();
        // 和原文比要用同一种规范化：原节点的 nodeValue 常带首尾空白/换行，
        // 直接比会把「英文原样返回」当成译文插进去，界面上就出现两行一样的英文。
        const srcNorm = String(job.key || '').replace(/\s+/g, ' ').trim();
        if (!zh || zh === srcNorm) return;
        // 原文有英文而译文一个汉字都没有 → 引擎把原文吐回来了，同样不写
        if (/[A-Za-z]{2}/.test(srcNorm) && !/[\u4e00-\u9fff\u3400-\u4dbf]/.test(zh)) return;
        const refs = uniq.get(job.key) || [];
        for (const ref of refs) {
          try {
            if (ref.kind === 'block') { applyBlock(ref, zh); continue; }
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
          const batch = batches[ci];
          const start = batch.start;
          const slice = flat.slice(start, start + batch.size);
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
        if (r.kind === 'block') {
          if (r.zhEl && r.zhEl.parentNode) r.zhEl.parentNode.removeChild(r.zhEl);
          if (r.box) {
            const host = r.box.parentNode;
            if (host) { while (r.box.firstChild) host.insertBefore(r.box.firstChild, r.box); }
            if (r.box.parentNode) r.box.parentNode.removeChild(r.box);
          }
          if (r.el) {
            if (r.prevDisplay !== undefined) r.el.style.display = r.prevDisplay;
            r.el.removeAttribute('data-uizh-done');
          }
          continue;
        }
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
    document.querySelectorAll('[data-uizh-done]').forEach(el => el.removeAttribute('data-uizh-done'));
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
