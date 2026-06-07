import crypto from 'crypto';

const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const FB_URL      = process.env.FIREBASE_DATABASE_URL;
const FB_SECRET   = process.env.FIREBASE_DB_SECRET;

// 自動從 Firebase 找唯一一個 user UID（個人 app 只有一個用戶）
let _cachedUid = process.env.FIREBASE_USER_UID || null;
async function getUserUid() {
  if (_cachedUid) return _cachedUid;
  const res = await fetch(`${FB_URL}/users.json?auth=${FB_SECRET}&shallow=true`);
  const data = await res.json();
  _cachedUid = Object.keys(data || {})[0];
  if (!_cachedUid) throw new Error('Firebase 找不到使用者');
  return _cachedUid;
}

export const config = { api: { bodyParser: false } };

// ── Entry ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('Life Tracker Bot 🤖');

  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const rawBody = Buffer.concat(chunks);

  // 驗證 LINE 簽名
  const sig = req.headers['x-line-signature'];
  const hash = crypto.createHmac('sha256', LINE_SECRET).update(rawBody).digest('base64');
  if (sig !== hash) return res.status(403).send('Forbidden');

  const body = JSON.parse(rawBody.toString('utf8'));
  await Promise.all((body.events || []).map(handleEvent));
  res.status(200).send('OK');
}

// ── Event handler ───────────────────────────────────────────────────────────
async function handleEvent(event) {
  if (event.type !== 'message') return;
  const { replyToken, message } = event;

  if (message.type === 'text') {
    await handleText(message.text.trim(), replyToken);
  } else if (message.type === 'image') {
    await handleImage(message.id, replyToken);
  }
}

// ── Text message ────────────────────────────────────────────────────────────
async function handleText(text, replyToken) {
  try {
    const parsed = await geminiParse(text);
    const summary = await writeToFirebase(parsed);
    await reply(replyToken, summary);
  } catch (e) {
    await reply(replyToken, `❌ 解析失敗：${e.message}`);
  }
}

// ── Image message（拍營養標示）───────────────────────────────────────────────
async function handleImage(messageId, replyToken) {
  try {
    const imgBuf = await downloadLineImage(messageId);
    const result = await geminiAnalyzeImage(imgBuf);
    await reply(replyToken, result);
  } catch (e) {
    await reply(replyToken, `❌ 圖片解析失敗：${e.message}`);
  }
}

// ── Gemini 解析文字 ──────────────────────────────────────────────────────────
async function geminiParse(text) {
  const dateStr = todayTW();
  const prompt = `你是生活紀錄解析助手，從以下文字提取睡眠、飲食、運動資料，以JSON回答。

今天日期：${dateStr}
文字：${text}

常見台灣食品準確熱量（直接使用）：
- 統一陽光低糖高纖豆漿250ml = 115kcal 蛋白8.5g
- 茶葉蛋(超商) = 75kcal 蛋白6.6g
- 超能蛋白飲 = 194kcal 蛋白20.3g
- 全家茶碗蒸160g = 82kcal 蛋白7.5g
- 老協珍滴雞精 = 20kcal 蛋白4g
- 7-11黑胡椒雞柳條 = 150kcal 蛋白25.4g

只回傳純JSON（不要markdown）：
{"date":"YYYY-MM-DD","sleep":{"found":false,"sleepTime":null,"wakeTime":null,"hours":null,"note":""},"diet":{"found":false,"calMin":null,"calMax":null,"prot":null,"water":null,"details":"","note":""},"exercise":{"found":false,"type":"休息","intensity":"無","details":"","note":""}}

規則：24小時制；凌晨1點=01:00；昨天/前天請推算日期；沒有的資料一律found:false`;

  const res = await geminiRequest([{ text: prompt }]);
  const raw = res.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
}

// ── Gemini 解析圖片 ──────────────────────────────────────────────────────────
async function geminiAnalyzeImage(imgBuf) {
  const b64 = imgBuf.toString('base64');
  const res = await geminiRequest([
    { text: '這是食品包裝的營養標示，請列出：產品名稱、每份/每100g 的熱量(kcal)、蛋白質(g)、碳水化合物(g)、脂肪(g)。用繁體中文回覆，格式簡潔。' },
    { inline_data: { mime_type: 'image/jpeg', data: b64 } }
  ]);
  return res.candidates?.[0]?.content?.parts?.[0]?.text || '無法解析圖片';
}

