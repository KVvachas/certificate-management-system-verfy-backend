import pg from "pg";
const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://neondb_owner:npg_EuyF2zAinTd6@ep-lucky-term-b5e7qfny-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString });

async function migrate() {
  console.log("Connecting to live database...");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id SERIAL PRIMARY KEY,
      activity VARCHAR(100) NOT NULL,
      who VARCHAR(255),
      token VARCHAR(255),
      certificate_number VARCHAR(255),
      event_name VARCHAR(255),
      status VARCHAR(50),
      ip VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_token ON activity_logs (token);
  `);

  console.log("Table 'activity_logs' created successfully!");

  // Insert initial seed logs if table is empty
  const countRes = await pool.query("SELECT COUNT(*) AS count FROM activity_logs");
  if (Number(countRes.rows[0].count) === 0) {
    console.log("Inserting initial audit records into activity_logs...");
    await pool.query(`
      INSERT INTO activity_logs (activity, who, token, certificate_number, event_name, status, ip, created_at)
      VALUES 
        ('Verification', 'Alice Johnson', 'a8f72c91e4f', 'CERT-2024-4567', 'National Tech Symposium 2024', 'Valid', '103.212.144.18', NOW() - INTERVAL '15 minutes'),
        ('Download Certificate', 'Alice Johnson', 'a8f72c91e4f', 'CERT-2024-4567', 'National Tech Symposium 2024', 'Downloaded', '103.212.144.18', NOW() - INTERVAL '14 minutes'),
        ('Verification', 'David Kumar', 'b9e41d83c2a', 'CERT-2024-1182', 'AI & Cloud Summit 2024', 'Valid', '49.37.152.84', NOW() - INTERVAL '45 minutes'),
        ('Download Certificate', 'David Kumar', 'b9e41d83c2a', 'CERT-2024-1182', 'AI & Cloud Summit 2024', 'Downloaded', '49.37.152.84', NOW() - INTERVAL '42 minutes');
    `);
    console.log("Seeded 4 initial records.");
  }

  const cols = await pool.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'activity_logs';
  `);
  console.log("Columns in activity_logs:", cols.rows.map(r => `${r.column_name} (${r.data_type})`).join(", "));

  const sample = await pool.query("SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 5");
  console.log("Current activity_logs records:", sample.rows.length);

  await pool.end();
}

migrate().catch(e => {
  console.error("Migration error:", e);
  process.exit(1);
});
