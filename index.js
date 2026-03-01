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
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgnam
