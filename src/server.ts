import express from "express";
import { Request, Response } from "express";
import cors from "cors";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { pool } from "./db";
import { newTokenUser } from "./tokens";


// --- REQUIRE ADMIN (pegar en server.ts) ---
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

function requireAdmin(req: any, res: any, next: any) {
  const header = (
    req.headers["x-admin-secret"] ||
    req.query.adminSecret ||
    ""
  ).toString();
  if (!ADMIN_SECRET || header !== ADMIN_SECRET) {
    return res.status(401).json({ error: "admin_required" });
  }
  next();
}

const app = express();
app.use(cors());
app.use(express.json());
interface AuthRequest extends Request {
  user?: {
    id: number;
    // otros campos si tienes
  };
}


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
  "minecraft:bread": 1,
  "minecraft:experience_bottle": 3,
  "minecraft:apple": 1,
  "minecraft:cooked_beef": 4,
  "minecraft:cooked_porkchop": 4,
  "minecraft:cooked_mutton": 3,
  "minecraft:cooked_chicken": 3,
  "minecraft:cooked_cod": 3,
  "minecraft:cooked_salmon": 4,
  "minecraft:golden_carrot": 6,

  "minecraft:diamond": 10,
  "minecraft:iron_ingot": 2,

  "minecraft:golden_apple": 20,
  "minecraft:netherite_ingot": 45,
};
//CLIMA
type WeatherKind = "clear" | "rain" | "thunder";

const WEATHER_PRICE: Record<WeatherKind, number> = {
  clear: 30,    // ☀️ Soleado
  rain: 25,     // 🌧️ Lluvia
  thunder: 40,  // ⛈️ Tormenta
};

//TIEMPO
type TimeKind = "day" | "sunset" | "night";

const TIME_PRICE: Record<TimeKind, number> = {
  day: 20,      // ☀️ Día
  sunset: 22,   // 🌇 Atardecer
  night: 18,    // 🌙 Noche
};


async function getUserIdByToken(tokenUser: string): Promise<number | null> {
  const r = await pool.query(
    "SELECT u.id FROM user_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_user=$1",
    [tokenUser]
  );
  return r.rowCount ? (r.rows[0].id as number) : null;
}

async function getCoins(userId: number): Promise<number> {
  const r = await pool.query("SELECT coins FROM wallets WHERE user_id=$1", [
    userId,
  ]);
  return r.rows[0]?.coins ?? 0;
}

async function addWalletTx(userId: number, delta: number, reason: string) {
  await pool.query(
    "INSERT INTO wallet_tx (user_id, delta, reason) VALUES ($1,$2,$3)",
    [userId, delta, reason]
  );
}

async function setCoins(userId: number, newCoins: number) {
  await pool.query("UPDATE wallets SET coins=$1 WHERE user_id=$2", [
    newCoins,
    userId,
  ]);
}

async function findOrCreateUserByName(username: string) {
  // intenta encontrar
  const r = await pool.query(
    "SELECT id, username FROM users WHERE username=$1",
    [username]
  );
  if (r.rowCount) return r.rows[0];

  // crea con pass_hash dummy (solo para link)
  const hash = await bcrypt.hash("linked_account", 10);
  const ins = await pool.query(
    "INSERT INTO users (username, pass_hash) VALUES ($1,$2) RETURNING id, username",
    [username, hash]
  );

  // crea wallet 0
  await pool.query("INSERT INTO wallets (user_id, coins) VALUES ($1, 0)", [
    ins.rows[0].id,
  ]);
  return ins.rows[0];
}

async function ensureTokenForUser(userId: number) {
  const r = await pool.query(
    "SELECT token_user FROM user_tokens WHERE user_id=$1",
    [userId]
  );
  if (r.rowCount) return r.rows[0].token_user;
  const token = newTokenUser();
  await pool.query(
    "INSERT INTO user_tokens (token_user, user_id) VALUES ($1,$2)",
    [token, userId]
  );
  return token;
}

async function userIdFromToken(tokenUser: string) {
  const u = await pool.query(
    "SELECT u.id FROM user_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_user=$1",
    [tokenUser]
  );
  return u.rowCount ? (u.rows[0].id as number) : null;
}
//HELPER PARA USERNAME
async function getUserIdByUsername(username: string): Promise<number | null> {
  const r = await pool.query(
    "SELECT id FROM users WHERE username = $1",
    [username]
  );
  return r.rowCount ? (r.rows[0].id as number) : null;
}

// === Helpers para recompensas diarias ===

// Calcula la recompensa según la racha (día 1..7, luego se mantiene)
function getRewardForStreak(streak: number): number {
  if (streak <= 1) return 5;
  if (streak === 2) return 8;
  if (streak === 3) return 12;
  if (streak === 4) return 15;
  if (streak === 5) return 20;
  if (streak === 6) return 25;
  return 30; // día 7 o más
}

