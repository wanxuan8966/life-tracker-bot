// Scheduled reminder endpoint — called by GitHub Actions cron
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const FB_URL     = process.env.FIREBASE_DATABASE_URL;
const FB_SECRET  = process.env.FIREBASE_DB_SECRET;
const R_SECRET   = process.env.REMINDER_SECRET;

let _cachedUid = process.env.FIREBASE_USER_UID || null;
async function getUserUid() {
  if (_cachedUid) return _cachedUid;
  const res = await fetch(`${FB_URL}/users.json?auth=${FB_SECRET}&shallow=true`);
  const data = await res.json();
  _cachedUid = Object.keys(data || {})[0];
  return _cachedUid;
}

async function fbRead(path) {
  const uid = await getUserUid();
  const res = await fetch(`${FB_URL}/users/${uid}/${path}.json?auth=${FB_SECRET}`);
  return res.json();
}

async function pushMessage(to, text) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] })
  });
}

const MESSAGES = {
  weight: `早安！☀️

記得量體重唷～
起床後、喝水前空腹量最準確。

量完傳給我：「今天 XX.X kg，體脂 XX%」`,

  breakfast: `早餐吃了什麼呀？🍳

記得吃今天的保健品唷！

直接傳給我吃了什麼，我幫你記進去！`,

  lunch: `午餐時間到囉 🍱

記得吃保健品！

吃了什麼傳給我記錄～`,

  evening: `今天快結束了，來做個紀錄總結 📋

1. 晚餐吃了什麼？
2. 今天喝了多少水？
3. 今天有做運動嗎？
4. 今天吃了哪些保健品？
5. 身體有哪裡不舒服嗎？

直接回答就好，我幫你整理進去！`
};

export default async function handler(req, res) {
  if (req.query.secret !== R_SECRET) return res.status(403).send('Forbidden');

  const type = req.query.type;
  const text = MESSAGES[type];
  if (!text) return res.status(400).send(`Unknown type: ${type}`);

  // 取 LINE user ID（從 bot_context 存的）
  const ctx = await fbRead('bot_context');
  const lineUserId = ctx?.line_user_id;
  if (!lineUserId) return res.status(400).send('No LINE user ID stored yet. Send a message to the bot first.');

  await pushMessage(lineUserId, text);
  res.status(200).send(`Sent ${type} reminder`);
}
