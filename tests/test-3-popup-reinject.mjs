// 弹窗自检：页面在扩展安装前打开（收不到消息）时，应自动注入脚本并重试
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const EXT = fileURLToPath(new URL('../extension/', import.meta.url));
const html = fs.readFileSync(EXT + '/popup.html', 'utf8')
  .replace('<script src="popup.js"></script>', '');
const popupJs = fs.readFileSync(EXT + '/popup.js', 'utf8');
const contentJs = fs.readFileSync(EXT + '/content.js', 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

let sendCount = 0;
let execCount = 0;
let cssCount = 0;
let failedFirst = false;

window.chrome = {
  runtime: {
    lastError: null,
    sendMessage: () => Promise.resolve({ ok: true }),
    onMessage: { addListener: () => { } }
  },
  storage: {
    sync: {
      get: () => Promise.resolve({
        engine: 'free', mode: 'replace', hover: true, auto: false,
        apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: ''
      }),
      set: () => Promise.resolve()
    }
  },
  tabs: {
    query: () => Promise.resolve([{ id: 7, url: 'https://github.com/orgs/demo/issues' }]),
    sendMessage: (tabId, msg, cb) => {
      sendCount++;
      if (!failedFirst) {
        // 第一次：模拟"扩展刚装好，页面里没有 content script"
        failedFirst = true;
        window.chrome.runtime.lastError = {
          message: 'Could not establish connection. Receiving end does not exist.'
        };
        cb(undefined);
        window.chrome.runtime.lastError = null;
        return;
      }
      cb({ ok: true, on: false });
    }
  },
  scripting: {
    insertCSS: async () => { cssCount++; return []; },
    executeScript: async (opts) => {
      execCount++;
      // 真把 content.js 注入进同一个 window，模拟真实补注入
      window.eval(contentJs);
      return [{ result: null }];
    }
  }
};

window.eval(popupJs);
await new Promise(r => setTimeout(r, 400));

const btn = window.document.getElementById('btn');
const status = window.document.getElementById('status').textContent;

const checks = [
  ['第一次发送失败（模拟成立）', failedFirst === true],
  ['自动补注入了一次 content.js', execCount === 1],
  ['补注入时带上样式表', cssCount === 1],
  ['重试后共发送 2 次消息', sendCount === 2],
  ['按钮没有被禁用', btn.disabled === false],
  ['状态栏不再显示英文报错', !/Receiving end|Could not establish/i.test(status)],
  ['按钮文字正常', btn.textContent.trim() === '翻译此页']
];

console.log('sendCount =', sendCount, '| execCount =', execCount, '| cssCount =', cssCount);
console.log('status =', JSON.stringify(status));
console.log('');
let pass = 0;
for (const [n, ok] of checks) { console.log((ok ? '  PASS  ' : '  FAIL  ') + n); if (ok) pass++; }
console.log('\n' + pass + '/' + checks.length + ' 通过');
process.exit(pass === checks.length ? 0 : 1);