// Diferencia en días entre dos fechas (YYYY-MM-DD)
function diffDays(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z");
  const db = new Date(b + "T00:00:00Z");
  return Math.floor((da.getTime() - db.getTime()) / (1000 * 60 * 60 * 24));
}

// === “BD” en memoria (demo) ===
// Códigos /link temporales (5 min)
type LinkData = { uuid: string; name: string; exp: number };
const links = new Map<string, LinkData>(); // code -> {uuid,name,exp}

// --- Vinculación persistente ---
// Tabla: player_bindings (token_user PK)

async function saveBinding(tokenUser: string, uuid: string, name: string) {
  await pool.query(`
    INSERT INTO player_bindings (token_user, mc_uuid, mc_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (token_user)
    DO UPDATE SET mc_uuid=$2, mc_name=$3, linked_at=NOW()
  `, [tokenUser, uuid, name]);
}

async function getBinding(tokenUser: string) {
  const r = await pool.query(
    "SELECT mc_uuid, mc_name FROM player_bindings WHERE token_user=$1",
    [tokenUser]
  );
  return r.rowCount ? r.rows[0] : null;
}

// --- Cola de tareas persistente ---
// Tabla: pending_tasks

async function addTask(id: string, uuid: string, itemId: string, amount: number, message: string) {
  await pool.query(`
    INSERT INTO pending_tasks (id, player_uuid, item_id, amount, message)
    VALUES ($1, $2, $3, $4, $5)
  `, [id, uuid, itemId, amount, message]);
}

async function getTasks() {
  const r = await pool.query(`
    SELECT
      id,
      player_uuid AS "playerUuid",
      item_id    AS "itemId",
      amount,
      message
    FROM pending_tasks
    ORDER BY created_at ASC
  `);
  return r.rows;
}


async function deleteTasks(ids: string[]) {
  await pool.query(
    "DELETE FROM pending_tasks WHERE id = ANY($1)",
    [ids]
  );
}

// --- Saber si un tokenUser YA está vinculado ---
app.post("/link/info", async (req, res) => {
  const { tokenUser } = req.body || {};
  if (!tokenUser) return res.json({ linked: false });

  const r = await pool.query(
    "SELECT mc_uuid, mc_name FROM player_bindings WHERE token_user=$1",
    [tokenUser]
  );

  if (!r.rowCount) {
    return res.json({ linked: false });
  }

  res.json({
    linked: true,
    mc_uuid: r.rows[0].mc_uuid,
    mc_name: r.rows[0].mc_name,
  });
});

// 1) Lo llama el plugin: crea código de vinculación
app.post("/link/start", (req, res) => {
  const { uuid, name } = req.body || {};
  if (!uuid || !name) return res.status(400).json({ error: "bad_request" });

  const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
  links.set(code, { uuid, name, exp: Date.now() + 5 * 60_000 }); // 5 min
  res.json({ code });
});

//1.1) Si ya esta vinculado te lleva al ShopScreen
app.post("/link/status", async (req, res) => {
  const { tokenUser } = req.body || {};
  if (!tokenUser) return res.json({ linked: false });

  const r = await pool.query(
    "SELECT mc_uuid FROM player_bindings WHERE token_user=$1",
    [tokenUser]
  );

  res.json({ linked: r.rowCount > 0 });
});

// 2) Lo llama la APP: completa vinculación con el código
app.post("/link/complete", async (req, res) => {
  const { code, tokenUser } = req.body || {};

  if (!code || !tokenUser)
    return res.status(400).json({ error: "code/tokenUser required" });

  // Código temporal en memoria para link (solo 5 min)
  const data = links.get(code);
  if (!data || Date.now() > data.exp) {
    return res.status(400).json({ error: "invalid_or_expired_code" });
  }

  const userId = await userIdFromToken(tokenUser);
  if (!userId)
    return res.status(401).json({ error: "invalid tokenUser" });

  // Guardar vinculación PERMANENTEMENTE
  await saveBinding(tokenUser, data.uuid, data.name);

  links.delete(code);

  await pool.query(
    "UPDATE users SET player_name=$1 WHERE id=$2",
    [data.name, userId]
  );

  const w = await pool.query(
    "SELECT coins FROM wallets WHERE user_id=$1",
    [userId]
  );

  res.json({
    ok: true,
    tokenUser,
    accountName: (await pool.query(
      "SELECT username FROM users WHERE id=$1",
      [userId]
    )).rows[0]?.username,
    minecraftName: data.name,
    coins: w.rows[0]?.coins ?? 0,
  });
});


