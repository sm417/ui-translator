// 基准测试：transmart 的「批大小 vs 延迟」以及「并发是否被限流」
const URL = 'https://transmart.qq.com/api/imt';

function mkTexts(n) {
  const base = [
    'Run All Cells', 'Restart Kernel', 'Clear All Outputs', 'Files', 'Commands',
    'Running Terminals and Kernels', 'Environment', 'Package', 'Notebook',
    'Dataset', 'Pipeline', 'Extension', 'Terminal', 'Settings', 'Open Folder',
    'Save As', 'Export Notebook', 'Toggle Sidebar', 'Line Numbers', 'Word Wrap',
    'Git Panel', 'Source Control', 'Debug Console', 'Variables', 'Outline',
    'Table of Contents', 'Insert Cell Below', 'Delete Cell', 'Move Cell Up',
    'Split Cell', 'Merge Selected Cells', 'Find and Replace', 'Command Palette'
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = base[i % base.length];
    out.push(i < base.length ? s : s + ' ' + Math.floor(i / base.length + 1));
  }
  return out;
}

async function call(texts, timeout = 30000) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0' },
        type: 'plain', model_category: 'normal', text_domain: 'general',
        source: { lang: 'en', text_list: texts }, target: { lang: 'zh' }
      }),
      signal: ctrl.signal
    });
    const d = await r.json();
    const ms = Date.now() - t0;
    const code = d && d.header && d.header.ret_code;
    const n = (d.auto_translation || []).length;
    return { ok: r.ok && code === 'succ', status: r.status, code, ms, got: n, want: texts.length };
  } catch (e) {
    return { ok: false, code: 'EXC ' + e.message, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

const line = (r, tag) => {
  const per = r.ms / (r.want || 1);
  console.log(
    tag.padEnd(22),
    r.ok ? 'OK ' : 'FAIL',
    String(r.status || '').padEnd(4),
    String(r.ms + 'ms').padStart(7),
    ('n=' + (r.got || 0) + '/' + r.want).padEnd(9),
    ('每条约 ' + per.toFixed(1) + 'ms').padEnd(16),
    r.ok ? '' : (r.code || '')
  );
};

console.log('===== 1) 批大小 vs 延迟（串行，单请求）=====');
for (const n of [25, 60, 100, 150, 200]) {
  const r = await call(mkTexts(n));
  line(r, 'batch=' + n);
  await new Promise(r => setTimeout(r, 700));
}

console.log('\n===== 2) 并发测试（同时发 3 个 60 条）=====');
const t0 = Date.now();
const three = await Promise.all([call(mkTexts(60)), call(mkTexts(60)), call(mkTexts(60))]);
console.log('  三个并发总耗时:', Date.now() - t0, 'ms');
three.forEach((r, i) => line(r, '  conc#' + (i + 1)));

console.log('\n===== 3) 并发 4 个 60 条（看是否被限流）=====');
const t1 = Date.now();
const four = await Promise.all([1, 2, 3, 4].map(() => call(mkTexts(60))));
console.log('  四个并发总耗时:', Date.now() - t1, 'ms');
four.forEach((r, i) => line(r, '  conc#' + (i + 1)));
