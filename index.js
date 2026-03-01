const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.post('/api/quests', async (req, res) => {
  const { nome_paciente, descricao, moedas = 0, level = 1, ganha_carta = false } = req.body;

  if (!nome_paciente || !descricao) {
    return res.status(400).json({ error: 'nome_paciente e descricao são obrigatórios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const playerResult = await client.query(
      `SELECT "Id", "Name" FROM heroku."Players" WHERE LOWER(TRIM("Name")) = LOWER(TRIM($1)) LIMIT 1`,
      [nome_paciente]
    );

    if (playerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `Jogador "${nome_paciente}" não encontrado` });
    }

    const player = playerResult.rows[0];

    const questResult = await client.query(
      `INSERT INTO heroku."Quests" ("Description", "CoinToEarn", "LevelToEarn", "Status", "CreatedAt", "CreatedDate", "IsSequential", "Order")
       VALUES ($1, $2, $3, 1, NOW(), NOW(), false, 0)
       RETURNING "Id"`,
      [descricao, moedas, level]
    );
    const questId = questResult.rows[0].Id;

    await client.query(
      `INSERT INTO heroku."QuestPlayer" ("QuestsId", "PlayersId")
       VALUES ($1, $2)`,
      [questId, player.Id]
    );

    let cardId = null;
    if (ganha_carta) {
      const cardResult = await client.query(
        `SELECT "Id" FROM heroku."Cards" ORDER BY RANDOM() LIMIT 1`
      );
      if (cardResult.rows.length > 0) {
        cardId = cardResult.rows[0].Id;
        await client.query(
          `INSERT INTO heroku."QuestCard" ("QuestsId", "CardsId")
           VALUES ($1, $2)`,
          [questId, cardId]
        );
      }
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      quest: { id: questId, player: player.Name, description: descricao, coins: moedas, level, card: cardId },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar quest:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'qgtasks-bridge' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bridge running on port ${PORT}`));
