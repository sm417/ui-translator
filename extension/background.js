/* 界面翻译 · background service worker
 * 网络请求全部在这里做（绕开页面的 CSP / CORS），并做本地缓存。
 *
 * 引擎 1：free —— 腾讯交互翻译（transmart），免 key、支持批量、国内直连
 * 引擎 2：llm  —— 任意 OpenAI 兼容接口（默认 DeepSeek），质量最好
 *
 * 2026-11-11 实测：
 *   transmart          批量 60 条 3.5s，通过
 *   edge/bing 免费接口  已下线（HTTP 404），弃用
 *   google translate   国内不可达，弃用
 *   有道 aidemo        可用，作为单条兜底
 */

const DEFAULTS = {
  engine: 'free',
  mode: 'bilingual', // bilingual | replace
  hover: true,
  apiBase: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  auto: false,
  target: 'zh'
};

const CACHE_KEY = 'uizh_cache_v1';
const CACHE_MAX = 6000;
// 注意：浏览器禁止脚本设置 User-Agent / Referer 请求头（会被静默丢弃）。
// 2026-11-11 实测该接口不依赖这两个头，故只用合法的 referrer 选项。

let cache = Object.create(null);
let cacheDirty = false;
let cacheLoaded = false;

async function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const got = await chrome.storage.local.get(CACHE_KEY);
    if (got && got[CACHE_KEY]) cache = got[CACHE_KEY];
  } catch (e) { /* ignore */ }
}

function scheduleFlush() {
  if (!cacheDirty) return;
  cacheDirty = false;
  clearTimeout(scheduleFlush._t);
  scheduleFlush._t = setTimeout(async () => {
    try {
      const keys = Object.keys(cache);
      if (keys.length > CACHE_MAX) {
        for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
      }
      await chrome.storage.local.set({ [CACHE_KEY]: cache });
    } catch (e) { /* ignore */ }
  }, 2000);
}

async function getSettings() {
  const got = await chrome.storage.sync.get(DEFAULTS);
  return Object.assign({}, DEFAULTS, got);
}

/* ================= 免费引擎：腾讯交互翻译 ================= */

/* 单次调用。ret_code 除了 succ 还会返回 busy（并发排队），
 * 这不是失败，重试一次基本就过。 */
