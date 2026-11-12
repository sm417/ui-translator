// 第三轮：稳定性 —— 反复跑中等负载，统计 busy 出现频率
const URL = 'https://transmart.qq.com/api/imt';

function uniqTexts(n, seed) {
  const verb = ['Open', 'Close', 'Save', 'Delete', 'Create', 'Update', 'Refresh',
    'Reload', 'Export', 'Import', 'Enable', 'Disable', 'Reset', 'Apply', 'Cancel',
    'Inspect', 'Rename', 'Duplicate', 'Archive', 'Restore'];
  const noun = ['Terminal', 'Kernel', 'Notebook', 'Environment', 'Package',
    'Dataset', 'Pipeline', 'Extension', 'Workspace', 'Session', 'Layer',
    'Channel', 'Branch', 'Snapshot', 'Profile'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = verb[i % verb.length];
    const nn = noun[Math.floor(i / verb.length) % noun.length];
    out.push(`${seed}-${v} ${nn} ${i}`);
  }
  return out;
}

async function call(texts) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
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
    const code = d && d.header && d.header.ret_code;
    return { ok: r.ok && code === 'succ', code, ms: Date.now() - t0, got: (d.auto_translation || []).length };
  } catch (e) {
    return { ok: false, code: 'EXC', ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

// 带重试的调用（模拟我准备写进插件的逻辑）
async function callRetry(texts, tag) {
  for (let a = 0; a < 4; a++) {
    const r = await call(texts);
    if (r.ok) return { ...r, attempts: a + 1 };
    if (r.code === 'busy' || /EXC/.test(r.code)) {
      await new Promise(res => setTimeout(res, 250 * Math.pow(2, a)));
      continue;
    }
    return { ...r, attempts: a + 1 };
  }
  return { ok: false, code: 'retry-exhausted', ms: 0, got: 0 };
}

async function round(n, batch, conc, seed) {
  const texts = uniqTexts(n, seed);
  const chunks = [];
  for (let i = 0; i < texts.length; i += batch) chunks.push(texts.slice(i, i + batch));
  const t0 = Date.now();
  const res = [];
  let next = 0;
  const worker = async () => { while (next < chunks.length) { const my = next++; res[my] = await callRetry(chunks[my], seed); } };
  await Promise.all(Array.from({ length: Math.min(conc, chunks.length) }, worker));
  const ms = Date.now() - t0;
  const busy = res.filter(r => !r.ok).length;
  const retried = res.filter(r => r.attempts > 1).length;
  console.log(
    `${seed} | ${n}条 批次${batch} 并发${conc} | ${String(ms).padStart(5)}ms`,
    `| 每条约 ${(ms / n).toFixed(1)}ms`,
    `| 首轮busy批次 ${retried}/${res.length}`,
    `| 重试后仍失败 ${busy}`,
    `| 成功率 ${((1 - busy / res.length) * 100).toFixed(0)}%`
  );
}

console.log('===== 稳定性：并发 6，批次 50，各轮 300 条全新文本 =====');
for (let i = 0; i < 5; i++) {
  await round(300, 50, 6, 'R' + i);
  await new Promise(r => setTimeout(r, 1200));
}

console.log('\n===== 对照：并发 10 =====');
for (let i = 0; i < 3; i++) {
  await round(300, 50, 10, 'H' + i);
  await new Promise(r => setTimeout(r, 1200));
}
