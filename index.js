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
      ssl: {
