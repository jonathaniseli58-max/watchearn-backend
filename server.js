const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ── Supabase via fetch direct (évite les bugs du SDK) ────────
const SUPABASE_URL = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY?.trim();

async function db(method, table, body = null, filters = "") {
  const url = `${SUPABASE_URL}/rest/v1/${table}${filters}`;
  const headers = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Prefer": method === "POST" ? "return=representation" : "",
  };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : null });
  const text = await res.text();
  try { return { data: JSON.parse(text), status: res.status }; }
  catch { return { data: text, status: res.status }; }
}

// Test route
app.get("/health", (req, res) => res.json({ ok: true, supabase: SUPABASE_URL }));

// JWT middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token manquant" });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Token invalide" }); }
}

// Ads intégrées
const ADS = {
  "1": { id:"1", brand:"Nike", reward:0.15 },
  "2": { id:"2", brand:"Spotify", reward:0.10 },
  "3": { id:"3", brand:"Amazon", reward:0.20 },
  "4": { id:"4", brand:"Netflix", reward:0.12 },
  "5": { id:"5", brand:"Apple", reward:0.25 },
  "6": { id:"6", brand:"Adidas", reward:0.18 },
};

// POST /auth/register
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name)
      return res.status(400).json({ error: "Champs manquants" });

    // Vérifier email existant
    const check = await db("GET", "users", null, `?email=eq.${encodeURIComponent(email)}&select=id`);
    if (check.data?.length > 0)
      return res.status(400).json({ error: "Email déjà utilisé" });

    const hash = await bcrypt.hash(password, 10);
    const insert = await db("POST", "users", { email, password_hash: hash, name, balance: 0 });

    if (insert.status !== 201)
      return res.status(400).json({ error: "Erreur création: " + JSON.stringify(insert.data) });

    const user = Array.isArray(insert.data) ? insert.data[0] : insert.data;
    const token = jwt.sign({ id: user.id, email }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, name: user.name, email, balance: 0 } });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /auth/login
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await db("GET", "users", null, `?email=eq.${encodeURIComponent(email)}`);
    const user = result.data?.[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: "Email ou mot de passe incorrect" });

    const token = jwt.sign({ id: user.id, email }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, name: user.name, email, balance: user.balance } });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /me
app.get("/me", auth, async (req, res) => {
  try {
    const result = await db("GET", "users", null, `?id=eq.${req.user.id}&select=id,name,email,balance,created_at`);
    res.json(result.data?.[0] || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /me/history
app.get("/me/history", auth, async (req, res) => {
  try {
    const result = await db("GET", "ad_views", null, `?user_id=eq.${req.user.id}&order=created_at.desc&limit=50`);
    res.json(result.data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /ads/:id/complete
app.post("/ads/:id/complete", auth, async (req, res) => {
  try {
    const ad = ADS[req.params.id];
    if (!ad) return res.status(404).json({ error: "Pub introuvable" });

    const userId = req.user.id;
    await db("POST", "ad_views", { user_id: userId, ad_id: ad.id, reward: ad.reward });

    const userResult = await db("GET", "users", null, `?id=eq.${userId}&select=balance`);
    const currentBalance = userResult.data?.[0]?.balance || 0;
    const newBalance = +((currentBalance) + ad.reward).toFixed(2);

    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ balance: newBalance })
    });

    res.json({ success: true, reward: ad.reward, new_balance: newBalance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /withdraw
app.post("/withdraw", auth, async (req, res) => {
  try {
    const { paypal_email } = req.body;
    const userId = req.user.id;
    const userResult = await db("GET", "users", null, `?id=eq.${userId}&select=balance,name`);
    const user = userResult.data?.[0];

    if (!user || user.balance < 5)
      return res.status(400).json({ error: "Minimum 5€ requis" });

    await db("POST", "withdrawals", { user_id: userId, amount: user.balance, paypal_email, status: "pending" });
    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ balance: 0 })
    });

    res.json({ success: true, amount: user.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ WatchEarn API sur port ${PORT} — Supabase: ${SUPABASE_URL}`));
