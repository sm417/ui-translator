/* 界面翻译 · popup */

const DEFAULTS = {
  engine: 'free',
  mode: 'bilingual',
  hover: true,
  auto: false,
  apiBase: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: ''
};

const $ = (id) => document.getElementById(id);
let state = { on: false };

function setStatus(text, isErr) {
  const el = $('status');
  el.textContent = text || '';
  el.className = isErr ? 'err' : '';
}

function syncUI(s) {
  $('engine').value = s.engine === 'llm' ? 'llm' : 'free';
  $('mode').value = s.mode === 'replace' ? 'replace' : 'bilingual';
  $('hover').checked = !!s.hover;
  $('auto').checked = !!s.auto;
  $('apiBase').value = s.apiBase || DEFAULTS.apiBase;
  $('model').value = s.model || DEFAULTS.model;
  $('apiKey').value = s.apiKey || '';
  $('llmBox').style.display = (s.engine === 'llm') ? 'block' : 'none';
}

function readUI() {
  return {
    engine: $('engine').value,
    mode: $('mode').value,
    hover: $('hover').checked,
    auto: $('auto').checked,
    apiBase: $('apiBase').value.trim() || DEFAULTS.apiBase,
    model: $('model').value.trim() || DEFAULTS.model,
    apiKey: $('apiKey').value.trim()
  };
}

async function save() {
  await chrome.storage.sync.set(readUI());
  syncUI(readUI());
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function rawSend(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return resolve({ ok: false, error: err.message, noReceiver: true });
      resolve(res || { ok: false, error: '无响应', noReceiver: true });
    });
  });
}

/* 页面若是在扩展安装/更新之前打开的，里面没有 content script。
 * 这里按需补注入一次（content.js 自带 __UIZH__ 守卫，重复注入无副作用）。 */
const injectedTabs = new Set();

async function injectContentScript(tabId) {
  if (!injectedTabs.has(tabId)) {
    try { await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }); } catch (e) { }
    injectedTabs.add(tabId);
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function sendToTab(tabId, msg) {
  let res = await rawSend(tabId, msg);
  if (res.ok || !res.noReceiver) return res;

  // 本来就没有可还原的东西，直接算成功
  if (msg.type === 'restore') return { ok: true, silent: true };

  try {
    await injectContentScript(tabId);
  } catch (e) {
    return {
      ok: false,
      error: '这个页面不允许扩展注入脚本（应用商店、PDF 阅读器等），换普通网页再试'
    };
  }
  return await rawSend(tabId, msg);
}

async function refreshButton() {
  const tab = await activeTab();
  if (!tab || !tab.id || !/^https?:|^file:/.test(tab.url || '')) {
    setStatus('这个页面不支持翻译（chrome:// 或扩展页）', true);
    $('btn').disabled = true;
    return;
  }
  $('btn').disabled = false;
  const res = await sendToTab(tab.id, { type: 'status' });
  state.on = !!(res && res.ok && res.on);
  $('btn').textContent = state.on ? '还原原文' : '翻译此页';
  $('btn').className = 'main' + (state.on ? ' off' : '');
}

$('btn').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab || !tab.id) return;
  $('btn').disabled = true;
  setStatus(state.on ? '正在还原…' : '正在翻译，稍等…');
  const res = await sendToTab(tab.id, { type: state.on ? 'restore' : 'run' });
  if (res.ok) {
    if (state.on) {
      setStatus('已还原，自动翻译已停');
    } else {
      setStatus('完成，共 ' + (res.translated || 0) + ' 处' +
        (res.autoOn ? ' · 之后新页面会自动翻' : ''));
    }
  } else {
    setStatus(res.error || '失败', true);
  }
  $('btn').disabled = false;
  await refreshButton();
  syncUI(await chrome.storage.sync.get(DEFAULTS));   // 自动开关可能在页面里被改过
});

$('engine').addEventListener('change', async () => {
  $('llmBox').style.display = $('engine').value === 'llm' ? 'block' : 'none';
  await save();
  const t = readUI();
  if (t.engine === 'llm' && !t.apiKey) {
    setStatus('大模型模式需要先填 API Key', true);
  } else {
    setStatus('已切换引擎，重新点「翻译此页」生效');
  }
});

['mode', 'hover', 'auto', 'apiBase', 'model', 'apiKey'].forEach((id) => {
  $(id).addEventListener('change', async () => {
    await save();

    if (id === 'auto') {
      if ($('auto').checked) {
        const tab = await activeTab();
        if (tab && tab.id) {
          setStatus('正在开启自动翻译…');
          const res = await sendToTab(tab.id, { type: 'autoEnable' });
          if (res.ok) {
            setStatus('已开启：之后新打开的页面会自动翻译');
            await refreshButton();
          } else {
            setStatus(res.error || '开启失败', true);
          }
        } else {
          setStatus('已开启：之后新打开的页面会自动翻译');
        }
      } else {
        const tab = await activeTab();
        if (tab && tab.id) await sendToTab(tab.id, { type: 'autoDisable' });
        setStatus('已关闭：新页面不再自动翻译（当前页保持原样）');
      }
      return;
    }

    if (id === 'apiKey' || id === 'apiBase' || id === 'model') setStatus('已保存');
  });
});

$('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  setStatus('翻译缓存已清空');
});

(async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  syncUI(s);
  await refreshButton();
})();
