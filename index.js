const express = require('express');
const { Pool, Client } = require('pg');
const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const WEBHOOK_URL = 'https://kmrgqtzovewplbwxjwtm.supabase.co/functions/v1/webhook-quest-concluida';

// === Setup: criar coluna TrilhaPacienteId + trigger ===
async function setupTrigger() {
  try {
    // Adicionar coluna TrilhaPacienteId se não existir
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'heroku' AND table_name = 'Quests' AND column_name = 'TrilhaPacienteId'
        ) THEN
          ALTER TABLE heroku."Quests" ADD COLUMN "TrilhaPacienteId" text DEFAULT NULL;
        END IF;
      END $$;
    `);
    console.log('Coluna TrilhaPacienteId verificada/criada.');

    // Trigger que envia quest_id + status + trilha_paciente_id
    await pool.query(`
      CREATE OR REPLACE FUNCTION heroku.notify_quest_completed()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."Status" IN (1, 2) AND (OLD."Status" IS NULL OR OLD."Status" = 0) THEN
          PERFORM pg_notify(
            'quest_status_changed',
            NEW."Id"::text || ':' || NEW."Status"::text || ':' || COALESCE(NEW."TrilhaPacienteId", '')
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_quest_completed ON heroku."Quests";
      CREATE TRIGGER trg_quest_completed
      AFTER UPDATE ON heroku."Quests"
      FOR EACH ROW
      EXECUTE FUNCTION heroku.notify_quest_completed();
    `);
    console.log('Trigger quest_status_changed configurado!');
  } catch (err) {
    console.error('Erro ao configurar trigger:', err.message);
  }
}

// === Listener: escuta quests concluídas/falhadas e dispara webhook ===
async function startQuestListener() {
  let client;
  try {
    client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    await client.query('LISTEN quest_status_changed');
    console.log('Listening for quest status changes...');

    client.on('notification', async (msg) => {
      const parts = msg.payload.split(':');
      const questId = parts[0];
      const status = parts[1];
      const trilhaPacienteId = parts[2] || null;
      const questStatus = status === '1' ? 'completed' : 'failed';

      console.log(`Quest ${questId} status: ${questStatus}, trilha_paciente_id: ${trilhaPacienteId || 'nenhum'}`);

      try {
        const webhookBody = {
          quest_id: questId,
          quest_status: questStatus,
        };
        // Enviar trilha_paciente_id se disponível (identificação precisa)
        if (trilhaPacienteId) {
          webhookBody.trilha_paciente_id = trilhaPacienteId;
        }

        const response = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookBody),
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
  const { nome_paciente, descricao, moedas = 2, level = 2, ganha_carta = false, trilha_paciente_id } = req.body;

  if (!nome_paciente || !descricao) {
    return res.status(400).json({ error: 'nome_paciente e descricao são obrigatórios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Tentar match exato primeiro
    let playerResult = await client.query(
      `SELECT "Id", "Name" FROM heroku."Players"
       WHERE LOWER(TRIM("Name")) = LOWER(TRIM($1))
       AND ("IsDeleted" IS NULL OR "IsDeleted" = false)
       LIMIT 1`,
      [nome_paciente]
    );

    // Se não encontrou, tentar pelo primeiro nome
    if (playerResult.rows.length === 0) {
      const firstName = nome_paciente.trim().split(' ')[0];
      playerResult = await client.query(
        `SELECT "Id", "Name" FROM heroku."Players"
         WHERE LOWER(TRIM("Name")) = LOWER(TRIM($1))
         AND ("IsDeleted" IS NULL OR "IsDeleted" = false)
         LIMIT 1`,
        [firstName]
      );
    }

    if (playerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `Jogador "${nome_paciente}" não encontrado` });
    }

    const player = playerResult.rows[0];

    // Criar quest COM trilha_paciente_id
    const questResult = await client.query(
      `INSERT INTO heroku."Quests"
       ("Description", "CoinToEarn", "LevelToEarn", "Status", "CreatedAt", "CreatedDate", "IsSequential", "Order", "TrilhaPacienteId")
       VALUES ($1, $2, $3, 0, NOW(), NOW(), false, 0, $4)
       RETURNING "Id"`,
      [descricao, moedas, level, trilha_paciente_id || null]
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

// POST /api/players — cria jogador se não existir
app.post('/api/players', async (req, res) => {
  const { nome } = req.body;
  if (!nome) {
    return res.status(400).json({ error: 'nome é obrigatório' });
  }

  try {
    // Verificar se já existe
    const existing = await pool.query(
      `SELECT "Id", "Name" FROM heroku."Players"
       WHERE LOWER(TRIM("Name")) = LOWER(TRIM($1))
       AND ("IsDeleted" IS NULL OR "IsDeleted" = false)
       LIMIT 1`,
      [nome]
    );

    if (existing.rows.length > 0) {
      return res.json({ success: true, player: existing.rows[0], already_existed: true });
    }

    // Criar novo
    const result = await pool.query(
      `INSERT INTO heroku."Players" ("Name", "CreatedAt", "IsDeleted")
       VALUES ($1, NOW(), false)
       RETURNING "Id", "Name"`,
      [nome.trim()]
    );

    res.json({ success: true, player: result.rows[0], already_existed: false });
  } catch (err) {
    console.error('Erro ao criar player:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quests/player/:name — lista quests pendentes
app.get('/api/quests/player/:name', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT q."Id", q."Description", q."CoinToEarn", q."LevelToEarn", q."Status", q."CreatedAt", q."TrilhaPacienteId"
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
  setupTrigger()
    .then(() => startQuestListener())
    .catch(err => console.error('Init error:', err.message));
});
