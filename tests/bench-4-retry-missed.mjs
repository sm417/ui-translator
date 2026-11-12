// 验证：接口原样吐回的条目，重试能否翻出来
const URL = 'https://transmart.qq.com/api/imt';
const MISS = ['Open Kernel net16', 'Save Environment net50', 'Save Pipeline net98', 'Run All Cells', 'Kernel'];

async function call(texts) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0' },
      type: 'plain', model_category: 'normal', text_domain: 'general',
      source: { lang: 'en', text_list: texts }, target: { lang: 'zh' }
    })
  });
  const d = await r.json();
  return d.auto_translation || [];
}

console.log('--- 单独翻（每次一条）---');
for (const t of MISS) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const r = await call([t]);
    out.push(r[0]);
    await new Promise(s => setTimeout(s, 300));
  }
  const changed = out.filter(v => v !== t).length;
  console.log(`  ${t.padEnd(26)} => ${JSON.stringify(out)}  | 3 次里翻出 ${changed}`);
}

console.log('\n--- 整组重发（把漏的放一批）---');
for (let round = 1; round <= 3; round++) {
  const r = await call(MISS);
  const still = r.filter((v, i) => v === MISS[i]);
  console.log(`  第${round}轮: 仍为原文 ${still.length}/${MISS.length}  ${JSON.stringify(still)}`);
  await new Promise(s => setTimeout(s, 500));
}
