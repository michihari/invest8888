// 米国経済指標の公式発表日程を Gemini（Google検索連携）で取得し、data/events.json を更新する。
// 依存パッケージなし（Node 20 以上）。APIキーは環境変数 GEMINI_API_KEY から読む。
import fs from 'node:fs';

const KEY = process.env.GEMINI_API_KEY;
// 使うモデルの優先順位。GEMINI_MODEL にはカンマ区切りで複数指定できる。
// 上から順に試し、使えなければ次へ。全部だめなら ListModels API で今使える flash 系を探して試す。
const PREFERRED = (process.env.GEMINI_MODEL || '').split(',').map(s => s.trim()).filter(Boolean);
const DEFAULTS = ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];
const API = 'https://generativelanguage.googleapis.com/v1beta';
let active = null;   // 直近で成功したモデル（次の月はここから試す）
const MONTHS = Number(process.env.MONTHS_AHEAD || 3);
const FILE = 'data/events.json';

if (!KEY) { console.error('GEMINI_API_KEY が設定されていません'); process.exit(1); }

const IND = JSON.parse(fs.readFileSync('data/indicators.json', 'utf8'));
const cur = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { events: [] };

// 日付の妥当性チェック用: 指標ごとの「月内で発表され得る日」の範囲
const RANGE = {
  nfp: [1, 12], adp: [1, 10], jolts: [1, 10], ism_m: [1, 4], ism_s: [2, 6], trade: [1, 10],
  cpi: [8, 20], ppi: [9, 21], retail: [9, 21], ip: [12, 24], housing: [12, 25],
  umich_p: [6, 18], umich_f: [19, 31], existing: [17, 28], cb: [22, 31],
  durable: [20, 31], gdp: [20, 31], pce: [20, 31], fomc: [1, 31], minutes: [1, 31],
};
// 出典として認める公式ドメイン
const SRC_OK = /(^|\.)(bls\.gov|bea\.gov|census\.gov|dol\.gov|treasury\.gov|federalreserve\.gov|ismworld\.org|conference-board\.org|umich\.edu)$/;

const pad = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function targetMonths() {
  const now = new Date();
  return Array.from({ length: MONTHS }, (_, k) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  });
}

async function ask(ym, MODEL) {
  const list = Object.entries(IND).map(([id, v]) => `- ${id}: ${v.n}`).join('\n');
  const prompt = `Today is ${new Date().toISOString().slice(0, 10)}.
Use Google Search to find the OFFICIAL release schedule (BLS, BEA, Census, Federal Reserve, ISM, Conference Board, University of Michigan, DOL) for US economic indicators released in ${ym}.

Indicators (id: name):
${list}

Rules:
- Return ONLY a JSON array, no prose, no markdown fences.
- Each item: {"id": "<id from the list>", "date": "YYYY-MM-DD", "time": "HH:MM", "source": "<https URL of the official schedule page>"}
- "date" is the release date in the US (Eastern Time). "time" is 24-hour US Eastern Time.
- Include an item ONLY if you confirmed the date on an official schedule. Omit anything uncertain. Never guess or estimate.
- At most one item per id (for fomc use the second day of the meeting = the rate decision day; for minutes use the release date).`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${API}/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (res.ok) {
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      const a = text.indexOf('['), b = text.lastIndexOf(']');
      if (a < 0 || b < a) throw new Error('JSON配列が見つかりません: ' + text.slice(0, 200));
      return JSON.parse(text.slice(a, b + 1));
    }
    const body = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid/i.test(body))
      throw Object.assign(new Error(`認証エラー HTTP ${res.status}: ${body}`), { fatal: true });
    if (![429, 500, 502, 503, 504].includes(res.status)) throw new Error(`HTTP ${res.status}: ${body}`);
    console.warn(`HTTP ${res.status} (試行${attempt}/3) ${body}`);
    await sleep(attempt * 20000);
  }
  throw new Error('リトライ上限');
}

// APIキーで実際に使える flash 系モデルを新しい順に列挙
async function discover(tried) {
  const res = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': KEY }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return [];
  const { models = [] } = await res.json();
  const ver = n => Number((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  return models
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /flash/.test(n) && !/tts|image|live|audio|embed|lite|robotics|computer/.test(n) && !tried.has(n))
    .sort((a, b) => ver(b) - ver(a));
}

// モデルを順繰りに試して、最初に成功した結果を返す
async function askAny(ym) {
  const tried = new Set();
  const order = [...new Set([active, ...PREFERRED, ...DEFAULTS].filter(Boolean))];
  let discovered = false;
  for (;;) {
    const model = order.shift();
    if (!model) {
      if (discovered) throw new Error('使えるモデルが見つかりませんでした: ' + [...tried].join(', '));
      discovered = true;
      const found = await discover(tried);
      console.log(`[${ym}] ListModelsで見つかった候補: ${found.join(', ') || 'なし'}`);
      order.push(...found);
      continue;
    }
    if (tried.has(model)) continue;
    tried.add(model);
    try {
      const items = await ask(ym, model);
      if (active !== model) console.log(`[${ym}] モデル ${model} を使用`);
      active = model;
      return items;
    } catch (e) {
      if (e.fatal) throw e;
      console.warn(`[${ym}] モデル ${model} は使えませんでした: ${e.message.slice(0, 200)}`);
    }
  }
}

function check(o, ym) {
  if (!o || !IND[o.id]) return '未知のid';
  if (typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.date) || !o.date.startsWith(ym)) return '日付が対象月外/形式不正';
  const dt = new Date(o.date + 'T00:00:00Z');
  if (isNaN(dt) || dt.toISOString().slice(0, 10) !== o.date) return '存在しない日付';
  if ([0, 6].includes(dt.getUTCDay())) return '土日';
  const day = Number(o.date.slice(8)), r = RANGE[o.id];
  if (r && (day < r[0] || day > r[1])) return `通常の発表日の範囲外(${r[0]}-${r[1]}日)`;
  if (o.time != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.time)) return '時刻形式不正';
  try {
    const u = new URL(o.source);
    if (u.protocol !== 'https:' || !SRC_OK.test(u.hostname)) return '出典が公式ドメインではない';
  } catch { return '出典URLなし'; }
  return null;
}

const months = targetMonths();
const fresh = {};   // ym -> 検証済みイベント
let okMonths = 0;

for (const ym of months) {
  try {
    const items = await askAny(ym);
    const seen = new Set(), good = [];
    for (const o of items) {
      const why = check(o, ym);
      if (why) { console.warn(`[${ym}] 除外 ${JSON.stringify(o)} → ${why}`); continue; }
      const k = o.id + o.date;
      if (seen.has(k)) continue;
      seen.add(k);
      good.push({ id: o.id, date: o.date, ...(o.time ? { time: o.time } : {}), source: o.source });
    }
    console.log(`[${ym}] ${good.length}件を採用`);
    if (good.length) { fresh[ym] = good; okMonths++; }
  } catch (e) {
    console.error(`[${ym}] 取得失敗: ${e.message}`);
    if (e.fatal) break;
  }
}

if (!okMonths) { console.error('どの月も更新できませんでした。既存データを保持します。'); process.exit(1); }

// 既存データのうち、今回取得できなかった月の分を残す（過去月は破棄）
const thisMonth = months[0];
const kept = (cur.events || []).filter(e => e.date.slice(0, 7) >= thisMonth && !fresh[e.date.slice(0, 7)]);
const events = [...kept, ...Object.values(fresh).flat()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

fs.writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), model: active, events }, null, 1) + '\n');
console.log(`data/events.json を更新しました（計${events.length}件）`);
