// db.js
const fs      = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path    = require('path');

// 1) Build path and ensure folder exists
const dbDir  = path.resolve(__dirname, 'db');
const dbPath = path.join(dbDir, 'wakatv.sqlite');
fs.mkdirSync(dbDir, { recursive: true });

// 2) Open (or create) the DB
const db = new sqlite3.Database(dbPath, err => {
  if (err) {
    console.error('❌ Error opening database:', err.message);
    process.exit(1);
  }
  console.log('✅ Connected to SQLite DB at', dbPath);
});

// 3) Run your migrations in serialized order
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT    NOT NULL,
      amount     INTEGER NOT NULL,
      reference  TEXT    NOT NULL,
      timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, err => {
    if (err) console.error('❌ Error creating logs table:', err.message);
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS codes (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      code     TEXT    NOT NULL UNIQUE,
      used     INTEGER NOT NULL DEFAULT 0,
      usedBy   TEXT,
      usedAt   DATETIME
    )
  `, err => {
    if (err) console.error('❌ Error creating codes table:', err.message);
  });
});

// 4) Promise‐friendly wrappers
db.runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve(this); // you can use this.lastID or this.changes
    });
  });

db.getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) =>
      err ? reject(err) : resolve(row)
    );
  });

db.allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) =>
      err ? reject(err) : resolve(rows)
    );
  });

module.exports = db;
