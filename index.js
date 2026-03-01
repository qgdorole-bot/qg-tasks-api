const express = require('express');
const { Pool, Client } = require('pg');
const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const WEBHOOK_URL = 'https://kmrgqtzovewplbwxjwtm.supabase.co/functions/v1/webhook-quest-concluida';

// === Setup: criar trigger no banco se não existir ===
async function setupTrigger() {
  try {
    await pool.query(`
      CREATE OR REPLACE FUNCTION heroku.notify_quest_completed()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."Status" = 1 AND (OLD."Status" IS NULL OR OLD."Status" != 1) THEN
          PERFORM pg_notify('quest_completed', NEW."Id"::text);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_quest_completed') THEN
          CREATE TRIGGER trg_quest_completed
          AFTER UPDATE ON heroku."Quests"
          FOR EACH ROW
          EXECUTE FUNCTION heroku.notify_quest_completed();
        END IF;
      END $$;
    `);
    console.log('Trigger quest_completed configurado!');
  } catch (err) {
    console.error('Erro ao configurar trigger:', err.message);
  }
}

// === Listener: escuta quests concluídas e dispara webhook ===
async function startQuestListener() {
  let client;
  try {
    client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });

    await client.connect();
    await client.query('LISTEN quest_completed');
    console.log('Listening for quest completions...');

    client.on('notification', async (msg) => {
      const questId = msg.payload;
      console.log('Quest completed:', questId);

      try {
        const response = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quest_id: questId }),
        });
        const body = await response.text();
        console.log('Webhook response:', response.status, body);
      } catch (err) {
        console.error('Webhook error:', err.message);
      }
    });

    client.on('error', (err) => {
      console.error('Listener connection error:', err.message);
      try { client.end(); } catch (e) {}
      setTimeout(startQuestListener, 5000);
    });

    client.on('end', () => {
      console.log('Listener disconnected, reconnecting...');
      setTimeout(startQuestListener, 5000);
    });

  } catch (err) {
    console.error('Failed to start listener:', err.message);
    if (client) { try { client.end(); } catch (e) {} }
    setTimeout(startQuestListener, 5000);
  }
}

// POST /api/quests — cria tarefa para um paciente
app.post('/api/quests', async (req, res) => {
  const { nome_paciente, descricao, moedas = 0, level = 1, ganha_carta = false, trilha_paciente_id } = req.body;

  if (!nome_paciente || !descricao) {
    return res.status(400).json({ error: 'nome_paciente e descricao são obrigatórios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const playerResult = await client.query(
      `SELECT "Id", "Name" FROM heroku."Players" 
       WHERE LOWER(TRIM("Name")) = LOWER(TRIM($1)) 
       AND ("IsDeleted" IS NULL OR "IsDeleted" = false)
       LIMIT 1`,
      [nome_paciente]
    );

    if (playerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `Jogador "${nome_paciente}" não encontrado` });
    }

    const player = playerResult.rows[0];

    const questResult = await client.query(
      `INSERT INTO heroku."Quests" 
       ("Description", "CoinToEarn", "LevelToEarn", "Status", "CreatedAt", "CreatedDate", "IsSequential", "Order")
       VALUES ($1, $2, $3, 0, NOW(), NOW(), false, 0)
       RETURNING "Id"`,
      [descricao, moedas, level]
    );

    const questId = questResult.rows[0].Id;

    await client.query(
      `INSERT INTO heroku."QuestPlayer" ("QuestId", "PlayerId") VALUES ($1, $2)`,
      [questId, player.Id]
    );

    let cardId = null;
    if (ganha_carta) {
      const cardResult = await client.query(
        `SELECT "Id" FROM heroku."Cards" 
         WHERE ("IsDeleted" IS NULL OR "IsDeleted" = false)
         ORDER BY RANDOM() LIMIT 1`
      );
      if (cardResult.rows.length > 0) {
        cardId = cardResult.rows[0].Id;
        await client.query(
          `INSERT INTO heroku."QuestCard" ("QuestId", "CardId") VALUES ($1, $2)`,
          [questId, cardId]
        );
      }
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      quest: {
        id: questId,
        player: player.Name,
        description: descricao,
        coins: moedas,
        level,
        card: cardId,
        trilha_paciente_id: trilha_paciente_id || null,
      },
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar quest:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/quests/player/:name — lista quests pendentes
app.get('/api/quests/player/:name', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT q."Id", q."Description", q."CoinToEarn", q."LevelToEarn", q."Status", q."CreatedAt"
       FROM heroku."Quests" q
       JOIN heroku."QuestPlayer" qp ON qp."QuestId" = q."Id"
       JOIN heroku."Players" p ON p."Id" = qp."PlayerId"
       WHERE LOWER(TRIM(p."Name")) = LOWER(TRIM($1))
       AND q."Status" = 0
       ORDER BY q."CreatedAt" DESC`,
      [req.params.name]
    );
    res.json({ quests: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'qgtasks-bridge' });
});

// Inicializar
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bridge running on port ${PORT}`);
  // Setup trigger e listener APÓS o servidor iniciar
  setupTrigger()
    .then(() => startQuestListener())
    .catch(err => console.error('Init error:', err.message));
});