async function geminiRequest(parts) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }) }
  );
  if (res.status === 429) {
    await sleep(4000);
    const retry = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] }) }
    );
    if (!retry.ok) throw new Error(`Gemini ${retry.status}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  return res.json();
}

// ── Firebase REST ────────────────────────────────────────────────────────────
async function fbRead(path) {
  const uid = await getUserUid();
  const res = await fetch(`${FB_URL}/users/${uid}/${path}.json?auth=${FB_SECRET}`);
  if (!res.ok) throw new Error(`Firebase read ${res.status}`);
  return res.json();
}

async function fbPut(path, data) {
  const uid = await getUserUid();
  const res = await fetch(`${FB_URL}/users/${uid}/${path}.json?auth=${FB_SECRET}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`Firebase write ${res.status}`);
}

// ── 寫入 Firebase ─────────────────────────────────────────────────────────────
async function writeToFirebase(parsed) {
  const lines = [];

  if (parsed.sleep?.found) {
    const db = await fbRead('sleep') || { records: [], nextId: 200 };
    const records = db.records || [];
    let nextId = db.nextId || 200;
    const idx = records.findIndex(r => r.date === parsed.date);
    const rec = {
      id: idx >= 0 ? records[idx].id : nextId,
      date: parsed.date,
      s: parsed.sleep.sleepTime || '',
      w: parsed.sleep.wakeTime || '',
      h: parsed.sleep.hours,
      note: parsed.sleep.note || '',
      energy: null, lowPt: null, headache: false
    };
    if (idx >= 0) records[idx] = rec;
    else { records.push(rec); nextId++; }
    await fbPut('sleep', { records, nextId });
    lines.push(`😴 ${parsed.sleep.sleepTime || '?'} 睡 → ${parsed.sleep.wakeTime || '?'} 起${parsed.sleep.hours ? `（${parsed.sleep.hours}h）` : ''}`);
  }

  if (parsed.diet?.found) {
    const db = await fbRead('diet') || { records: [], nextId: 200 };
    const records = db.records || [];
    let nextId = db.nextId || 200;
    const idx = records.findIndex(r => r.date === parsed.date);
    const rec = {
      id: idx >= 0 ? records[idx].id : nextId,
      date: parsed.date,
      cMin: parsed.diet.calMin, cMax: parsed.diet.calMax,
      prot: parsed.diet.prot, water: parsed.diet.water,
      details: parsed.diet.details || '', note: parsed.diet.note || ''
    };
    if (idx >= 0) records[idx] = rec;
    else { records.push(rec); nextId++; }
    await fbPut('diet', { records, nextId });
    const calStr = parsed.diet.calMin === parsed.diet.calMax
      ? `${parsed.diet.calMin}kcal`
      : `${parsed.diet.calMin}–${parsed.diet.calMax}kcal`;
    lines.push(`🍽 ${calStr}${parsed.diet.prot ? `，蛋白${parsed.diet.prot}g` : ''}${parsed.diet.water ? `，水${parsed.diet.water}ml` : ''}`);
  }

  if (parsed.exercise?.found) {
    const db = await fbRead('exercise') || { records: [], nextId: 200 };
    const records = db.records || [];
    let nextId = db.nextId || 200;
    const idx = records.findIndex(r => r.date === parsed.date);
    const rec = {
      id: idx >= 0 ? records[idx].id : nextId,
      date: parsed.date,
      type: parsed.exercise.type, int: parsed.exercise.intensity,
      details: parsed.exercise.details || '', note: parsed.exercise.note || ''
    };
    if (idx >= 0) records[idx] = rec;
    else { records.push(rec); nextId++; }
    await fbPut('exercise', { records, nextId });
    lines.push(`💪 ${parsed.exercise.type}（${parsed.exercise.intensity}）`);
  }

  if (lines.length === 0)
    return '🤔 沒找到可記錄的資料\n\n試試這樣說：\n「昨晚4點睡，今天1點起，吃了茶葉蛋豆漿，晚上健身划船17公斤」';

  return `✅ 已記錄 ${parsed.date}\n${lines.join('\n')}\n\n查看紀錄 👉 https://wanxuan8966.github.io/life-tracker/`;
}

// ── LINE API ─────────────────────────────────────────────────────────────────
async function reply(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
}

async function downloadLineImage(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` }
  });
  if (!res.ok) throw new Error('無法下載圖片');
  return Buffer.from(await res.arrayBuffer());
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function todayTW() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
