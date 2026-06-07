import axios from 'axios';
import * as cheerio from 'cheerio';
import { config } from './config.js';

const SCRAPE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
  'Referer': config.websiteUrl || 'https://chemenggcalc.com/',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
};

/**
 * Helper: sleep for given milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper: Fetch a URL with retry logic and delays between attempts.
 * Retries up to `maxRetries` times with increasing delays to handle Cloudflare throttling.
 * @param {string} url - URL to fetch
 * @param {object} options - Axios options
 * @param {number} maxRetries - Max retry attempts (default 3)
 * @returns {Promise<object>} - Axios response
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  const delays = [3000, 6000, 10000]; // 3s, 6s, 10s between retries

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: SCRAPE_HEADERS,
        timeout: 20000,
        ...options,
      });
      return res;
    } catch (error) {
      const status = error.response?.status;
      console.warn(`[Scraper] Attempt ${attempt}/${maxRetries} failed for ${url} (${status || error.message})`);

      if (attempt < maxRetries) {
        const waitTime = delays[attempt - 1] || 5000;
        console.log(`[Scraper] Waiting ${waitTime / 1000}s before retry...`);
        await sleep(waitTime);
      } else {
        throw error; // All retries exhausted
      }
    }
  }
}

/**
 * Fetch post URLs from RSS feed.
 * @returns {Promise<Array<string>>}
 */
async function getUrlsFromRSS(rssFeedUrl) {
  const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssFeedUrl)}`;
  console.log(`[Scraper] Trying RSS feed via proxy: ${proxyUrl}`);
  try {
    const res = await fetchWithRetry(proxyUrl);
    if (res.data && res.data.status === 'ok' && Array.isArray(res.data.items)) {
      const urls = res.data.items.map(item => item.link).filter(Boolean);
      if (urls.length > 0) {
        console.log(`[Scraper] Found ${urls.length} post URLs from RSS feed via proxy.`);
        return urls;
      }
    }
    console.warn(`[Scraper Warning] RSS proxy returned status: ${res.data?.status}`);
  } catch (e) {
    console.warn(`[Scraper Warning] RSS proxy failed: ${e.message}`);
  }

  // Fallback to direct fetch in case the proxy is down
  console.log(`[Scraper] Trying direct RSS fetch as fallback: ${rssFeedUrl}`);
  try {
    const res = await fetchWithRetry(rssFeedUrl);

    const $ = cheerio.load(res.data, { xmlMode: true });
    const urls = [];
    $('item link').each((_, el) => {
      const link = $(el).text().trim();
      if (link) urls.push(link);
    });

    if (urls.length > 0) {
      console.log(`[Scraper] Found ${urls.length} post URLs from direct RSS feed.`);
    }
    return urls;
  } catch (e) {
    console.warn(`[Scraper Warning] Direct RSS feed fallback failed: ${e.message}`);
    return [];
  }
}

/**
 * Main function to get all post URLs using RSS Feed only.
 * @returns {Promise<Array<string>>}
 */
export async function getAllPostUrls() {
  // 1. Try primary calculator feed
  let urls = await getUrlsFromRSS(config.rssFeedUrl);
  if (urls.length > 0) return urls;

  // 2. Fallback to blog feed
  console.log('[Scraper] Calculator feed failed or returned no posts. Trying blog feed...');
  const blogFeedUrl = 'https://chemenggcalc.com/category/blog/feed/';
  urls = await getUrlsFromRSS(blogFeedUrl);
  if (urls.length > 0) return urls;

  throw new Error(`Could not fetch post URLs from RSS Feed (${config.rssFeedUrl}) or Blog Feed.`);
}

/**
 * Scrapes details (title, content, featured image) for a single article page.
 * @param {string} articleUrl 
 * @returns {Promise<object>}
 */
export async function scrapeArticleDetails(articleUrl) {
  console.log(`[Scraper] Scraping details for selected article: ${articleUrl}`);
  
  try {
    const res = await fetchWithRetry(articleUrl);
    
    const $ = cheerio.load(res.data);
    
    // Title
    const ogTitle = $('meta[property="og:title"]').attr('content') || $('meta[name="twitter:title"]').attr('content');
    const title = ogTitle ? ogTitle.trim() : ($('h1').first().text().trim() || articleUrl);
    
    // Description/Summary
    const ogDesc = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content');
    let content = ogDesc ? ogDesc.trim() : '';
    
    // Get full article text body (first 4000 chars) to give Gemini context
    const contentArea = $('div.entry-content, article, main, body');
    let fullText = '';
    contentArea.find('p').slice(0, 10).each((_, el) => {
      fullText += $(el).text().trim() + ' ';
    });
    fullText = fullText.slice(0, 4000).trim();
    
    if (!content) {
      content = fullText.slice(0, 1000);
    }
    
    // Featured Image
    let imageUrl = null;
    const ogImg = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
    
    if (ogImg && ogImg.includes('wp-content/uploads/')) {
      imageUrl = ogImg;
    }
    
    if (!imageUrl) {
      contentArea.find('img').each((_, el) => {
        const src = $(el).attr('src');
        if (src && src.includes('wp-content/uploads/') && !src.startsWith('data:')) {
          imageUrl = src;
          return false;
        }
      });
    }
    
    // Resolve relative image URLs
    if (imageUrl) {
      imageUrl = new URL(imageUrl, articleUrl).href;
    }
    
    return {
      title,
      link: articleUrl,
      content: fullText || content,
      imageUrl
    };
  } catch (error) {
    console.error(`[Scraper Error] Failed to scrape article details for ${articleUrl}:`, error.message);
    throw error;
  }
}
