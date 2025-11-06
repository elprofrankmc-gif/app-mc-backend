import express from "express";
import cors from "cors";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { pool } from "./db";
import { newTokenUser } from "./tokens";


// --- REQUIRE ADMIN (pegar en server.ts) ---
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

function requireAdmin(req: any, res: any, next: any) {
  const header = (req.headers["x-admin-secret"] || req.query.adminSecret || "").toString();
  if (!ADMIN_SECRET || header !== ADMIN_SECRET) {
    return res.status(401).json({ error: "admin_required" });
  }
  next();
}

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
  "minecraft:diamond": 10,
  "minecraft:iron_ingot": 2,
  "minecraft:bread": 1,
  "minecraft:xp_bottle": 3,
  "minecraft:golden_apple": 20,
  "minecraft:netherite_ingot": 45,
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
  const { code, tokenUser } = req.body || {};
  if (!code || !tokenUser) return res.status(400).json({ error: "code/tokenUser required" });

  const data = links.get(code);
  if (!data || Date.now() > data.exp) {
    return res.status(400).json({ error: "invalid_or_expired_code" });
  }

  // validar tokenUser → obtener userId del usuario LOGUEADO
  const userId = await userIdFromToken(tokenUser);
  if (!userId) return res.status(401).json({ error: "invalid tokenUser" });

  // vincular ese token con el uuid de MC
  bindings.set(tokenUser, data.uuid);
  links.delete(code);

  // opcional: guarda el nombre del jugador para mostrar en la app
  await pool.query("UPDATE users SET player_name = $1 WHERE id = $2", [data.name, userId]).catch(()=>{});

  // devolver el mismo token y el nombre actual (cuenta) y opcionalmente el playerName de MC
  const w = await pool.query("SELECT coins FROM wallets WHERE user_id=$1", [userId]);
  res.json({
    ok: true,
    tokenUser,                 // el mismo token del usuario logueado (123)
    accountName: (await pool.query("SELECT username FROM users WHERE id=$1",[userId])).rows[0]?.username,
    minecraftName: data.name,  // p.ej. TheFranckMC
    coins: w.rows[0]?.coins ?? 0,
  });
});

;

// 3) Lo llama la APP: crea una “orden de compra” (dar ítem)
app.post("/purchase", async (req, res) => {
  const { tokenUser, itemId, amount } = req.body || {};
  if (!tokenUser) return res.status(401).json({ error: "unauthorized" });

  // validar vinculación (sigues usando tu mapa en memoria)
  if (!bindings.has(tokenUser)) return res.status(401).json({ error: "account_not_linked" });

  // validar item y qty
  const okItems = new Set([
  "minecraft:diamond",
  "minecraft:bread",
  "minecraft:iron_ingot",
  "minecraft:experience_bottle",
  "minecraft:golden_apple",
  "minecraft:netherite_ingot",
]);

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

// --- RUTA /wallet/topup PROTEGIDA (reemplaza la existente) ---
app.post("/wallet/topup", requireAdmin, async (req, res) => {
  const { tokenUser, amount } = req.body || {};
  const inc = Number(amount || 0);
  if (!tokenUser || !Number.isInteger(inc) || inc <= 0) {
    return res.status(400).json({ error: "tokenUser/amount required" });
  }
  try {
    const userId = await getUserIdByToken(tokenUser);
    if (!userId) return res.status(404).json({ error: "invalid tokenUser" });

    const cur = await getCoins(userId);
    const newBal = cur + inc;
    await setCoins(userId, newBal);
    await addWalletTx(userId, inc, "ADMIN_TOPUP");

    return res.json({ ok: true, coins: newBal });
  } catch (e:any) {
    console.error("ADMIN TOPUP ERROR:", e);
    return res.status(500).json({ error: "server error" });
  }
});
// /wallet/topup (para pruebas)
/*
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
*/

// USERS
app.get("/admin/users", requireAdmin, async (_req, res) => {
  try {
    const q = `
      SELECT u.id, u.username, u.player_name, u.pass_hash,
             t.token_user, COALESCE(w.coins,0) AS coins
      FROM users u
      LEFT JOIN user_tokens t ON t.user_id = u.id
      LEFT JOIN wallets w ON w.user_id = u.id
      ORDER BY u.id
    `;
    const r = await pool.query(q);
    res.json(r.rows);
  } catch (e:any) {
    console.error("ADMIN /admin/users error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// CREATE USERS
app.post("/admin/create-user", requireAdmin, async (req, res) => {
  const { username, password, initialCoins } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username/password required" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const u = await pool.query(
      "INSERT INTO users (username, pass_hash) VALUES ($1,$2) RETURNING id, username",
      [username, hash]
    );
    const uid = u.rows[0].id;
    await pool.query("INSERT INTO wallets (user_id, coins) VALUES ($1, $2)", [uid, Number(initialCoins || 0)]);
    res.json({ ok: true, user: u.rows[0] });
  } catch (e:any) {
    console.error("ADMIN create-user error:", e);
    if (e.code === "23505") return res.status(409).json({ error: "username exists" });
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// DELETE USER
app.post("/admin/delete-user", requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "username required" });
  try {
    const u = await pool.query("SELECT id FROM users WHERE username=$1", [username]);
    if (!u.rowCount) return res.status(404).json({ error: "user_not_found" });
    const id = u.rows[0].id;

    await pool.query("BEGIN");
    await pool.query("DELETE FROM wallet_tx WHERE user_id=$1", [id]);
    await pool.query("DELETE FROM orders WHERE user_id=$1", [id]);
    await pool.query("DELETE FROM user_tokens WHERE user_id=$1", [id]);
    await pool.query("DELETE FROM wallets WHERE user_id=$1", [id]);
    await pool.query("DELETE FROM users WHERE id=$1", [id]);
    await pool.query("COMMIT");

    res.json({ ok: true });
  } catch (e:any) {
    try { await pool.query("ROLLBACK"); } catch {}
    console.error("ADMIN delete-user error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

//SET COINS
app.post("/admin/set-coins", requireAdmin, async (req, res) => {
  const { username, tokenUser, coins } = req.body || {};
  const newCoins = Number(coins);
  if (!Number.isInteger(newCoins)) return res.status(400).json({ error: "coins must be integer" });

  try {
    if (username) {
      const r = await pool.query(
        "UPDATE wallets SET coins=$1 WHERE user_id=(SELECT id FROM users WHERE username=$2) RETURNING *",
        [newCoins, username]
      );
      return res.json({ ok: true, rows: r.rows });
    }
    if (tokenUser) {
      const r = await pool.query(
        "UPDATE wallets w SET coins=$1 FROM user_tokens t WHERE t.token_user=$2 AND t.user_id=w.user_id RETURNING w.*",
        [newCoins, tokenUser]
      );
      return res.json({ ok: true, rows: r.rows });
    }
    return res.status(400).json({ error: "username_or_token required" });
  } catch (e:any) {
    console.error("ADMIN set-coins error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API lista en http://localhost:${PORT}`));