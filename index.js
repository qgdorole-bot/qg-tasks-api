const express = require('express');
const { Pool, Client } = require('pg');

const app = express();
app.use(express.json({ limit: '5mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
});

const WEBHOOK_URL = 'https://kmrgqtzovewplbwxjwtm.supabase.co/functions/v1/webhook-quest-concluida';

async function setupTrigger() {
  try {
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
        const webhookBody = { quest_id: questId, quest_status: questStatus };
        if (trilhaPacienteId) webhookBody.trilha_paciente_id = trilhaPacienteId;

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

// Helper: buscar player por nome
async function findPlayer(client, nome) {
  let result = await client.query(
    `SELECT "Id", "Name" FROM heroku."Players"
     WHERE LOWER(TRIM("Name")) = LOWER(TRIM($1))
     AND ("IsDeleted" IS NULL OR "IsDeleted" = false)
     LIMIT 1`,
    [nome]
  );
  if (result.rows.length === 0) {
    const firstName = nome.trim().split(' ')[0];
    result = await client.query(
      `SELECT "Id", "Name" FROM heroku."Players"
       WHERE LOWER(TRIM("Name")) = LOWER(TRIM($1))
       AND ("IsDeleted" IS NULL OR "IsDeleted" = false)
       LIMIT 1`,
      [firstName]
    );
  }
  return result.rows[0] || null;
}

// Helper: criar quest + vínculos
async function createQuest(client, player, descricao, moedas, level, ganha_carta, trilha_paciente_id) {
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

  return { id: questId, player: player.Name, description: descricao, coins: moedas, level, card: cardId, trilha_paciente_id: trilha_paciente_id || null };
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
    const player = await findPlayer(client, nome_paciente);
    if (!player) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `Jogador "${nome_paciente}" não encontrado` });
    }
    const quest = await createQuest(client, player, descricao, moedas, level, ganha_carta, trilha_paciente_id);
    await client.query('COMMIT');
    res.json({ success: true, quest });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar quest:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/quests/batch — cria tarefas em lote (uma transação)
app.post('/api/quests/batch', async (req, res) => {
  const { quests } = req.body;
  if (!Array.isArray(quests) || quests.length === 0) {
    return res.status(400).json({ error: 'quests array é obrigatório' });
  }

  const client = await pool.connect();
  const results = [];
  try {
    await client.query('BEGIN');

    for (let i = 0; i < quests.length; i++) {
      const { nome_paciente, descricao, moedas = 2, level = 2, ganha_carta = false, trilha_paciente_id } = quests[i];
      if (!nome_paciente || !descricao) {
        results.push({ success: false, index: i, error: 'nome_paciente e descricao obrigatórios' });
        continue;
      }
      try {
        const player = await findPlayer(client, nome_paciente);
        if (!player) {
          results.push({ success: false, index: i, error: `Jogador "${nome_paciente}" não encontrado` });
          continue;
        }
        const quest = await createQuest(client, player, descricao, moedas, level, ganha_carta, trilha_paciente_id);
        results.push({ success: true, index: i, quest });
      } catch (itemErr) {
        results.push({ success: false, index: i, error: itemErr.message });
      }
    }

    await client.query('COMMIT');
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`Batch: ${succeeded} ok, ${failed} failed out of ${quests.length}`);
    res.json({ success: true, total: quests.length, succeeded, failed, results });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro no batch:', err);
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

// DELETE /api/quests/:id — deleta quest pendente
app.delete('/api/quests/:id', async (req, res) => {
  const questId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM heroku."QuestPlayer" WHERE "QuestId" = $1', [questId]);
    await client.query('DELETE FROM heroku."QuestCard" WHERE "QuestId" = $1', [questId]);
    const result = await client.query(
      'DELETE FROM heroku."Quests" WHERE "Id" = $1 AND "Status" = 0 RETURNING "Id"',
      [questId]
    );
    await client.query('COMMIT');
    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'Quest não encontrada ou já concluída' });
    }
    res.json({ success: true, deleted: questId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao deletar quest:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'qgtasks-bridge' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bridge running on port ${PORT}`);
  setupTrigger()
    .then(() => startQuestListener())
    .catch(err => console.error('Init error:', err.message));
});
