// 第二轮：全部不重复的文本，测并发上限
const URL = 'https://transmart.qq.com/api/imt';

// 生成互不相同的界面式短句，避免服务端按文本去重
function uniqTexts(n, seed = '') {
  const verb = ['Open', 'Close', 'Save', 'Delete', 'Create', 'Update', 'Refresh',
    'Reload', 'Export', 'Import', 'Enable', 'Disable', 'Reset', 'Apply', 'Cancel'];
  const noun = ['Terminal', 'Kernel', 'Notebook', 'Environment', 'Package',
    'Dataset', 'Pipeline', 'Extension', 'Workspace', 'Session', 'Layer', 'Channel'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = verb[i % verb.length];
    const nn = noun[Math.floor(i / verb.length) % noun.length];
    out.push(`${seed}${v} ${nn} ${i}`);
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
    return {
      ok: r.ok && code === 'succ', status: r.status, code,
      ms: Date.now() - t0, got: (d.auto_translation || []).length, want: texts.length
    };
  } catch (e) {
    return { ok: false, code: 'EXC ' + e.message, ms: Date.now() - t0, want: texts.length };
  } finally { clearTimeout(timer); }
}

// 按并发度跑 N 条总量
async function run(total, batch, conc, tag) {
  const texts = uniqTexts(total, tag);
  const chunks = [];
  for (let i = 0; i < texts.length; i += batch) chunks.push(texts.slice(i, i + batch));
  const t0 = Date.now();
  const res = [];
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const my = next++;
      res[my] = await call(chunks[my]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, chunks.length) }, worker));
  const ms = Date.now() - t0;
  const okN = res.filter(r => r.ok).reduce((a, r) => a + r.got, 0);
  console.log(
    `并发${String(conc).padStart(2)} 批次${String(batch).padStart(3)} | 总 ${String(ms).padStart(6)}ms`,
    `| 成功 ${okN}/${total}`,
    `| 每条约 ${(ms / total).toFixed(1)}ms`,
    res.every(r => r.ok) ? '' : '| 失败: ' + res.filter(r => !r.ok).map(r => r.code).join(',')
  );
  return ms;
}

console.log('===== 总量 240 条（去重后 240 个不同文本）=====');
await run(240, 60, 1, 'A');
await new Promise(r => setTimeout(r, 600));
await run(240, 60, 2, 'B');
await new Promise(r => setTimeout(r, 600));
await run(240, 60, 4, 'C');
await new Promise(r => setTimeout(r, 600));
await run(240, 60, 6, 'D');
await new Promise(r => setTimeout(r, 600));
await run(240, 60, 8, 'E');
await new Promise(r => setTimeout(r, 600));
await run(240, 40, 8, 'F');
