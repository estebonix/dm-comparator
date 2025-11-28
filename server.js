require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

// Usamos la librería de OpenAI para conectar con Groq (estándar compatible)
const OpenAI = require("openai");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// --- BASE DE DATOS ---
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error("Error abriendo BD:", err.message);
    else console.log("Conectado a la base de datos SQLite.");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_prompt TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER,
        dm_id INTEGER, 
        role TEXT,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
    )`);
});

// --- CONFIGURACIÓN API (SOLO GROQ) ---
const groqClient = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1" 
});

// --- RUTAS ---

// 1. Iniciar Partida
app.post('/api/start', async (req, res) => {
    const { systemPrompt } = req.body;
    
    db.run("INSERT INTO games (system_prompt) VALUES (?)", [systemPrompt], async function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        const gameId = this.lastID;
        // Prompt simplificado para que no repitan tanto texto al inicio
        const introTrigger = "Narra la introducción de la aventura basándote en el contexto proporcionado. Sé breve y directo.";

        try {
            const results = await Promise.allSettled([
                callLlamaFastViaGroq(systemPrompt, [], introTrigger),
                callLlamaSmartViaGroq(systemPrompt, [], introTrigger)
            ]);

            const intro1 = results[0].status === 'fulfilled' ? results[0].value : "Error generando intro.";
            const intro2 = results[1].status === 'fulfilled' ? results[1].value : "Error generando intro.";

            await saveMessage(gameId, 1, 'model', intro1);
            await saveMessage(gameId, 2, 'model', intro2);

            res.json({ 
                gameId: gameId, 
                message: "Partida iniciada",
                dm1: intro1,
                dm2: intro2
            });

        } catch (error) {
            console.error("Error en intro:", error);
            res.status(500).json({ error: "Error generando introducción" });
        }
    });
});

// 2. Turno
app.post('/api/turn', async (req, res) => {
    const { gameId, userAction } = req.body;

    try {
        const game = await new Promise((resolve, reject) => {
            db.get("SELECT system_prompt FROM games WHERE id = ?", [gameId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!game) return res.status(404).json({ error: "Partida no encontrada" });

        await saveMessage(gameId, 0, 'user', userAction);

        const history1 = await getHistory(gameId, 1);
        const history2 = await getHistory(gameId, 2);

        const results = await Promise.allSettled([
            callLlamaFastViaGroq(game.system_prompt, history1, userAction),
            callLlamaSmartViaGroq(game.system_prompt, history2, userAction)
        ]);

        const response1 = results[0].status === 'fulfilled' ? results[0].value : "Error: " + results[0].reason;
        const response2 = results[1].status === 'fulfilled' ? results[1].value : "Error: " + results[1].reason;

        await saveMessage(gameId, 1, 'model', response1);
        await saveMessage(gameId, 2, 'model', response2);

        res.json({ dm1: response1, dm2: response2 });

    } catch (error) {
        console.error("Error crítico:", error);
        res.status(500).json({ error: error.message });
    }
});

// 3. Historial de mensajes (Cargar Partida)
app.get('/api/history/:gameId', (req, res) => {
    const gameId = req.params.gameId;
    db.all("SELECT * FROM messages WHERE game_id = ? ORDER BY timestamp ASC", [gameId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 4. Listar todas las partidas (NUEVO)
app.get('/api/games', (req, res) => {
    // Intentamos extraer el nombre del personaje del prompt si es posible, sino mostramos fecha
    db.all("SELECT id, created_at, system_prompt FROM games ORDER BY created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 5. Eliminar partida (NUEVO)
app.delete('/api/games/:id', (req, res) => {
    const id = req.params.id;
    // Borramos mensajes primero (aunque con CASCADE no haría falta en BBDD serias, SQLite a veces requiere config)
    db.run("DELETE FROM messages WHERE game_id = ?", [id], (err) => {
        if(err) console.error(err);
        db.run("DELETE FROM games WHERE id = ?", [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Partida eliminada", deleted: this.changes });
        });
    });
});

// --- FUNCIONES BBDD ---
function saveMessage(gameId, dmId, role, content) {
    return new Promise((resolve, reject) => {
        db.run("INSERT INTO messages (game_id, dm_id, role, content) VALUES (?, ?, ?, ?)", 
            [gameId, dmId, role, content], (err) => {
                if (err) reject(err);
                else resolve();
        });
    });
}

function getHistory(gameId, dmId) {
    return new Promise((resolve, reject) => {
        db.all("SELECT role, content FROM messages WHERE game_id = ? AND (dm_id = 0 OR dm_id = ?) ORDER BY id ASC", 
            [gameId, dmId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
        });
    });
}

// --- LÓGICA IAs ---
async function callLlamaFastViaGroq(system, history, currentInput) {
    const messages = [{ role: "system", content: system }];
    history.forEach(msg => {
        const role = msg.role === 'model' ? 'assistant' : msg.role;
        messages.push({ role: role, content: msg.content });
    });
    messages.push({ role: "user", content: currentInput });

    const completion = await groqClient.chat.completions.create({
        messages: messages,
        model: "llama-3.1-8b-instant", 
    });
    return completion.choices[0].message.content;
}

async function callLlamaSmartViaGroq(system, history, currentInput) {
    const messages = [{ role: "system", content: system }];
    history.forEach(msg => {
        const role = msg.role === 'model' ? 'assistant' : msg.role;
        messages.push({ role: role, content: msg.content });
    });
    messages.push({ role: "user", content: currentInput });

    const completion = await groqClient.chat.completions.create({
        messages: messages,
        model: "llama-3.3-70b-versatile", 
    });
    return completion.choices[0].message.content;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});