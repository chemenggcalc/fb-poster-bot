import cron from 'node-cron';
import { config, validateConfig } from './config.js';
import { getAllPostUrls, scrapeArticleDetails } from './scraper.js';
import { generateFacebookPost } from './geminiService.js';
import { publishToFacebook } from './facebookService.js';
import { getPostedArticles, markAsPosted, clearPostedArticles, addLog } from './db.js';

/**
 * Runs the automated article post pipeline.
 * @param {boolean} dryRun - If true, logs generated content to console instead of posting to Facebook.
 */
async function runJob(dryRun = false) {
  const modeText = dryRun ? 'DRY RUN' : 'LIVE';
  console.log(`\n==================================================`);
  console.log(`[Job] Starting posting job... Mode: ${modeText}`);
  console.log(`[Job] Time: ${new Date().toISOString()}`);
  console.log(`==================================================`);
  
  try {
    if (!validateConfig()) {
      throw new Error('Invalid configuration. Check your environment variables in .env');
    }

    // 1. Fetch website article URLs (tries WP REST API -> Sitemap -> RSS Feed)
    const articleUrls = await getAllPostUrls();
    if (!articleUrls || articleUrls.length === 0) {
      console.log('[Job] No articles found on the website.');
      addLog({ status: 'warning', message: 'No article URLs retrieved from sitemaps.' });
      return;
    }

    console.log(`[Job] Retrieved ${articleUrls.length} total URLs from sitemap.`);

    // 2. Filter out already posted articles
    const postedUrls = getPostedArticles();
    let unpostedUrls = articleUrls.filter(url => !postedUrls.includes(url));

    console.log(`[Job] Found ${unpostedUrls.length} unposted articles.`);

    // 3. Handle case where all articles are already posted
    if (unpostedUrls.length === 0) {
      if (config.resetHistoryWhenExhausted) {
        console.log('[Job] All articles have been posted! Resetting posting history to loop again...');
        clearPostedArticles();
        unpostedUrls = articleUrls;
      } else {
        console.log('[Job] All articles have already been posted. Setup RESET_POSTING_HISTORY_WHEN_EXHAUSTED=true in .env to loop.');
        addLog({ status: 'warning', message: 'All articles have been posted. No new articles to publish.' });
        return;
      }
    }

    // 4. Select a random URL
    const randomIndex = Math.floor(Math.random() * unpostedUrls.length);
    const selectedUrl = unpostedUrls[randomIndex];

    console.log(`[Job] Selected Random URL: ${selectedUrl}`);

    // 5. Scrape details for only this selected URL
    const selectedArticle = await scrapeArticleDetails(selectedUrl);
    
    console.log(`[Job] Article Details Scraped:`);
    console.log(`  - Title: "${selectedArticle.title}"`);
    console.log(`  - Image: ${selectedArticle.imageUrl || 'None detected'}`);

    // 6. Generate Facebook post content via Gemini API
    const generatedText = await generateFacebookPost(selectedArticle.title, selectedArticle.content);

    // 7. Handle Dry Run vs Live execution
    if (dryRun) {
      console.log('\n===== DRY RUN - POST DETAILS =====');
      console.log(`Target Page ID: ${config.fbPageId}`);
      console.log(`Image URL:      ${selectedArticle.imageUrl || 'None (Will post text/link preview)'}`);
      console.log(`Article Link:   ${selectedArticle.link}`);
      console.log('--- Generated FB Post Caption ---');
      console.log(generatedText);
      console.log('==================================\n');
      
      addLog({
        status: 'dry-run',
        articleTitle: selectedArticle.title,
        articleUrl: selectedArticle.link,
        message: 'Dry run completed successfully. Post was generated but not published.'
      });
      return;
    }

    // 8. Publish to Facebook Page Graph API
    console.log('[Job] Sending post to Facebook...');
    const postId = await publishToFacebook(generatedText, selectedArticle.imageUrl, selectedArticle.link);

    // 9. Record success in local database
    markAsPosted(selectedArticle.link);
    addLog({
      status: 'success',
      articleTitle: selectedArticle.title,
      articleUrl: selectedArticle.link,
      postId: postId,
      message: 'Post successfully published to Facebook Page.'
    });

    console.log(`[Job] Job execution completed successfully. Post published with ID: ${postId}`);
  } catch (error) {
    console.error('[Job Error] Job execution failed:', error.message);
    addLog({
      status: 'error',
      message: error.message
    });
  }
  console.log(`==================================================\n`);
}

// Command-line arguments processing
const args = process.argv.slice(2);
const runNowFlag = args.includes('--run-now');
const dryRunFlag = args.includes('--dry-run');
const resetDbFlag = args.includes('--reset-db');

if (resetDbFlag) {
  clearPostedArticles();
  console.log('[CLI] Database posting history has been reset.');
  process.exit(0);
}

if (runNowFlag || dryRunFlag) {
  // Execute immediately
  runJob(dryRunFlag).then(() => {
    process.exit(0);
  });
} else {
  // Start daily scheduler (Cron mode)
  console.log(`[Scheduler] Automated Facebook Poster Bot is starting up...`);
  console.log(`[Scheduler] Active cron schedule: "${config.cronSchedule}"`);
  validateConfig(); // Run validation to log warnings early

  cron.schedule(config.cronSchedule, () => {
    runJob(false);
  }, {
    timezone: 'Asia/Kolkata'
  });
  
  console.log(`[Scheduler] Cron runner started. Monitoring for scheduled trigger times.`);
}
