const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Connect to database file (or create it if it doesn't exist)
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

// Create the logs table if it doesn't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reference TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

module.exports = db;