async function transmartOnce(texts) {
  const body = {
    header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0' },
    type: 'plain',
    model_category: 'normal',
    text_domain: 'general',
    source: { lang: 'en', text_list: texts },
    target: { lang: 'zh' }
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let r;
  try {
    r = await fetch('https://transmart.qq.com/api/imt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      referrer: 'https://transmart.qq.com/',
      referrerPolicy: 'unsafe-url',
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error('transmart HTTP ' + r.status);
  const d = await r.json();
  const code = d && d.header && d.header.ret_code;
  if (code !== 'succ') throw new Error('transmart 返回 ' + (code || '未知错误'));
  const arr = d.auto_translation;
  if (!Array.isArray(arr)) throw new Error('transmart 返回格式异常');
  if (arr.length !== texts.length) throw new Error('transmart 条数不匹配 ' + arr.length + '/' + texts.length);
  return arr.map((v, i) => (typeof v === 'string' && v.trim() ? v : texts[i]));
}

/* 带重试的调用：busy 与网络抖动退避重试，不直接判定失败 */
async function transmart(texts, tries) {
  const max = tries || 3;
  let lastErr = null;
  for (let a = 0; a < max; a++) {
    try {
      return await transmartOnce(texts);
    } catch (e) {
      lastErr = e;
      const m = String((e && e.message) || '');
      // 参数类错误重试无用，直接抛
      if (/条数不匹配|格式异常|HTTP 4(0[0134]|22)/.test(m)) throw e;
      if (a < max - 1) await new Promise(res => setTimeout(res, 300 * Math.pow(2, a)));
    }
  }
  throw lastErr || new Error('transmart 失败');
}

/* 兜底：有道 demo 单条接口（只在小批量、transmart 彻底失败时用） */
async function youdaoOne(text) {
  const r = await fetch('https://aidemo.youdao.com/trans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: text, from: 'Auto', to: 'zh-CHS' })
  });
  if (!r.ok) throw new Error('youdao HTTP ' + r.status);
  const d = await r.json();
  const t = d && d.translation && d.translation[0];
  if (!t) throw new Error('youdao 无译文');
  return t;
}

/* 有道兜底：小批量并发 3 条一路跑，绝不逐条串行（60 条串行要 36 秒） */
async function youdaoBatch(texts) {
  const out = texts.slice();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= texts.length) return;
      try { out[i] = await youdaoOne(texts[i]); } catch (e) { /* 保留原文 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, texts.length) }, worker));
  return out;
}

async function freeTranslate(texts) {
  try {
    return await transmart(texts, 3);
  } catch (e) {
    // 整批不行 → 拆半再试一轮（多半是个别长句把整批拖垮）
    if (texts.length > 8) {
      const mid = Math.floor(texts.length / 2);
      const halves = [texts.slice(0, mid), texts.slice(mid)];
      const res = await Promise.all(halves.map(async (h) => {
        try {
          return await transmart(h, 2);
        } catch (e2) {
          return h.length <= 8 ? await youdaoBatch(h) : h.slice();
        }
      }));
      const merged = res[0].concat(res[1]);
      if (merged.some((v, i) => v !== texts[i])) return merged;
      throw e;
    }
    return await youdaoBatch(texts);
  }
}

/* ================= LLM 引擎（OpenAI 兼容） ================= */

const SYSTEM_PROMPT = [
  '你是专业的软件界面本地化译者。把用户给出的 JSON 字符串数组逐条翻译成简体中文。硬性规则：',
  '1. 只输出一个 JSON 数组，长度与输入完全一致，不要任何解释、不要代码块围栏；',
  '2. 保留占位符（{0} %s %d ${x}）、快捷键（Ctrl+S）、文件路径、URL、版本号、代码标识符原样不动；',
  '3. 按软件界面惯例选词：Run→运行，Cell→单元格，Kernel→内核，Environment→环境，Terminal→终端，',
  '   Extension→扩展，Package→包，Notebook→笔记本，Dataset→数据集，Pipeline→流水线；',
  '4. 按钮/菜单等短标签保持简短（≤4 个汉字），不要加句号；',
  '5. 已经是中文的条目原样返回；纯数字、纯符号也原样返回。'
].join('\n');

function stripFence(s) {
  let t = String(s || '').trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) t = m[1].trim();
  const a = t.indexOf('[');
  const b = t.lastIndexOf(']');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}

async function llmTranslate(texts, cfg) {
  if (!cfg.apiKey) throw new Error('还没填大模型 API Key（在扩展弹窗里填）');
  const base = String(cfg.apiBase || DEFAULTS.apiBase).replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const payload = {
    model: cfg.model || 'deepseek-chat',
    temperature: 0,
    stream: false,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(texts) }
    ]
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(payload)
      });
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error('HTTP ' + r.status);
        await new Promise(res => setTimeout(res, 900 * (attempt + 1)));
        continue;
      }
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 160));
      }
      const data = await r.json();
      const content = data && data.choices && data.choices[0] &&
        data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('模型没有返回内容');
      const arr = JSON.parse(stripFence(content));
      if (!Array.isArray(arr)) throw new Error('模型返回的不是数组');
      if (arr.length !== texts.length) {
        return texts.map((t, i) => (typeof arr[i] === 'string' && arr[i].trim() ? arr[i] : t));
      }
      return arr.map((v, i) => (typeof v === 'string' && v.trim() ? v : texts[i]));
    } catch (e) {
      lastErr = e;
      if (/^HTTP 4/.test(String(e.message || ''))) break;
      await new Promise(res => setTimeout(res, 600 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('大模型翻译失败');
}

/* ================= 主入口 ================= */

function cacheKey(engine, model, text) {
  return (engine === 'llm' ? 'L|' + model : 'F') + '|' + text;
}

async function handleTranslate(texts, cfg) {
  const out = new Array(texts.length);
  const todo = [];
  const todoIdx = [];

  for (let i = 0; i < texts.length; i++) {
    const hit = cache[cacheKey(cfg.engine, cfg.model, texts[i])];
    if (typeof hit === 'string') out[i] = hit;
    else { todo.push(texts[i]); todoIdx.push(i); }
  }
  if (!todo.length) return { ok: true, results: out, cached: texts.length };

  const translated = cfg.engine === 'llm'
    ? await llmTranslate(todo, cfg)
    : await freeTranslate(todo);

  for (let k = 0; k < translated.length; k++) {
    const i = todoIdx[k];
    out[i] = translated[k];
    cache[cacheKey(cfg.engine, cfg.model, todo[k])] = translated[k];
    cacheDirty = true;
  }
  scheduleFlush();
  return { ok: true, results: out, cached: texts.length - todo.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) return sendResponse({ ok: false, error: 'bad message' });
      if (msg.type === 'translate') {
        await loadCache();
        const cfg = await getSettings();
        if (msg.engine) cfg.engine = msg.engine;
        sendResponse(await handleTranslate(msg.texts || [], cfg));
      } else if (msg.type === 'getSettings') {
        sendResponse({ ok: true, settings: await getSettings() });
      } else if (msg.type === 'clearCache') {
        cache = Object.create(null);
        await chrome.storage.local.remove(CACHE_KEY);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'unknown type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch (e) { /* 页面上没有 content script */ }
});