// 3) Lo llama la APP: crea una “orden de compra” (dar ítem)
app.post("/purchase", async (req, res) => {
  const { tokenUser, itemId, amount } = req.body || {};
  if (!tokenUser) return res.status(401).json({ error: "unauthorized" });

  // --- VALIDAR VINCULACIÓN (BD) ---
  const binding = await getBinding(tokenUser);
  if (!binding)
    return res.status(401).json({ error: "account_not_linked" });

  const playerUuid = binding.mc_uuid;

  // validar item y qty
  const okItems = new Set([
    "minecraft:bread",
    "minecraft:experience_bottle",
    "minecraft:apple",
    "minecraft:cooked_beef",
    "minecraft:cooked_porkchop",
    "minecraft:cooked_mutton",
    "minecraft:cooked_chicken",
    "minecraft:cooked_cod",
    "minecraft:cooked_salmon",
    "minecraft:golden_carrot",
    "minecraft:diamond",
    "minecraft:iron_ingot",
    "minecraft:golden_apple",
    "minecraft:netherite_ingot",
  ]);

  if (!okItems.has(String(itemId)))
    return res.status(400).json({ error: "invalid_item" });

  const qty = Number(amount || 0);
  if (!Number.isInteger(qty) || qty < 1 || qty > 64)
    return res.status(400).json({ error: "invalid_amount" });

  // precio total
  const unit = UNIT_PRICE[itemId];
  if (!unit) return res.status(400).json({ error: "price_not_found" });
  const total = unit * qty;

  // usuario y saldo
  const userId = await getUserIdByToken(tokenUser);
  if (!userId) return res.status(401).json({ error: "invalid_tokenUser" });

  const cur = await getCoins(userId);
  if (cur < total)
    return res.status(400).json({
      error: "not_enough_coins",
      need: total,
      have: cur,
    });

  // descontar y auditar
  const newBal = cur - total;
  await setCoins(userId, newBal);
  await addWalletTx(userId, -total, "PURCHASE");

  // persistir orden
  const ins = await pool.query(
    "INSERT INTO orders (user_id, mc_uuid, item_id, amount, price, status) VALUES ($1,$2,$3,$4,$5,'PENDING') RETURNING id",
    [userId, playerUuid, itemId, qty, total]
  );

  // tarea persistente
  const id = crypto.randomUUID();
  await addTask(id, playerUuid, itemId, qty, "Compra completada");

  return res.json({ ok: true, orderId: ins.rows[0].id, balance: newBal });
});


//CLIMA MAS TIEMPO
app.post("/world/change", async (req, res) => {
  const { tokenUser, changeType } = req.body || {};

  if (!tokenUser) return res.status(401).json({ error: "unauthorized" });

  // --- VALIDAR VINCULACIÓN ---
  const binding = await getBinding(tokenUser);
  if (!binding)
    return res.status(401).json({ error: "account_not_linked" });

  const playerUuid = binding.mc_uuid;

  const type = String(changeType || "").toLowerCase();

  const isWeather = ["clear", "rain", "thunder"].includes(type);
  const isTime = ["day", "sunset", "night"].includes(type);

  if (!isWeather && !isTime)
    return res.status(400).json({ error: "invalid_change_type" });

  const cost = isWeather
    ? WEATHER_PRICE[type]
    : TIME_PRICE[type];

  const userId = await getUserIdByToken(tokenUser);
  if (!userId) return res.status(401).json({ error: "invalid_tokenUser" });

  const cur = await getCoins(userId);
  if (cur < cost)
    return res.status(400).json({
      error: "not_enough_coins",
      need: cost,
      have: cur,
    });

  const newBal = cur - cost;
  await setCoins(userId, newBal);

  await addWalletTx(
    userId,
    -cost,
    isWeather ? `WEATHER_${type.toUpperCase()}` : `TIME_${type.toUpperCase()}`
  );

  const itemId = isWeather
    ? `weather:${type}`
    : `time:${type}`;

  const ins = await pool.query(
    "INSERT INTO orders (user_id, mc_uuid, item_id, amount, price, status) VALUES ($1,$2,$3,$4,$5,'PENDING') RETURNING id",
    [userId, playerUuid, itemId, 1, cost]
  );

  const id = crypto.randomUUID();

  await addTask(
    id,
    playerUuid,
    itemId,
    1,
    isWeather
      ? `Cambio de clima: ${type}`
      : `Cambio de hora: ${type}`
  );

  return res.json({
    ok: true,
    orderId: ins.rows[0].id,
    balance: newBal,
  });
});



// 4) Lo llama el plugin: obtiene tareas pendientes
app.get("/tasks/pull", async (_req, res) => {
  const tasks = await getTasks();
  res.json(tasks);
});


// 5) Lo llama el plugin: confirma tareas entregadas
app.post("/tasks/ack", async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids))
    return res.status(400).json({ error: "ids_required" });

  await deleteTasks(ids);
  res.json({ ok: true });
});


