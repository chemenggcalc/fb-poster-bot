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
 * Parses WordPress sitemaps and returns all post URLs.
 * @returns {Promise<Array<string>>}
 */
export async function getSitemapUrls() {
  const wpBaseUrl = config.websiteUrl ? config.websiteUrl.replace(/\/$/, '') : 'https://chemenggcalc.com';
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
            return false; // break loop
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
      console.warn(`[Scraper Warning] Failed parsing sitemap ${sitemapUrl}:`, e.message);
    }
  }

  if (postUrls.length === 0) {
    throw new Error('Could not find post URLs in any sitemap.');
  }
  return postUrls;
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
    
    // Check if it's a real WP image upload
    if (ogImg && ogImg.includes('wp-content/uploads/')) {
      imageUrl = ogImg;
    }
    
    if (!imageUrl) {
      contentArea.find('img').each((_, el) => {
        const src = $(el).attr('src');
        if (src && src.includes('wp-content/uploads/') && !src.startsWith('data:')) {
          imageUrl = src;
          return false; // break loop
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
