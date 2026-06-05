import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const POSTED_FILE = path.join(DATA_DIR, 'posted_articles.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure files exist with defaults
if (!fs.existsSync(POSTED_FILE)) {
  fs.writeFileSync(POSTED_FILE, JSON.stringify([], null, 2), 'utf-8');
}
if (!fs.existsSync(LOGS_FILE)) {
  fs.writeFileSync(LOGS_FILE, JSON.stringify([], null, 2), 'utf-8');
}

export function getPostedArticles() {
  try {
    const data = fs.readFileSync(POSTED_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading posted articles database:', err);
    return [];
  }
}

export function savePostedArticles(articles) {
  try {
    fs.writeFileSync(POSTED_FILE, JSON.stringify(articles, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing to posted articles database:', err);
  }
}

export function markAsPosted(url) {
  const posted = getPostedArticles();
  if (!posted.includes(url)) {
    posted.push(url);
    savePostedArticles(posted);
    console.log(`[Database] Marked URL as posted: ${url}`);
  }
}

export function clearPostedArticles() {
  savePostedArticles([]);
  console.log('[Database] Reset posted articles history.');
}

export function getLogs() {
  try {
    const data = fs.readFileSync(LOGS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading execution logs:', err);
    return [];
  }
}

export function addLog(logEntry) {
  try {
    const logs = getLogs();
    const entry = {
      timestamp: new Date().toISOString(),
      ...logEntry
    };
    logs.push(entry);
    
    // Keep logs file clean by capping at 200 items
    if (logs.length > 200) {
      logs.shift();
    }
    
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing to logs file:', err);
  }
}
