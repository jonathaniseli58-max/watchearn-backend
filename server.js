// ============================================================
//  WatchEarn — Backend Node.js
//  Stack : Express + Supabase + PayPal SDK
// ============================================================

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

// ── Supabase ────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── PayPal ──────────────────────────────────────────────────
const paypalEnv = process.env.NODE_ENV === "production"
  ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_SECRET)
  : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_SECRET);
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnv);

// ── JWT middleware ───────────────────────────────────────────
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

// ── Anti-fraude : limite de pubs par jour ───────────────────
const MAX_ADS_PER_DAY = 20;

async function checkDailyLimit(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const { count } = await supabase
    .from("ad_views")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", `${today}T00:00:00`);
  return count < MAX_ADS_PER_DAY;
}

// ============================================================
//  AUTH
// ============================================================

// POST /auth/register
app.post("/auth/register", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name)
    return res.status(400).json({ error: "Champs manquants" });

  const hash = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from("users")
    .insert({ email, password_hash: hash, name, balance: 0 })
    .select()
    .single();

  if (error) return res.status(400).json({ error: "Email déjà utilisé" });

  const token = jwt.sign({ id: data.id, email }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id: data.id, name: data.name, email, balance: 0 } });
});

// POST /auth/login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("email", email)
    .single();

  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: "Email ou mot de passe incorrect" });

  const token = jwt.sign({ id: user.id, email }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id: user.id, name: user.name, email, balance: user.balance } });
});

// ============================================================
//  UTILISATEUR
// ============================================================

// GET /me — profil + solde
app.get("/me", auth, async (req, res) => {
  const { data } = await supabase
    .from("users")
    .select("id, name, email, balance, created_at")
    .eq("id", req.user.id)
    .single();
  res.json(data);
});

// GET /me/history — historique des gains
app.get("/me/history", auth, async (req, res) => {
  const { data } = await supabase
    .from("ad_views")
    .select("id, ad_id, reward, created_at")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false })
    .limit(50);
  res.json(data);
});

// ============================================================
//  PUBLICITÉS
// ============================================================

// GET /ads — liste des pubs disponibles
app.get("/ads", auth, async (req, res) => {
  const canWatch = await checkDailyLimit(req.user.id);
  const { data: ads } = await supabase.from("ads").select("*").eq("active", true);
  res.json({ ads, can_watch_more: canWatch, max_per_day: MAX_ADS_PER_DAY });
});

// POST /ads/:id/complete — pub regardée → vérification S2S + crédit
// En production : Google AdMob envoie un callback S2S signé
// Ici on simule la vérification côté serveur
app.post("/ads/:id/complete", auth, async (req, res) => {
  const adId = req.params.id;
  const userId = req.user.id;

  // 1. Vérification limite quotidienne
  const canWatch = await checkDailyLimit(userId);
  if (!canWatch)
    return res.status(429).json({ error: "Limite quotidienne atteinte (20 pubs/jour)" });

  // 2. Vérifier que la pub existe
  const { data: ad } = await supabase.from("ads").select("*").eq("id", adId).single();
  if (!ad) return res.status(404).json({ error: "Pub introuvable" });

  // 3. Enregistrer la vue
  await supabase.from("ad_views").insert({
    user_id: userId,
    ad_id: adId,
    reward: ad.reward,
  });

  // 4. Créditer le solde
  const { data: updated } = await supabase.rpc("increment_balance", {
    user_id: userId,
    amount: ad.reward,
  });

  res.json({ success: true, reward: ad.reward, new_balance: updated });
});

// ============================================================
//  RETRAITS PAYPAL
// ============================================================

const WITHDRAWAL_MIN = 5.0;

// POST /withdraw
app.post("/withdraw", auth, async (req, res) => {
  const { paypal_email } = req.body;
  const userId = req.user.id;

  // 1. Lire le solde
  const { data: user } = await supabase
    .from("users")
    .select("balance, name")
    .eq("id", userId)
    .single();

  if (user.balance < WITHDRAWAL_MIN)
    return res.status(400).json({ error: `Minimum ${WITHDRAWAL_MIN}€ requis` });

  // 2. Créer le payout PayPal
  const request = new paypal.payouts.PayoutsPostRequest();
  request.requestBody({
    sender_batch_header: {
      sender_batch_id: `WE-${userId}-${Date.now()}`,
      email_subject: "Votre retrait WatchEarn 💰",
    },
    items: [{
      recipient_type: "EMAIL",
      amount: { value: user.balance.toFixed(2), currency: "EUR" },
      receiver: paypal_email,
      note: `Retrait WatchEarn pour ${user.name}`,
    }],
  });

  try {
    const response = await paypalClient.execute(request);
    const batchId = response.result.batch_header.payout_batch_id;

    // 3. Enregistrer le retrait
    await supabase.from("withdrawals").insert({
      user_id: userId,
      amount: user.balance,
      paypal_email,
      paypal_batch_id: batchId,
      status: "pending",
    });

    // 4. Remettre le solde à zéro
    await supabase.from("users").update({ balance: 0 }).eq("id", userId);

    res.json({ success: true, batch_id: batchId, amount: user.balance });
  } catch (err) {
    console.error("PayPal error:", err);
    res.status(500).json({ error: "Erreur PayPal, réessayez plus tard" });
  }
});

// GET /withdraw/history
app.get("/withdraw/history", auth, async (req, res) => {
  const { data } = await supabase
    .from("withdrawals")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false });
  res.json(data);
});

// ============================================================
//  ADMOB CALLBACK S2S (en production)
// ============================================================
// Google AdMob appelle cette route après chaque pub récompensée
// avec une signature HMAC à vérifier
app.get("/admob/callback", async (req, res) => {
  const { ad_network, ad_unit, custom_data, reward_amount, reward_item,
          timestamp, transaction_id, user_id, signature, key_id } = req.query;

  // TODO en production : vérifier la signature HMAC avec votre clé AdMob
  // https://developers.google.com/admob/android/ssv

  console.log("AdMob S2S callback:", { user_id, reward_amount, transaction_id });

  // Créditer l'utilisateur
  await supabase.rpc("increment_balance", {
    user_id,
    amount: parseFloat(reward_amount) * 0.01, // Convertir les points en euros
  });

  res.status(200).send("OK");
});

// ── Lancement ────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ WatchEarn API démarrée sur http://localhost:${PORT}`));
