import express from "express";
import cors from "cors";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { pool } from "./db";
import { newTokenUser } from "./tokens";


const app = express();
app.use(cors());
app.use(express.json());

// ─── Arranque y rutas de verificación ─────────────────────────────────────────
app.get("/", (_req, res) => res.send("OK ROOT ✅"));

app.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT 1");
    res.json({ status: "OK DEPLOY ✅", db: r.rows[0] });
  } catch (e: any) {
    console.error("HEALTH DB ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/version", (_req, res) => {
  res.json({ commit: process.env.RENDER_GIT_COMMIT || "local" });
});
console.log("BOOT MARKER: server code includes /health + /version");



// Precio por unidad (ajústalo a tu gusto)
const UNIT_PRICE: Record<string, number> = {
  "minecraft:diamond": 50,
  "minecraft:iron_ingot": 10,
  "minecraft:bread": 5,
};
async function getUserIdByToken(tokenUser: string): Promise<number | null> {
  const r = await pool.query(
    "SELECT u.id FROM user_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_user=$1",
    [tokenUser]
  );
  return r.rowCount ? (r.rows[0].id as number) : null;
}

async function getCoins(userId: number): Promise<number> {
  const r = await pool.query("SELECT coins FROM wallets WHERE user_id=$1", [userId]);
  return r.rows[0]?.coins ?? 0;
}

async function addWalletTx(userId: number, delta: number, reason: string) {
  await pool.query("INSERT INTO wallet_tx (user_id, delta, reason) VALUES ($1,$2,$3)", [userId, delta, reason]);
}

async function setCoins(userId: number, newCoins: number) {
  await pool.query("UPDATE wallets SET coins=$1 WHERE user_id=$2", [newCoins, userId]);
}



async function findOrCreateUserByName(username: string) {

  // intenta encontrar
  const r = await pool.query("SELECT id, username FROM users WHERE username=$1", [username]);
  if (r.rowCount) return r.rows[0];

  // crea con pass_hash dummy (solo para link)
  const hash = await bcrypt.hash("linked_account", 10);
  const ins = await pool.query(
    "INSERT INTO users (username, pass_hash) VALUES ($1,$2) RETURNING id, username",
    [username, hash]
  );

  // crea wallet 0
  await pool.query("INSERT INTO wallets (user_id, coins) VALUES ($1, 0)", [ins.rows[0].id]);
  return ins.rows[0];
}

async function ensureTokenForUser(userId: number) {
  const r = await pool.query("SELECT token_user FROM user_tokens WHERE user_id=$1", [userId]);
  if (r.rowCount) return r.rows[0].token_user;
  const token = newTokenUser();
  await pool.query("INSERT INTO user_tokens (token_user, user_id) VALUES ($1,$2)", [token, userId]);
  return token;
}

async function userIdFromToken(tokenUser: string) {
  const u = await pool.query(
    "SELECT u.id FROM user_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_user=$1",
    [tokenUser]
  );
  return u.rowCount ? (u.rows[0].id as number) : null;
}

// === “BD” en memoria (demo) ===
type LinkData = { uuid: string; name: string; exp: number };
const links = new Map<string, LinkData>();            // code -> {uuid,name,exp}
const bindings = new Map<string, string>();           // tokenUser -> uuid
type Task = { id: string; playerUuid: string; itemId: string; amount: number; message: string };
const tasks: Task[] = [];                              // cola de tareas

// 1) Lo llama el plugin: crea código de vinculación
app.post("/link/start", (req, res) => {
  const { uuid, name } = req.body || {};
  if (!uuid || !name) return res.status(400).json({ error: "bad_request" });

  const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
  links.set(code, { uuid, name, exp: Date.now() + 5 * 60_000 });       // 5 min
  res.json({ code });
});

// 2) Lo llama la APP: completa vinculación con el código
app.post("/link/complete", async (req, res) => {
  const { code } = req.body || {};
  const data = links.get(code);
  if (!data || Date.now() > data.exp) return res.status(400).json({ error: "invalid_or_expired_code" });

  // crea/encuentra usuario por name (playerName)
  const user = await findOrCreateUserByName(data.name);
  const tokenUser = await ensureTokenForUser(user.id);

  // (tu lógica en memoria)
  bindings.set(tokenUser, data.uuid);
  links.delete(code);

  // opcional: persistir el code como histórico (no requerido para que funcione)
  // await pool.query(
  //   "INSERT INTO link_codes (code, mc_uuid, expires_at, used, user_id) VALUES ($1,$2, NOW(), true, $3) ON CONFLICT (code) DO NOTHING",
  //   [code, data.uuid, user.id]
  // );

  res.json({ tokenUser, playerName: data.name });
})
;

// 3) Lo llama la APP: crea una “orden de compra” (dar ítem)
app.post("/purchase", async (req, res) => {
  const { tokenUser, itemId, amount } = req.body || {};
  if (!tokenUser) return res.status(401).json({ error: "unauthorized" });

  // validar vinculación (sigues usando tu mapa en memoria)
  if (!bindings.has(tokenUser)) return res.status(401).json({ error: "account_not_linked" });

  // validar item y qty
  const okItems = new Set(["minecraft:diamond", "minecraft:bread", "minecraft:iron_ingot"]);
  if (!okItems.has(String(itemId))) return res.status(400).json({ error: "invalid_item" });

  const qty = Number(amount || 0);
  if (!Number.isInteger(qty) || qty < 1 || qty > 64) return res.status(400).json({ error: "invalid_amount" });

  // precio total
  const unit = UNIT_PRICE[itemId];
  if (!unit) return res.status(400).json({ error: "price_not_found" });
  const total = unit * qty;

  // usuario y saldo
  const userId = await getUserIdByToken(tokenUser);
  if (!userId) return res.status(401).json({ error: "invalid_tokenUser" });

  const cur = await getCoins(userId);
  if (cur < total) return res.status(400).json({ error: "not_enough_coins", need: total, have: cur });

  // descontar y auditar
  const newBal = cur - total;
  await setCoins(userId, newBal);
  await addWalletTx(userId, -total, "PURCHASE");

  // persistir orden y encolar tarea
  const playerUuid = bindings.get(tokenUser)!;
  const ins = await pool.query(
    "INSERT INTO orders (user_id, mc_uuid, item_id, amount, price, status) VALUES ($1,$2,$3,$4,$5,'PENDING') RETURNING id",
    [userId, playerUuid, itemId, qty, total]
  );

  const id = crypto.randomUUID();
  tasks.push({ id, playerUuid, itemId, amount: qty, message: "Compra completada" });

  return res.json({ ok: true, orderId: ins.rows[0].id, balance: newBal });
});


// 4) Lo llama el plugin: obtiene tareas pendientes
app.get("/tasks/pull", (_req, res) => {
  res.json(tasks);
});

// 5) Lo llama el plugin: confirma tareas entregadas
app.post("/tasks/ack", (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: "ids_required" });

  for (const id of ids) {
    const i = tasks.findIndex(t => t.id === id);
    if (i >= 0) tasks.splice(i, 1);
  }
  res.json({ ok: true });
});

