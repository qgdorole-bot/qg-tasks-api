const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Endpoint para receber tarefas
app.post('/api/tasks', async (req, res) => {
  const { descricao, nome_paciente, grupo, moedas, level, ganha_carta } = req.body;
  
  if (!descricao || !nome_paciente) {
    return res.status(400).json({ error: 'descricao e nome_paciente são obrigatórios' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO tasks (descricao, nome_paciente, grupo, moedas, level, ganha_carta, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [descricao, nome_paciente, grupo, moedas || 0, level || 1, ganha_carta || false]
    );
    res.json({ success: true, task: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.listen(process.env.PORT || 3000);
