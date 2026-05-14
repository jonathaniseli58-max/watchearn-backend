const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
const paypal = require("@paypal/checkout-server-sdk");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const paypalEnv = process.env.NODE_ENV === "production"
  ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_SECRET)
  : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_SECRET);
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnv);

// Ads hardcodées (pas besoin de table ads dans Supabase)
const ADS = {
  "1": { id:"1", brand:"Nike", reward:0.15 },
  "2": { id:"2", brand:"Spotify", reward:0.10 },
  "3": { id:"3", brand:"Amazon", reward:0.20 },
  "4": { id:"4", brand:"Netflix", reward:0.12 },
  "5": { id:"5", brand:"Apple", reward:0.25 },
  "6": { id:"6", brand:"Adidas", reward:0.18 },
};

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token manquant" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token invalide" });
  }
}

// POST /auth/register
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name)
      return res.status(400).json({ error: "Champs manquants" });

    // Vérifier si l'email existe déjà
    const { data: existing } = await supabase
      .from("users").select("id").eq("email", email).single();
    if (existing)
      return res.status(400).json({ error: "Email déjà utilisé" });

    const hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from("users")
      .insert({ email, password_hash: hash, name, balance: 0 })
      .select().single();

    if (error) {
      console.error("Insert error:", error);
      return res.status(400).json({ error: error.message });
    }

    const token = jwt.sign({ id: data.id, email }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: data.id, name: data.name, email, balance: 0 } });
  } catch(e) {
    console.error("Register exception:", e);
    res.status(500).json({ error: e.message });
  }
});

// POST /auth/login
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user } = await supabase
      .from("users").select("*").eq("email", email).single();

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
  const { data } = await supabase
    .from("users").select("id, name, email, balance, created_at")
    .eq("id", req.user.id).single();
  res.json(data);
});

// GET /me/history
app.get("/me/history", auth, async (req, res) => {
  const { data } = await supabase
    .from("ad_views").select("id, ad_id, reward, created_at")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false }).limit(50);
  res.json(data || []);
});

// POST /ads/:id/complete
app.post("/ads/:id/complete", auth, async (req, res) => {
  try {
    const adId = req.params.id;
    const userId = req.user.id;
    const ad = ADS[adId];
    if (!ad) return res.status(404).json({ error: "Pub introuvable" });

    await supabase.from("ad_views").insert({ user_id: userId, ad_id: adId, reward: ad.reward });

    const { data: user } = await supabase.from("users").select("balance").eq("id", userId).single();
    const newBalance = +((user?.balance || 0) + ad.reward).toFixed(2);
    await supabase.from("users").update({ balance: newBalance }).eq("id", userId);

    res.json({ success: true, reward: ad.reward, new_balance: newBalance });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /withdraw
app.post("/withdraw", auth, async (req, res) => {
  try {
    const { paypal_email } = req.body;
    const userId = req.user.id;
    const { data: user } = await supabase.from("users").select("balance, name").eq("id", userId).single();

    if (!user || user.balance < 5)
      return res.status(400).json({ error: "Minimum 5€ requis" });

    const request = new paypal.payouts.PayoutsPostRequest();
    request.requestBody({
      sender_batch_header: { sender_batch_id: `WE-${userId}-${Date.now()}`, email_subject: "Votre retrait WatchEarn 💰" },
      items: [{ recipient_type: "EMAIL", amount: { value: user.balance.toFixed(2), currency: "EUR" }, receiver: paypal_email }],
    });

    const response = await paypalClient.execute(request);
    const batchId = response.result.batch_header.payout_batch_id;

    await supabase.from("withdrawals").insert({ user_id: userId, amount: user.balance, paypal_email, paypal_batch_id: batchId, status: "pending" });
    await supabase.from("users").update({ balance: 0 }).eq("id", userId);

    res.json({ success: true, batch_id: batchId, amount: user.balance });
  } catch(err) {
    console.error("PayPal error:", err);
    res.status(500).json({ error: "Erreur PayPal: " + err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ WatchEarn API démarrée sur http://localhost:${PORT}`));
