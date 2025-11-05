"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const crypto_1 = __importDefault(require("crypto"));
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const links = new Map(); // code -> {uuid,name,exp}
const bindings = new Map(); // tokenUser -> uuid
const tasks = []; // cola de tareas
// 1) Lo llama el plugin: crea código de vinculación
app.post("/link/start", (req, res) => {
    const { uuid, name } = req.body || {};
    if (!uuid || !name)
        return res.status(400).json({ error: "bad_request" });
    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
    links.set(code, { uuid, name, exp: Date.now() + 5 * 60000 }); // 5 min
    res.json({ code });
});
// 2) Lo llama la APP: completa vinculación con el código
app.post("/link/complete", (req, res) => {
    const { code } = req.body || {};
    const data = links.get(code);
    if (!data || Date.now() > data.exp)
        return res.status(400).json({ error: "invalid_or_expired_code" });
    const tokenUser = crypto_1.default.randomBytes(16).toString("hex");
    bindings.set(tokenUser, data.uuid);
    links.delete(code);
    res.json({ tokenUser, playerName: data.name });
});
// 3) Lo llama la APP: crea una “orden de compra” (dar ítem)
app.post("/purchase", (req, res) => {
    const { tokenUser, itemId, amount } = req.body || {};
    if (!tokenUser || !bindings.has(tokenUser))
        return res.status(401).json({ error: "unauthorized" });
    // Whitelist mínima
    const okItems = new Set(["minecraft:diamond", "minecraft:bread", "minecraft:iron_ingot"]);
    if (!okItems.has(String(itemId)))
        return res.status(400).json({ error: "invalid_item" });
    const amt = Number(amount || 0);
    if (!Number.isInteger(amt) || amt < 1 || amt > 64)
        return res.status(400).json({ error: "invalid_amount" });
    const playerUuid = bindings.get(tokenUser);
    const id = crypto_1.default.randomUUID();
    tasks.push({ id, playerUuid, itemId, amount: amt, message: "Compra completada" });
    res.json({ ok: true });
});
// 4) Lo llama el plugin: obtiene tareas pendientes
app.get("/tasks/pull", (_req, res) => {
    res.json(tasks);
});
// 5) Lo llama el plugin: confirma tareas entregadas
app.post("/tasks/ack", (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids))
        return res.status(400).json({ error: "ids_required" });
    for (const id of ids) {
        const i = tasks.findIndex(t => t.id === id);
        if (i >= 0)
            tasks.splice(i, 1);
    }
    res.json({ ok: true });
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API lista en http://localhost:${PORT}`));
