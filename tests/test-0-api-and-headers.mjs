// 模拟浏览器扩展环境：只带 Content-Type，不手动设 UA / Referer
const body = {
  header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0' },
  type: 'plain', model_category: 'normal', text_domain: 'general',
  source: { lang: 'en', text_list: ['Run All Cells', 'Restart Kernel', 'Search files and commands'] },
  target: { lang: 'zh' }
};

async function tryOne(tag, init) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://transmart.qq.com/api/imt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...init
    });
    const d = await r.json();
    console.log(tag, '| HTTP', r.status, '| ret_code', d.header && d.header.ret_code,
      '|', (Date.now() - t0) + 'ms');
    if (d.auto_translation) console.log('   ', d.auto_translation);
  } catch (e) {
    console.log(tag, '| 失败', e.message);
  }
}

(async () => {
  // 1) 什么都不加（最接近 Chrome service worker 的默认行为）
  await tryOne('[仅 Content-Type]');

  // 2) 带 referrer 选项（浏览器唯一允许影响 Referer 的合法方式）
  await tryOne('[带 referrer 选项]', { referrer: 'https://transmart.qq.com/', referrerPolicy: 'unsafe-url' });

  // 3) 有道兜底接口同理
  try {
    const r = await fetch('https://aidemo.youdao.com/trans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: 'Run All Cells', from: 'Auto', to: 'zh-CHS' })
    });
    const d = await r.json();
    console.log('[有道 仅 Content-Type] | HTTP', r.status, '|', d.translation && d.translation[0], '| errorCode', d.errorCode);
  } catch (e) { console.log('[有道] 失败', e.message); }
})();
