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

// ── 訊息分類 ────────────────────────────────────────────────────────────────
function classifyMessage(text) {
  if (/菜單|訓練菜單|今天練什麼|幫我排|居家訓練|健身房訓練|今天訓練|練習計畫|排個菜單/.test(text)) return 'menu';
  if (/可以嗎|行嗎|加重|增加重量|減重量|換動作|這樣好嗎|多少組|多少下|可以加|要不要加|太輕|太重|感覺/.test(text)) return 'followup';
  return 'record';
}

// ── Event handler ───────────────────────────────────────────────────────────
async function handleEvent(event) {
  if (event.type !== 'message') return;
  const { replyToken, message } = event;
  // 儲存 LINE user ID（第一次自動存）
  const lineUserId = event.source?.userId;
  if (lineUserId) saveLineUserId(lineUserId).catch(()=>{});

  if (message.type === 'text') {
    await handleText(message.text.trim(), replyToken);
  } else if (message.type === 'image') {
    await handleImage(message.id, replyToken);
  }
}

// ── Text message ────────────────────────────────────────────────────────────
async function handleText(text, replyToken) {
  try {
    const type = classifyMessage(text);
    if (type === 'menu') {
      await handleMenuRequest(text, replyToken);
    } else if (type === 'followup') {
      await handleFollowup(text, replyToken);
    } else {
      const parsed = await geminiParse(text);
      const summary = await writeToFirebase(parsed);
      await reply(replyToken, summary);
    }
  } catch (e) {
    await reply(replyToken, `❌ ${e.message}`);
  }
}

// ── 訓練菜單生成 ─────────────────────────────────────────────────────────────
async function handleMenuRequest(text, replyToken) {
  const isHome = /居家|在家/.test(text);
  const isGym = /健身房|gym/i.test(text) || !isHome;
  const location = isHome ? '居家' : '健身房';

  // 讀近期資料
  const [exDb, sleepDb, dietDb] = await Promise.all([
    fbRead('exercise'), fbRead('sleep'), fbRead('diet')
  ]);
  const trainDb = await fbRead('train');

  const exRecords = (exDb?.records || []).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,14);
  const trainRecords = (trainDb?.records || []).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,30);
  const sleepRecords = (sleepDb?.records || []).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,3);
  const dietRecords = (dietDb?.records || []).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,2);

  const today = todayTW();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate()-1);
  const yd = yesterday.toISOString().split('T')[0];

  const todaySleep = sleepRecords.find(r=>r.date===today) || sleepRecords[0];
  const ydDiet = dietRecords.find(r=>r.date===yd) || dietRecords[0];

  const prompt = `你是一位專業健身教練，幫助這位用戶規劃今天的${location}訓練菜單。

【用戶背景】
- 女性，身高157cm，體重約48-49kg，目標：練出腰線/臀腿線條，改善圓肩駝背
- 主要訓練動作：坐姿划船、滑輪下拉、引體向上（輔助）、壺鈴硬舉、坐姿髖外展、坐姿內夾、臀推、高腳杯深蹲、保加利亞分腿蹲
- 居家可用器材：1.5kg啞鈴（輕）、瑜伽墊

【近期訓練紀錄（最近14天）】
${exRecords.map(r=>`${r.date}：${r.type}（${r.int}）- ${r.details||r.note||''}`).join('\n')}

【近期動作重量紀錄】
${trainRecords.map(r=>`${r.date} ${r.exercise} ${r.weight}kg ${r.sets}組×${r.reps}下${r.note?` (${r.note})`:''}`).join('\n')}

【今天狀態】
- 睡眠：${todaySleep?`${todaySleep.h}小時（${todaySleep.note||''}）`:'未記錄'}
- 昨天飲食：${ydDiet?`熱量${(ydDiet.cMin+ydDiet.cMax)/2|0}kcal，蛋白質${ydDiet.prot||'未知'}g`:'未記錄'}

【用戶請求】${text}

【輸出格式 - 嚴格遵守】
禁止使用任何 Markdown 符號（** * # - 等），這是 LINE 訊息，Markdown 無效。
用純文字 + emoji 排版。

第一段：今日狀態判斷（1-2行，直接說今天適不適合高強度，一句話說原因）

第二段：訓練菜單（每個動作單獨一行，格式如下）
🏋 動作名稱 | 重量 × 組數 × 次數 | 簡短提示

第三段：分隔線「———」後面再給訓練建議（今天為什麼這樣排、漸進邏輯、注意事項），可以寫長一點但不要廢話。

範例格式：
今天睡眠充足，前一天休息，狀態 ✅ 可以衝。

🏋 坐姿划船（正手）| 17kg × 3組 × 12下 | 上次13下，今天目標穩定12下
🏋 輔助引體向上 | 輔助28.5kg × 3組 × 10下 | 嘗試比上次多2下
🏋 臀推 | 70kg × 3組 × 10下 | 上次66kg，今天微加重
🏋 壺鈴硬舉 | 20kg × 3組 × 12下 | 感覺太輕就最後一組加次數
🏋 高腳杯深蹲 | 12kg × 3組 × 10下 | 臀腿有訓練到就好

———
建議與說明...`;

  const res = await geminiRequest([{text: prompt}]);
  const menuText = res.candidates?.[0]?.content?.parts?.[0]?.text || '無法生成菜單';

  // 儲存對話上下文
  await fbPut('bot_context', {
    last_menu: menuText,
    last_menu_location: location,
    last_menu_ts: Date.now(),
    last_train_records: JSON.stringify(trainRecords.slice(0,10))
  });

  await reply(replyToken, menuText);
}

