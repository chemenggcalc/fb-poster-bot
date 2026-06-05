import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file
dotenv.config({ path: path.join(__dirname, '.env') });

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY,
  fbPageAccessToken: process.env.FB_PAGE_ACCESS_TOKEN,
  fbPageId: process.env.FB_PAGE_ID,
  rssFeedUrl: process.env.RSS_FEED_URL,
  websiteUrl: process.env.WEBSITE_URL,
  cronSchedule: process.env.CRON_SCHEDULE || '0 9 * * *',
  systemInstruction: process.env.SYSTEM_INSTRUCTION || 'You are a social media copywriter. Write a highly engaging Facebook post summarizing the following article. Use emojis, appropriate spacing/paragraphs, and 3-5 relevant hashtags. Maintain an informative and inviting tone. Do not add any intros like "Here is a post:".',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  resetHistoryWhenExhausted: process.env.RESET_POSTING_HISTORY_WHEN_EXHAUSTED === 'true',
};

// Validate critical variables (warn if missing)
export function validateConfig() {
  const missing = [];
  if (!config.geminiApiKey) missing.push('GEMINI_API_KEY');
  if (!config.fbPageAccessToken) missing.push('FB_PAGE_ACCESS_TOKEN');
  if (!config.fbPageId) missing.push('FB_PAGE_ID');
  if (!config.rssFeedUrl && !config.websiteUrl) missing.push('RSS_FEED_URL or WEBSITE_URL');

  if (missing.length > 0) {
    console.warn(`[Config Warning] The following environment variables are missing in your .env: ${missing.join(', ')}`);
    console.warn('Please copy .env.example to .env and configure these keys.');
    return false;
  }
  return true;
}