// REGISTER
app.post("/auth/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res
      .status(400)
      .json({ error: "username/password required" });

  try {
    const hash = await bcrypt.hash(password, 10);
    const u = await pool.query(
      "INSERT INTO users (username, pass_hash) VALUES ($1,$2) RETURNING id, username",
      [username, hash]
    );
    await pool.query("INSERT INTO wallets (user_id, coins) VALUES ($1, 0)", [
      u.rows[0].id,
    ]);
    const tokenUser = await ensureTokenForUser(u.rows[0].id);
    res.json({ tokenUser, playerName: u.rows[0].username, coins: 0 });
  } catch (e: any) {
    console.error("REGISTER ERROR:", e);
    if (e.code === "23505")
      return res.status(409).json({ error: "username already exists" });
    res.status(500).json({ error: "server error" });
  }
});

// LOGIN
app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res
      .status(400)
      .json({ error: "username/password required" });
  
  const r = await pool.query(
    "SELECT id, username, pass_hash FROM users WHERE username=$1",
    [username]
  );
  if (!r.rowCount)
    return res.status(401).json({ error: "invalid credentials" });

  const ok = await bcrypt.compare(password, r.rows[0].pass_hash);
  if (!ok) return res.status(401).json({ error: "invalid credentials" });

  const tokenUser = await ensureTokenForUser(r.rows[0].id);
  const w = await pool.query("SELECT coins FROM wallets WHERE user_id=$1", [
    r.rows[0].id,
  ]);
  res.json({
    tokenUser,
    playerName: r.rows[0].username,
    coins: w.rows[0]?.coins ?? 0,
  });
});

// ACTUALIZAR NOMBRE DE USUARIO
app.post("/auth/update-username", async (req, res) => {
  const { tokenUser, newUsername } = req.body || {};

  if (!tokenUser || !newUsername) {
    return res.status(400).json({ error: "tokenUser/newUsername required" });
  }

  const trimmed = String(newUsername).trim();
  if (trimmed.length < 3) {
    return res.status(400).json({ error: "username too short" });
  }
  if (trimmed.length > 20) {
    return res.status(400).json({ error: "username too long" });
  }

  const userId = await userIdFromToken(tokenUser);
  if (!userId) {
    return res.status(401).json({ error: "invalid tokenUser" });
  }

  try {
    const r = await pool.query(
      "UPDATE users SET username = $1 WHERE id = $2 RETURNING username",
      [trimmed, userId]
    );
    return res.json({
      ok: true,
      playerName: r.rows[0]?.username ?? trimmed,
    });
  } catch (e: any) {
    console.error("UPDATE USERNAME ERROR:", e);
    if (e.code === "23505") {
      // unique_violation
      return res.status(409).json({ error: "username already exists" });
    }
    return res.status(500).json({ error: "server error" });
  }
});

