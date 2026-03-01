const express = require("express");
const { Client } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post("/api/quests", async (req, res) => {
  const { nome_paciente, descricao, moedas = 0, level = 1, ganha_carta = false } = req.body;

  if (!nome_paciente || !descricao) {
    return res.status(400).json({ error: "nome_paciente e descricao são obrigatórios" });
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    // 1. Buscar Player pelo nome
    const playersRes = await client.query(
      `SELECT "Id" FROM "Players" WHERE LOWER(TRIM("Name")) = LOWER(TRIM($1)) AND ("IsDeleted" IS NULL OR "IsDeleted" = false) LIMIT 1`,
      [nome_paciente]
    );

    if (playersRes.rows.length === 0) {
      return res.status(404).json({ error: `Player "${nome_paciente}" não encontrado` });
    }

    const playerId = playersRes.rows[0].Id;

    // 2. Criar Quest
    const questRes = await client.query(
      `INSERT INTO "Quests" ("Description", "CoinToEarn", "LevelToEarn", "Status", "CreatedAt", "CreatedDate", "IsSequential", "Order")
       VALUES ($1, $2, $3, 0, NOW(), NOW(), false, 0)
       RETURNING "Id"`,
      [descricao, moedas, level]
    );

    const questId = questRes.rows[0].Id;

    // 3. Vincular Quest ao Player
    await client.query(
      `INSERT INTO "QuestPlayer" ("QuestId", "PlayerId") VALUES ($1, $2)`,
      [questId, playerId]
    );

    // 4. Se ganha carta, vincular carta aleatória
    if (ganha_carta) {
      const cardsRes = await client.query(
        `SELECT "Id" FROM "Cards" WHERE ("IsDeleted" IS NULL OR "IsDeleted" = false) AND "Quantidade" > 0 ORDER BY RANDOM() LIMIT 1`
      );
      if (cardsRes.rows.length > 0) {
        await client.query(
          `INSERT INTO "QuestCard" ("QuestId", "CardId") VALUES ($1, $2)`,
          [questId, cardsRes.rows[0].Id]
        );
      }
    }

    res.json({ success: true, quest: { id: questId, playerId, descricao, moedas, level, ganha_carta } });
  } catch (err) {
    console.error("Erro:", err);
    res.status(500).json({ error: err.message });
  } finally {
    await client.end();
  }
});

app.listen(PORT, () => console.log(`Bridge API rodando na porta ${PORT}`));