// REGISTER
app.post("/auth/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username/password required" });

  try {
    const hash = await bcrypt.hash(password, 10);
    const u = await pool.query(
      "INSERT INTO users (username, pass_hash) VALUES ($1,$2) RETURNING id, username",
      [username, hash]
    );
    await pool.query("INSERT INTO wallets (user_id, coins) VALUES ($1, 0)", [u.rows[0].id]);
    const tokenUser = await ensureTokenForUser(u.rows[0].id);
    res.json({ tokenUser, playerName: u.rows[0].username, coins: 0 });
  } catch (e: any) {
  console.error("REGISTER ERROR:", e); // <— agrega esto
  if (e.code === "23505") return res.status(409).json({ error: "username already exists" });
  res.status(500).json({ error: "server error" });
}

});

// LOGIN
app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username/password required" });

  const r = await pool.query("SELECT id, username, pass_hash FROM users WHERE username=$1", [username]);
  if (!r.rowCount) return res.status(401).json({ error: "invalid credentials" });

  const ok = await bcrypt.compare(password, r.rows[0].pass_hash);
  if (!ok) return res.status(401).json({ error: "invalid credentials" });

  const tokenUser = await ensureTokenForUser(r.rows[0].id);
  const w = await pool.query("SELECT coins FROM wallets WHERE user_id=$1", [r.rows[0].id]);
  res.json({ tokenUser, playerName: r.rows[0].username, coins: w.rows[0]?.coins ?? 0 });
});

// WALLET
app.post("/wallet/me", async (req, res) => {
  const { tokenUser } = req.body || {};
  if (!tokenUser) return res.status(400).json({ error: "tokenUser required" });

  const uid = await userIdFromToken(tokenUser);
  if (!uid) return res.status(401).json({ error: "invalid tokenUser" });

  const w = await pool.query("SELECT coins FROM wallets WHERE user_id=$1", [uid]);
  res.json({ coins: w.rows[0]?.coins ?? 0 });
});

// /wallet/topup (para pruebas)
app.post("/wallet/topup", async (req, res) => {
  const { tokenUser, amount } = req.body || {};
  const inc = Number(amount || 0);
  if (!tokenUser || !Number.isInteger(inc) || inc <= 0) {
    return res.status(400).json({ error: "tokenUser/amount required" });
  }
  const userId = await getUserIdByToken(tokenUser);
  if (!userId) return res.status(401).json({ error: "invalid tokenUser" });

  const cur = await getCoins(userId);
  const newBal = cur + inc;
  await setCoins(userId, newBal);
  await addWalletTx(userId, inc, "TOPUP");

  return res.json({ coins: newBal });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API lista en http://localhost:${PORT}`));