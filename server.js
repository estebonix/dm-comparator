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
        FOREIGN KEY(game_id) REFERENCES games(id)
    )`);
});

// --- CONFIGURACIÓN API (SOLO GROQ) ---
// Usamos Groq para acceder tanto a modelos de Google como de Meta
const groqClient = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1" 
});

// --- RUTAS ---

app.post('/api/start', (req, res) => {
    const { systemPrompt } = req.body;
    const stmt = db.prepare("INSERT INTO games (system_prompt) VALUES (?)");
    stmt.run(systemPrompt, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ gameId: this.lastID, message: "Partida iniciada" });
    });
    stmt.finalize();
});

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

        // Guardar acción usuario
        await saveMessage(gameId, 0, 'user', userAction);

        // Obtener historiales
        const history1 = await getHistory(gameId, 1);
        const history2 = await getHistory(gameId, 2);

        // Llamada a APIs en Paralelo (Ambas a Groq, pero distintos modelos)
        const results = await Promise.allSettled([
            callGoogleViaGroq(game.system_prompt, history1, userAction),
            callMetaViaGroq(game.system_prompt, history2, userAction)
        ]);

        // Extraer resultados
        const response1 = results[0].status === 'fulfilled' ? results[0].value : "Error Google/Gemma: " + results[0].reason;
        const response2 = results[1].status === 'fulfilled' ? results[1].value : "Error Meta/Llama: " + results[1].reason;

        if (results[0].status === 'rejected') console.error("FALLO MODELO 1:", results[0].reason);
        if (results[1].status === 'rejected') console.error("FALLO MODELO 2:", results[1].reason);

        // Guardar respuestas
        await saveMessage(gameId, 1, 'model', response1);
        await saveMessage(gameId, 2, 'model', response2);

        res.json({ dm1: response1, dm2: response2 });

    } catch (error) {
        console.error("Error crítico:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/history/:gameId', (req, res) => {
    const gameId = req.params.gameId;
    db.all("SELECT * FROM messages WHERE game_id = ? ORDER BY timestamp ASC", [gameId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
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

// --- LÓGICA IAs (Unificadas en Groq) ---

async function callGoogleViaGroq(system, history, currentInput) {
    const messages = [{ role: "system", content: system }];
    history.forEach(msg => messages.push({ role: msg.role, content: msg.content }));
    messages.push({ role: "user", content: currentInput });

    const completion = await groqClient.chat.completions.create({
        messages: messages,
        // MODELO DE GOOGLE (Gemma 2) corriendo en Groq
        model: "gemma2-9b-it", 
    });
    return completion.choices[0].message.content;
}

async function callMetaViaGroq(system, history, currentInput) {
    const messages = [{ role: "system", content: system }];
    history.forEach(msg => messages.push({ role: msg.role, content: msg.content }));
    messages.push({ role: "user", content: currentInput });

    const completion = await groqClient.chat.completions.create({
        messages: messages,
        // MODELO DE META (Llama 3.3) corriendo en Groq
        model: "llama-3.3-70b-versatile", 
    });
    return completion.choices[0].message.content;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});