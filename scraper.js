import axios from 'axios';
import * as cheerio from 'cheerio';
import { config } from './config.js';

const SCRAPE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': config.websiteUrl || 'https://chemenggcalc.com/',
  'Connection': 'keep-alive',
};

/**
 * Method 1: Fetch all post URLs using WordPress REST API (most reliable from cloud servers).
 * WordPress REST API is rarely blocked by Cloudflare since it's designed for programmatic access.
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
      
      const res = await axios.get(apiUrl, {
        headers: SCRAPE_HEADERS,
        timeout: 15000
      });

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
    } catch (e) {
      if (page === 1) {
        console.warn(`[Scraper Warning] WordPress REST API failed: ${e.message}`);
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
      const res = await axios.get(sitemapUrl, {
        headers: SCRAPE_HEADERS,
        timeout: 15000
      });
      
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
          const subRes = await axios.get(postSitemapUrl, { headers: SCRAPE_HEADERS, timeout: 15000 });
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
    const res = await axios.get(rssFeedUrl, {
      headers: SCRAPE_HEADERS,
      timeout: 15000
    });

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
    console.warn(`[Scraper Warning] RSS feed failed: ${e.message}`);
    return [];
  }
}

/**
 * Main function to get all post URLs using multiple methods with fallbacks.
 * Priority: WordPress REST API -> Sitemap XML -> RSS Feed
 * @returns {Promise<Array<string>>}
 */
export async function getAllPostUrls() {
  // Method 1: WordPress REST API (most reliable from cloud)
  let urls = await getUrlsFromWpApi();
  if (urls.length > 0) return urls;

  // Method 2: Sitemap XML (works locally, may be blocked by Cloudflare on cloud)
  urls = await getUrlsFromSitemap();
  if (urls.length > 0) return urls;

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
    const res = await axios.get(articleUrl, {
      headers: SCRAPE_HEADERS,
      timeout: 15000
    });
    
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