// CAMBIAR CONTRASEÑA
app.post("/auth/change-password", async (req, res) => {
  const { tokenUser, oldPassword, newPassword } = req.body || {};

  if (!tokenUser || !oldPassword || !newPassword) {
    return res.status(400).json({ error: "missing_fields" });
  }
  if (String(newPassword).length < 6) {
    return res
      .status(400)
      .json({ error: "password too short" });
  }

  const userId = await userIdFromToken(tokenUser);
  if (!userId) {
    return res.status(401).json({ error: "invalid tokenUser" });
  }

  try {
    const r = await pool.query(
      "SELECT pass_hash FROM users WHERE id = $1",
      [userId]
    );
    if (!r.rowCount) {
      return res.status(404).json({ error: "user not found" });
    }

    const ok = await bcrypt.compare(oldPassword, r.rows[0].pass_hash);
    if (!ok) {
      return res.status(401).json({ error: "wrong_password" });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      "UPDATE users SET pass_hash = $1 WHERE id = $2",
      [newHash, userId]
    );

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("CHANGE PASSWORD ERROR:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// WALLET
app.post("/wallet/me", async (req, res) => {
  const { tokenUser } = req.body || {};
  if (!tokenUser)
    return res.status(400).json({ error: "tokenUser required" });

  const uid = await userIdFromToken(tokenUser);
  if (!uid) return res.status(401).json({ error: "invalid tokenUser" });

  const w = await pool.query("SELECT coins FROM wallets WHERE user_id=$1", [
    uid,
  ]);
  res.json({ coins: w.rows[0]?.coins ?? 0 });
});

// === ESTADO DE RECOMPENSA DIARIA ===
app.post("/rewards/daily/status", async (req, res) => {
  try {
    const { tokenUser } = req.body || {};
    if (!tokenUser) {
      return res.status(400).json({ error: "missing_tokenUser" });
    }

    const userId = await userIdFromToken(tokenUser);
    if (!userId) {
      return res.status(401).json({ error: "invalid_token" });
    }

    const dr = await pool.query(
      "SELECT last_claim_date, streak FROM daily_rewards WHERE user_id = $1",
      [userId]
    );

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    let lastClaimDate: string | null = null;
    let streak = 0;
    let canClaim = true;
    let todayReward = 0;

    if (dr.rowCount === 0) {
      // Nunca ha reclamado
      streak = 0;
      canClaim = true;
      todayReward = getRewardForStreak(1);
    } else {
      lastClaimDate = dr.rows[0].last_claim_date
        ? (dr.rows[0].last_claim_date as Date)
            .toISOString()
            .slice(0, 10)
        : null;
      streak = dr.rows[0].streak ?? 0;

      if (!lastClaimDate) {
        // No hay fecha previa, puede reclamar como día 1
        canClaim = true;
        todayReward = getRewardForStreak(1);
      } else {
        const dDiff = diffDays(today, lastClaimDate);
        if (dDiff === 0) {
          // Ya reclamó hoy
          canClaim = false;
          todayReward = getRewardForStreak(streak > 0 ? streak : 1);
        } else if (dDiff === 1) {
          // Día siguiente: mantiene racha
          const nextStreak = streak + 1;
          canClaim = true;
          todayReward = getRewardForStreak(nextStreak);
        } else {
          // Pasaron varios días: se resetea la racha
          canClaim = true;
          todayReward = getRewardForStreak(1);
        }
      }
    }

    return res.json({
      canClaim,
      todayReward,
      streak,
      lastClaimDate,
    });
  } catch (e) {
    console.error("daily status error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// === RECLAMAR RECOMPENSA DIARIA ===
app.post("/rewards/daily/claim", async (req, res) => {
  const client = await pool.connect();
  try {
    const { tokenUser } = req.body || {};
    if (!tokenUser) {
      client.release();
      return res.status(400).json({ error: "missing_tokenUser" });
    }

    const userId = await userIdFromToken(tokenUser);
    if (!userId) {
      client.release();
      return res.status(401).json({ error: "invalid_token" });
    }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    await client.query("BEGIN");

    // Leer fila de daily_rewards con FOR UPDATE
    const dr = await client.query(
      "SELECT last_claim_date, streak FROM daily_rewards WHERE user_id = $1 FOR UPDATE",
      [userId]
    );

    let lastClaimDate: string | null = null;
    let streak = 0;
    let newStreak = 1;

    if (dr.rowCount === 0) {
      // Primera vez
      streak = 0;
      newStreak = 1;
    } else {
      lastClaimDate = dr.rows[0].last_claim_date
        ? (dr.rows[0].last_claim_date as Date)
            .toISOString()
            .slice(0, 10)
        : null;
      streak = dr.rows[0].streak ?? 0;

      if (lastClaimDate) {
        const dDiff = diffDays(today, lastClaimDate);
        if (dDiff === 0) {
          // Ya reclamó hoy
          await client.query("ROLLBACK");
          client.release();
          return res
            .status(400)
            .json({ error: "already_claimed_today" });
        } else if (dDiff === 1) {
          // Día siguiente: subimos racha
          newStreak = streak + 1;
        } else {
          // Pasaron varios días: racha a 1
          newStreak = 1;
        }
      } else {
        newStreak = 1;
      }
    }

    const reward = getRewardForStreak(newStreak);

    // Upsert en daily_rewards
    if (dr.rowCount === 0) {
      await client.query(
        "INSERT INTO daily_rewards (user_id, last_claim_date, streak) VALUES ($1, $2, $3)",
        [userId, today, newStreak]
      );
    } else {
      await client.query(
        "UPDATE daily_rewards SET last_claim_date = $1, streak = $2 WHERE user_id = $3",
        [today, newStreak, userId]
      );
    }

    // Sumar coins en wallets
    const w = await client.query(
      "SELECT coins FROM wallets WHERE user_id = $1 FOR UPDATE",
      [userId]
    );

    if (w.rowCount === 0) {
      await client.query(
        "INSERT INTO wallets (user_id, coins) VALUES ($1, $2)",
        [userId, reward]
      );
    } else {
      await client.query(
        "UPDATE wallets SET coins = coins + $1 WHERE user_id = $2",
        [reward, userId]
      );
    }

    // Registrar movimiento en wallet_tx usando helper
    await addWalletTx(userId, reward, "DAILY_REWARD");

    // Leer balance final
    const wb = await client.query(
      "SELECT coins FROM wallets WHERE user_id = $1",
      [userId]
    );
    const balance = wb.rowCount > 0 ? wb.rows[0].coins : reward;

    await client.query("COMMIT");
    client.release();

    return res.json({
      added: reward,
      balance,
      streak: newStreak,
      lastClaimDate: today,
    });
  } catch (e) {
    console.error("daily claim error", e);
    try {
      await client.query("ROLLBACK");
    } catch {}
    client.release();
    return res.status(500).json({ error: "server_error" });
  }
});

// --- RUTA /wallet/topup PROTEGIDA (reemplaza la existente) ---
app.post("/wallet/topup", requireAdmin, async (req, res) => {
  const { tokenUser, amount } = req.body || {};
  const inc = Number(amount || 0);
  if (!tokenUser || !Number.isInteger(inc) || inc <= 0) {
    return res
      .status(400)
      .json({ error: "tokenUser/amount required" });
  }
  try {
    const userId = await getUserIdByToken(tokenUser);
    if (!userId) return res.status(404).json({ error: "invalid tokenUser" });

    const cur = await getCoins(userId);
    const newBal = cur + inc;
    await setCoins(userId, newBal);
    await addWalletTx(userId, inc, "ADMIN_TOPUP");

    return res.json({ ok: true, coins: newBal });
  } catch (e: any) {
    console.error("ADMIN TOPUP ERROR:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// --- TOPUP POR USERNAME (para el panel admin) ---
app.post("/wallet/topup-username", requireAdmin, async (req, res) => {
  const { username, amount } = req.body || {};
  const inc = Number(amount || 0);

  if (!username || !Number.isInteger(inc) || inc <= 0) {
    return res
      .status(400)
      .json({ error: "username/amount required" });
  }

  try {
    const userId = await getUserIdByUsername(username);
    if (!userId) {
      return res.status(404).json({ error: "username not found" });
    }

    const cur = await getCoins(userId);
    const newBal = cur + inc;
    await setCoins(userId, newBal);
    await addWalletTx(userId, inc, "ADMIN_TOPUP_USERNAME");

    return res.json({ ok: true, coins: newBal });
  } catch (e: any) {
    console.error("ADMIN TOPUP USERNAME ERROR:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// USERS
app.get("/admin/users", requireAdmin, async (_req, res) => {
  try {
    const q = `
      SELECT
        u.id,
        u.username,
        u.player_name,
        u.pass_hash,
        t.token_user,
        COALESCE(w.coins, 0) AS coins,
        dr.last_claim_date AS daily_last_claim,
        dr.streak       AS daily_streak
      FROM users u
      LEFT JOIN user_tokens t ON t.user_id = u.id
      LEFT JOIN wallets w ON w.user_id = u.id
      LEFT JOIN daily_rewards dr ON dr.user_id = u.id
      ORDER BY u.id
    `;
    const r = await pool.query(q);
    res.json(r.rows);
  } catch (e: any) {
    console.error("ADMIN /admin/users error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});


// CREATE USERS
app.post("/admin/create-user", requireAdmin, async (req, res) => {
  const { username, password, initialCoins } = req.body || {};
  if (!username || !password)
    return res
      .status(400)
      .json({ error: "username/password required" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const u = await pool.query(
      "INSERT INTO users (username, pass_hash) VALUES ($1,$2) RETURNING id, username",
      [username, hash]
    );
    const uid = u.rows[0].id;
    await pool.query(
      "INSERT INTO wallets (user_id, coins) VALUES ($1, $2)",
      [uid, Number(initialCoins || 0)]
    );
    res.json({ ok: true, user: u.rows[0] });
  } catch (e: any) {
    console.error("ADMIN create-user error:", e);
    if (e.code === "23505")
      return res.status(409).json({ error: "username exists" });
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// DELETE USER
app.post("/admin/delete-user", requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  if (!username)
    return res.status(400).json({ error: "username required" });
  try {
    const u = await pool.query("SELECT id FROM users WHERE username=$1", [
      username,
    ]);
    if (!u.rowCount)
      return res.status(404).json({ error: "user_not_found" });
    const id = u.rows[0].id;

    await pool.query("BEGIN");
    await pool.query("DELETE FROM wallet_tx WHERE user_id=$1", [id]);
    await pool.query("DELETE FROM orders WHERE user_id=$1", [id]);
    await pool.query("DELETE FROM user_tokens WHERE user_id=$1", [id]);
    await pool.query("DELETE FROM wallets WHERE user_id=$1", [id]);
    await pool.query("DELETE FROM users WHERE id=$1", [id]);
    await pool.query("COMMIT");

    res.json({ ok: true });
  } catch (e: any) {
    try {
      await pool.query("ROLLBACK");
    } catch {}
    console.error("ADMIN delete-user error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

//SET COINS
app.post("/admin/set-coins", requireAdmin, async (req, res) => {
  const { username, tokenUser, coins } = req.body || {};
  const newCoins = Number(coins);
  if (!Number.isInteger(newCoins))
    return res.status(400).json({ error: "coins must be integer" });

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
    return res
      .status(400)
      .json({ error: "username_or_token required" });
  } catch (e: any) {
    console.error("ADMIN set-coins error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// RESETEAR FILA COMPLETA (borra registro de daily_rewards)
app.post("/admin/reward-reset-full", requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "username required" });

  try {
    await pool.query(
      "DELETE FROM daily_rewards WHERE user_id = (SELECT id FROM users WHERE username=$1)",
      [username]
    );
    return res.json({ ok: true });
  } catch (e: any) {
    console.error("RESET FULL ERROR:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// RESETEAR FECHA (permitir que pueda reclamar de nuevo)
app.post("/admin/reward-reset-date", requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "username required" });

  try {
    await pool.query(
      `
      UPDATE daily_rewards
      SET last_claim_date = NULL
      WHERE user_id = (SELECT id FROM users WHERE username=$1)
      `,
      [username]
    );
    return res.json({ ok: true });
  } catch (e: any) {
    console.error("RESET DATE ERROR:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// RESETEAR RACHA (pero respeta la fecha)
app.post("/admin/reward-reset-streak", requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "username required" });

  try {
    await pool.query(
      `
      UPDATE daily_rewards
      SET streak = 0
      WHERE user_id = (SELECT id FROM users WHERE username=$1)
      `,
      [username]
    );
    return res.json({ ok: true });
  } catch (e: any) {
    console.error("RESET STREAK ERROR:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// APLICAR EFECTO AL JUGADOR
app.post("/effects/apply", async (req, res) => {
  const { tokenUser, effect, amplifier, duration } = req.body || {};

  // 1. Validar autenticación
  if (!tokenUser) return res.status(401).json({ error: "unauthorized" });

  // 2. Validar vinculación con Minecraft
  const binding = await getBinding(tokenUser);
  if (!binding)
    return res.status(401).json({ error: "account_not_linked" });

  const playerUuid = binding.mc_uuid;

  // 3. Validar datos recibidos
  if (!effect || amplifier === undefined || duration === undefined) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const amp = Number(amplifier);
  const dur = Number(duration);

  if (amp < 0 || dur <= 0)
    return res.status(400).json({ error: "invalid_effect_data" });

  // 4. Obtener userId usando tokenUser
  const userId = await getUserIdByToken(tokenUser);
  if (!userId) return res.status(401).json({ error: "invalid_tokenUser" });

  // 5. Calcular costo
  const EFFECT_BASE_COST = 20;
  const total = EFFECT_BASE_COST * (amp + 1);

  // 6. Verificar coins
  const cur = await getCoins(userId);
  if (cur < total)
    return res.status(400).json({
      error: "not_enough_coins",
      need: total,
      have: cur,
    });

  // 7. Descontar coins
  const newBal = cur - total;
  await setCoins(userId, newBal);

  // 8. Registrar transacción en wallet
  await addWalletTx(userId, -total, `EFFECT_${effect}`);

  // 9. Registrar orden
  const ins = await pool.query(
    "INSERT INTO orders (user_id, mc_uuid, item_id, amount, price, status) VALUES ($1,$2,$3,$4,$5,'PENDING') RETURNING id",
    [userId, playerUuid, `effect:${effect}`, 1, total]
  );

  // 10. Registrar tarea persistente
  const id = crypto.randomUUID();

  const payload = {
    effect,
    amplifier: amp,
    duration: dur
  };

  await addTask(id, playerUuid, "set_effect", 1, JSON.stringify(payload));

  // 11. Respuesta
  return res.json({
    ok: true,
    orderId: ins.rows[0].id,
    balance: newBal,
  });
});

// ======================================================
// 📍 TELEPORTS COMPATIBLES CON TU PLUGIN
// ======================================================

// 🧰 Usa tu función para crear tareas
async function addTpTask(
  playerUuid: string,
  itemId: string,
  payload?: any,
  message?: string
) {
  const id = crypto.randomUUID();

  // Si hay payload → enviar JSON
  let msg = "";
  if (payload) {
    msg = JSON.stringify(payload);
  } else if (message) {
    msg = message;
  } else {
    msg = "{}";
  }

  await addTask(id, playerUuid, itemId, 1, msg);
  return id;
}



// ========================
//   PRECIOS TELEPORT
// ========================
const TP_PRICE = {
  spawn: 20,
  mine: 40,
  arena: 35,
  custom: 60,
  checkpoint: 0
};

// ========================
// DESTINOS FIJOS
// ========================
const FIXED_TP = {
  spawn:  { x: 0.5,   y: 80, z: 0.5,   world: "world" },
  mine:   { x: 100.5, y: 20, z: -30.5, world: "world_mine" },
  arena:  { x: 0.5,   y: 75, z: 0.5,   world: "world_arena" }
};

// ======================================================
// 🟦 TELETRANSPORTE FIJO: spawn / mine / arena
// ======================================================
app.post("/teleport/go", async (req, res) => {
  const { tokenUser, target } = req.body;

  if (!tokenUser || !target)
    return res.json({ error: "missing_fields" });

  const binding = await getBinding(tokenUser);
  if (!binding)
    return res.json({ error: "account_not_linked" });

  const userId = await getUserIdByToken(tokenUser);
  if (!userId)
    return res.json({ error: "invalid_tokenUser" });

  if (!FIXED_TP[target])
    return res.json({ error: "invalid_target" });

  const cost = TP_PRICE[target];
  const coins = await getCoins(userId);

  if (coins < cost)
    return res.json({ error: "not_enough_coins", need: cost, have: coins });

  await setCoins(userId, coins - cost);
  await addWalletTx(userId, -cost, `TP_${target.toUpperCase()}`);

  await addTpTask(
    binding.mc_uuid,
    `tp:${target}`,
    null,
    `Viajando a ${target}...`
  );

  return res.json({ ok: true, balance: coins - cost });
});

// ======================================================
// ⭐ GUARDAR CHECKPOINT (GRATIS)
// ======================================================
app.post("/checkpoint/save", async (req, res) => {
  const { tokenUser, x, y, z, world } = req.body || {};

  if (!tokenUser)
    return res.json({ error: "unauthorized" });

  const binding = await getBinding(tokenUser);
  if (!binding)
    return res.json({ error: "account_not_linked" });

  const userId = await getUserIdByToken(tokenUser);
  if (!userId)
    return res.json({ error: "invalid_tokenUser" });

  const xi = Number(x);
  const yi = Number(y);
  const zi = Number(z);

  // 🚨 SI ES NaN → ERROR
  if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(zi)) {
    return res.json({ error: "coords_invalid" });
  }

  const w = String(world || "world");

  await pool.query(
    `
    INSERT INTO checkpoints (user_id, x, y, z, world, updated_at)
    VALUES ($1,$2,$3,$4,$5, now())
    ON CONFLICT (user_id)
    DO UPDATE SET x=$2, y=$3, z=$4, world=$5, updated_at=now()
    `,
    [userId, xi, yi, zi, w]
  );

  return res.json({
    ok: true,
    x: xi, y: yi, z: zi, world: w
  });
});



// ======================================================
// ⭐ IR A MI CHECKPOINT (GRATIS)
// ======================================================
app.post("/checkpoint/go", async (req, res) => {
  const { tokenUser } = req.body || {};

  if (!tokenUser) {
    return res.json({ error: "unauthorized" });
  }

  const binding = await getBinding(tokenUser);
  if (!binding) {
    return res.json({ error: "account_not_linked" });
  }

  const userId = await getUserIdByToken(tokenUser);
  if (!userId) {
    return res.json({ error: "invalid_tokenUser" });
  }

  const cp = await pool.query(
    "SELECT x, y, z, world FROM checkpoints WHERE user_id=$1",
    [userId]
  );

  if (!cp.rowCount) {
    return res.json({ error: "no_checkpoint_saved" });
  }

  const row = cp.rows[0];
  const x = Number(row.x);
  const y = Number(row.y);
  const z = Number(row.z);
  const world = String(row.world || "world");

  // Enviamos OBJETO como payload (NO JSON.stringify aquí)
  await addTpTask(
    binding.mc_uuid,
    "tp:checkpoint",
    { x, y, z, world },
    "Teletransportando a tu checkpoint..."
  );

  return res.json({ ok: true });
});


// ======================================================
// 🎯 TELETRANSPORTE PERSONALIZADO
// ======================================================
app.post("/teleport/custom", async (req, res) => {
  const { tokenUser, x, y, z, world } = req.body;

  if (!tokenUser)
    return res.json({ error: "unauthorized" });

  const binding = await getBinding(tokenUser);
  if (!binding)
    return res.json({ error: "account_not_linked" });

  const userId = await getUserIdByToken(tokenUser);
  if (!userId)
    return res.json({ error: "invalid_tokenUser" });

  const cost = TP_PRICE.custom;
  const coins = await getCoins(userId);

  if (coins < cost)
    return res.json({ error: "not_enough_coins", need: cost, have: coins });

  await setCoins(userId, coins - cost);
  await addWalletTx(userId, -cost, `TP_CUSTOM`);

  await addTpTask(
    binding.mc_uuid,
    "tp:custom",
    { x, y, z, world: world ?? "world" },
    "Teletransporte personalizado..."
  );

  return res.json({ ok: true, balance: coins - cost });
});
  

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API lista en http://localhost:${PORT}`));