// ── 後續追問 ─────────────────────────────────────────────────────────────────
async function handleFollowup(text, replyToken) {
  const ctx = await fbRead('bot_context');
  if (!ctx || !ctx.last_menu || (Date.now()-ctx.last_menu_ts)>3600000) {
    await reply(replyToken, '請先說「幫我排今天的健身房訓練菜單」或「居家訓練菜單」，我再根據你的問題回答。');
    return;
  }

  const prompt = `你是健身教練，根據以下對話回答用戶的問題。

【你剛才給的訓練菜單】
${ctx.last_menu}

【近期動作重量紀錄】
${ctx.last_train_records ? JSON.parse(ctx.last_train_records).map(r=>`${r.date} ${r.exercise} ${r.weight}kg ${r.sets}組×${r.reps}下`).join('\n') : '無'}

【用戶問題】${text}

請直接、簡潔地回答，給出明確的建議（是/否 + 理由 + 具體建議值）。用繁體中文。`;

  const res = await geminiRequest([{text: prompt}]);
  const answer = res.candidates?.[0]?.content?.parts?.[0]?.text || '無法回答';
  await reply(replyToken, answer);
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

【重要規則】
- 時間：24小時制；凌晨1點=01:00；昨天/前天請推算日期；沒有的資料一律found:false
- diet.details：把每一樣食物/飲料都單獨列一行，格式為「餐次: 食物名稱 熱量kcal 蛋白質Xg」，不可省略，越詳細越好
- diet.note：整天飲食的補充備註（例如蛋白達標、熱量偏高等）
- exercise.details：把每個動作單獨列一行，包含重量和組數次數
- sleep.note：睡眠狀態備註（例如分段睡、作息延後等）`;

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

async function geminiRequest(parts, model = 'gemini-2.5-flash') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts }] }) };
  let lastStatus;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, opts);
    if (res.ok) return res.json();
    lastStatus = res.status;
    if ((res.status === 503 || res.status === 429) && i < 2) {
      await sleep(2000 * (i + 1)); // 2s, 4s
      continue;
    }
    break;
  }
  // 2.5-flash 過載時自動改用 2.0-flash
  if (model === 'gemini-2.5-flash' && lastStatus === 503) {
    return geminiRequest(parts, 'gemini-2.0-flash');
  }
  throw new Error(`Gemini ${lastStatus}，請稍後再試一次`);
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

async function saveLineUserId(userId) {
  const ctx = await fbRead('bot_context').catch(()=>({})) || {};
  if (ctx.line_user_id) return;
  ctx.line_user_id = userId;
  await fbPut('bot_context', ctx).catch(()=>{});
}

async function pushMessage(to, text) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] })
  });
}
