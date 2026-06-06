import axios from 'axios';
import * as cheerio from 'cheerio';
import { config } from './config.js';

const SCRAPE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
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
 * Pre-warm: Visit the homepage first to establish a "session" and pass initial Cloudflare checks.
 * Some Cloudflare setups allow subsequent requests after the first one passes.
 */
async function prewarmConnection() {
  const wpBaseUrl = (config.websiteUrl || 'https://chemenggcalc.com').replace(/\/$/, '');
  console.log('[Scraper] Pre-warming connection by visiting homepage...');
  try {
    await axios.get(wpBaseUrl, {
      headers: SCRAPE_HEADERS,
      timeout: 15000,
    });
    console.log('[Scraper] Homepage visited successfully.');
  } catch (e) {
    console.warn(`[Scraper] Homepage pre-warm returned ${e.response?.status || e.message} — continuing anyway.`);
  }
  // Small delay after pre-warm
  await sleep(2000);
}

/**
 * Method 1: Fetch all post URLs using WordPress REST API (most reliable from cloud servers).
 * WordPress REST API is designed for programmatic access.
 * @returns {Promise<Array<string>>}
 */
async function getUrlsFromWpApi() {
  const wpBaseUrl = (config.websiteUrl || 'https://chemenggcalc.com').replace(/\/$/, '');
  const allUrls = [];
  let page = 1;
  const perPage = 100;

  console.log('[Scraper] Trying WordPress REST API...');

  while (true) {
    try {
      const apiUrl = `${wpBaseUrl}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&_fields=link`;
      console.log(`[Scraper] Fetching REST API page ${page}: ${apiUrl}`);
      
      const res = await fetchWithRetry(apiUrl);

      if (!res.data || !Array.isArray(res.data) || res.data.length === 0) {
        break;
      }

      for (const post of res.data) {
        if (post.link) {
          allUrls.push(post.link);
        }
      }

      // Check if there are more pages
      const totalPages = parseInt(res.headers['x-wp-totalpages'] || '1', 10);
      if (page >= totalPages) {
        break;
      }
      page++;
      await sleep(1000); // Small delay between pagination requests
    } catch (e) {
      if (page === 1) {
        console.warn(`[Scraper Warning] WordPress REST API failed after retries: ${e.message}`);
        return []; // Return empty to trigger fallback
      }
      break; // We got some URLs, stop pagination
    }
  }

  if (allUrls.length > 0) {
    console.log(`[Scraper] Found ${allUrls.length} post URLs from WordPress REST API.`);
  }
  return allUrls;
}

/**
 * Method 2: Parse WordPress sitemaps (works well from local PC, may be blocked by Cloudflare on cloud).
 * @returns {Promise<Array<string>>}
 */
async function getUrlsFromSitemap() {
  const wpBaseUrl = (config.websiteUrl || 'https://chemenggcalc.com').replace(/\/$/, '');
  const sitemapCandidates = [
    `${wpBaseUrl}/post-sitemap.xml`,
    `${wpBaseUrl}/sitemap_index.xml`,
    `${wpBaseUrl}/sitemap.xml`,
  ];
  
  let postUrls = [];

  for (const sitemapUrl of sitemapCandidates) {
    console.log(`[Scraper] Trying sitemap: ${sitemapUrl}`);
    try {
      const res = await fetchWithRetry(sitemapUrl);
      
      const $ = cheerio.load(res.data, { xmlMode: true });

      // If this is a sitemap index, find the post-sitemap child
      const sitemapTags = $('sitemap');
      if (sitemapTags.length > 0) {
        console.log('[Scraper] Sitemap index found, locating post sitemap...');
        let postSitemapUrl = null;
        sitemapTags.each((_, el) => {
          const loc = $(el).find('loc').text().trim();
          if (loc && loc.toLowerCase().includes('post')) {
            postSitemapUrl = loc;
            return false;
          }
        });
        
        if (postSitemapUrl) {
          console.log(`[Scraper] Fetching post sitemap: ${postSitemapUrl}`);
          await sleep(2000); // Delay before fetching child sitemap
          const subRes = await fetchWithRetry(postSitemapUrl);
          const sub$ = cheerio.load(subRes.data, { xmlMode: true });
          sub$('loc').each((_, el) => {
            const locText = sub$(el).text().trim();
            if (locText) postUrls.push(locText);
          });
        }
      }

      // Direct URL sitemap
      if (postUrls.length === 0) {
        $('url').each((_, el) => {
          const loc = $(el).find('loc').text().trim();
          if (loc) {
            postUrls.push(loc);
          }
        });
      }

      if (postUrls.length > 0) {
        console.log(`[Scraper] Found ${postUrls.length} post URLs from sitemap.`);
        break;
      }
    } catch (e) {
      console.warn(`[Scraper Warning] Failed parsing sitemap ${sitemapUrl}: ${e.message}`);
    }
    // Delay before trying the next sitemap candidate
    await sleep(3000);
  }

  return postUrls;
}

/**
 * Method 3: Fetch post URLs from RSS feed (fallback).
 * @returns {Promise<Array<string>>}
 */
async function getUrlsFromRSS() {
  const rssFeedUrl = config.rssFeedUrl || `${(config.websiteUrl || 'https://chemenggcalc.com').replace(/\/$/, '')}/feed`;
  
  console.log(`[Scraper] Trying RSS feed: ${rssFeedUrl}`);
  try {
    const res = await fetchWithRetry(rssFeedUrl);

    const $ = cheerio.load(res.data, { xmlMode: true });
    const urls = [];
    $('item link').each((_, el) => {
      const link = $(el).text().trim();
      if (link) urls.push(link);
    });

    if (urls.length > 0) {
      console.log(`[Scraper] Found ${urls.length} post URLs from RSS feed.`);
    }
    return urls;
  } catch (e) {
    console.warn(`[Scraper Warning] RSS feed failed after retries: ${e.message}`);
    return [];
  }
}

/**
 * Main function to get all post URLs using multiple methods with fallbacks.
 * Pre-warms the connection first, then tries: WordPress REST API -> Sitemap XML -> RSS Feed
 * Each method has built-in retry logic with delays to handle Cloudflare rate limiting.
 * @returns {Promise<Array<string>>}
 */
export async function getAllPostUrls() {
  // Pre-warm: visit homepage to pass initial Cloudflare challenge
  await prewarmConnection();

  // Method 1: WordPress REST API (most reliable from cloud)
  let urls = await getUrlsFromWpApi();
  if (urls.length > 0) return urls;

  console.log('[Scraper] REST API failed. Waiting 5s before trying sitemaps...');
  await sleep(5000);

  // Method 2: Sitemap XML
  urls = await getUrlsFromSitemap();
  if (urls.length > 0) return urls;

  console.log('[Scraper] Sitemaps failed. Waiting 5s before trying RSS feed...');
  await sleep(5000);

  // Method 3: RSS Feed (limited to recent posts but always works)
  urls = await getUrlsFromRSS();
  if (urls.length > 0) return urls;

  throw new Error('Could not fetch post URLs from any source (REST API, Sitemap, or RSS Feed).');
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
