const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// POST /api/quests — cria tarefa para um paciente
app.post('/api/quests', async (req, res) => {
  const { nome_paciente, descricao, moedas = 0, level = 1, ganha_carta = false } = req.body;

  if (!nome_paciente || !descricao) {
    return res.status(400).json({ error: 'nome_paciente e descricao são obrigatórios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Players: Id(bigint), Name(text), Level(bigint), Coin(bigint), IsDeleted(boolean)
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

    // Quests: Id(bigint auto), Description(text), CoinToEarn(bigint), LevelToEarn(bigint), 
    //         Status(int), CreatedAt(timestamptz), CreatedDate(timestamptz), 
    //         IsSequential(bool), Order(int)
    const questResult = await client.query(
      `INSERT INTO heroku."Quests" 
       ("Description", "CoinToEarn", "LevelToEarn", "Status", "CreatedAt", "CreatedDate", "IsSequential", "Order")
       VALUES ($1, $2, $3, 0, NOW(), NOW(), false, 0)
       RETURNING "Id"`,
      [descricao, moedas, level]
    );
    const questId = questResult.rows[0].Id;

    // QuestPlayer: QuestId(bigint), PlayerId(bigint)
    await client.query(
      `INSERT INTO heroku."QuestPlayer" ("QuestId", "PlayerId") VALUES ($1, $2)`,
      [questId, player.Id]
    );

    // Se ganha carta, sortear uma aleatória
    // QuestCard: QuestId(bigint), CardId(bigint)
    // Cards: Id(bigint), Name(text), Rarity(int), IsDeleted(boolean)
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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'qgtasks-bridge' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bridge running on port ${PORT}`));
