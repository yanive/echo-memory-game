const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

const WIX_CLIENT_ID = process.env.WIX_CLIENT_ID;
const WIX_COLLECTION = process.env.WIX_COLLECTION || 'EchoScores';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!WIX_CLIENT_ID) {
  console.error('Missing WIX_CLIENT_ID env var');
  process.exit(1);
}

// --- CORS ---
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// --- Rate limiters ---
const startLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });
const submitLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
const lbLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

// --- Session store ---
const sessions = new Map();
const SESSION_TTL = 30 * 60_000; // 30 min
const SCORE_CAP = 100;

// Cleanup expired sessions every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.startTime > SESSION_TTL) sessions.delete(id);
  }
}, 5 * 60_000);

// --- Wix token cache ---
let wixToken = null;
let wixTokenExpiry = 0;

async function getWixToken() {
  if (wixToken && Date.now() < wixTokenExpiry) return wixToken;
  const res = await fetch('https://www.wixapis.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: WIX_CLIENT_ID, grantType: 'anonymous' }),
  });
  if (!res.ok) throw new Error(`Wix token error: ${res.status}`);
  const data = await res.json();
  wixToken = data.access_token;
  // Refresh 5 min before expiry (tokens typically last 1h)
  wixTokenExpiry = Date.now() + 55 * 60_000;
  return wixToken;
}

// --- Time validation ---
// Minimum time to reach a given score, based on game mechanics.
// A score of N means the player completed rounds 1..N and failed on round N+1.
// Each round r has: sequence playback + 300ms transition + 900ms between rounds.
// Sequence playback = r * (show + gap)
// show/gap decrease with round length, clamped at minimums.
const SPEED_MULT = { slow: 1.6, regular: 1.0, fast: 0.6 };
const SAFETY_MARGIN = 0.8; // allow 20% faster than theoretical minimum

function calcShowGap(roundLen, speedMult) {
  const show = Math.max(140, Math.round((520 - roundLen * 18) * speedMult));
  const gap = Math.max(80, Math.round((320 - roundLen * 12) * speedMult));
  return { show, gap };
}

function minTimeForScore(score, speed) {
  const mult = SPEED_MULT[speed] || 1.0;
  // 500ms initial delay before first round
  let total = 500;

  // Rounds 1..score (completed successfully) + round score+1 (failed, but still played back)
  for (let r = 1; r <= score + 1; r++) {
    const { show, gap } = calcShowGap(r, mult);
    // Sequence playback time
    total += r * (show + gap) + 300; // 300ms transition after playback
    if (r <= score) {
      total += 900; // 900ms success flash between rounds
    }
  }

  return total * SAFETY_MARGIN;
}

// --- POST /start ---
app.post('/start', startLimiter, (req, res) => {
  const { difficulty, speed } = req.body || {};
  if (!['easy', 'random', 'hard'].includes(difficulty)) {
    return res.status(400).json({ error: 'Invalid difficulty' });
  }
  if (!['slow', 'regular', 'fast'].includes(speed)) {
    return res.status(400).json({ error: 'Invalid speed' });
  }

  const id = crypto.randomUUID();
  sessions.set(id, { difficulty, speed, startTime: Date.now(), used: false });
  res.json({ sessionId: id });
});

// --- POST /submit ---
app.post('/submit', submitLimiter, async (req, res) => {
  const { sessionId, name, score } = req.body || {};

  if (!sessionId || typeof score !== 'number') {
    return res.status(400).json({ error: 'Missing sessionId or score' });
  }

  const session = sessions.get(sessionId);
  if (!session) return res.status(400).json({ error: 'Invalid or expired session' });
  if (session.used) return res.status(400).json({ error: 'Session already used' });

  // Score validation
  const clampedScore = Math.max(0, Math.min(SCORE_CAP, Math.floor(score)));

  // Time validation
  const elapsed = Date.now() - session.startTime;
  const minTime = minTimeForScore(clampedScore, session.speed);
  if (elapsed < minTime) {
    return res.status(400).json({ error: 'Score submitted too quickly' });
  }

  // Mark used
  session.used = true;

  // Sanitize name
  const safeName = (typeof name === 'string' ? name.trim() : '').slice(0, 20) || 'Anonymous';

  try {
    const token = await getWixToken();
    const headers = { 'Content-Type': 'application/json', Authorization: token };

    // Check for existing entry with same name + difficulty + speed
    const queryRes = await fetch('https://www.wixapis.com/wix-data/v2/items/query', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        dataCollectionId: WIX_COLLECTION,
        query: {
          filter: {
            name: { $eq: safeName },
            difficulty: { $eq: session.difficulty },
            speed: { $eq: session.speed },
          },
          paging: { limit: 1 },
        },
      }),
    });

    let existing = null;
    if (queryRes.ok) {
      const queryData = await queryRes.json();
      if (queryData.dataItems?.length) existing = queryData.dataItems[0];
    }

    if (existing && existing.data.score >= clampedScore) {
      // Existing score is equal or higher — nothing to do
      res.json({ ok: true });
      return;
    }

    let wixRes;
    if (existing) {
      // Update existing entry with higher score
      wixRes = await fetch(`https://www.wixapis.com/wix-data/v2/items/${existing.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          dataCollectionId: WIX_COLLECTION,
          dataItem: {
            id: existing.id,
            data: {
              ...existing.data,
              score: clampedScore,
            },
          },
        }),
      });
    } else {
      // Insert new entry
      wixRes = await fetch('https://www.wixapis.com/wix-data/v2/items', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          dataCollectionId: WIX_COLLECTION,
          dataItem: {
            data: {
              name: safeName,
              score: clampedScore,
              difficulty: session.difficulty,
              speed: session.speed,
            },
          },
        }),
      });
    }

    if (!wixRes.ok) {
      const errText = await wixRes.text();
      console.error('Wix save error:', wixRes.status, errText);
      return res.status(502).json({ error: 'Failed to save score' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Wix save error:', err);
    res.status(502).json({ error: 'Failed to save score' });
  }
});

// --- GET /leaderboard ---
app.get('/leaderboard', lbLimiter, async (req, res) => {
  const { difficulty, speed } = req.query;
  if (!['easy', 'random', 'hard'].includes(difficulty)) {
    return res.status(400).json({ error: 'Invalid difficulty' });
  }

  const filter = { difficulty: { $eq: difficulty } };
  if (['slow', 'regular', 'fast'].includes(speed)) {
    filter.speed = { $eq: speed };
  }

  try {
    const token = await getWixToken();
    const wixRes = await fetch('https://www.wixapis.com/wix-data/v2/items/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({
        dataCollectionId: WIX_COLLECTION,
        query: {
          filter,
          sort: [{ fieldName: 'score', order: 'DESC' }],
          paging: { limit: 10 },
        },
      }),
    });
    if (!wixRes.ok) {
      const errText = await wixRes.text();
      console.error('Wix query error:', wixRes.status, errText);
      return res.status(502).json({ error: 'Failed to fetch leaderboard' });
    }
    const data = await wixRes.json();
    const entries = (data.dataItems || []).map(item => ({
      name: item.data?.name,
      score: item.data?.score,
    }));
    res.json({ entries });
  } catch (err) {
    console.error('Wix query error:', err);
    res.status(502).json({ error: 'Failed to fetch leaderboard' });
  }
});

app.listen(PORT, () => {
  console.log(`Echo leaderboard server listening on port ${PORT}`);
});
