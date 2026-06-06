import { getAllPostUrls, scrapeArticleDetails } from './scraper.js';

async function testScraper() {
  try {
    console.log('--- Testing Article URL Fetching ---');
    const urls = await getAllPostUrls();
    console.log(`\nFound ${urls.length} article URLs:`);
    urls.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));

    if (urls.length > 0) {
      const testUrl = urls[0];
      console.log(`\n--- Testing Article Detail Scraping ---`);
      console.log(`Scraping: ${testUrl}`);
      const article = await scrapeArticleDetails(testUrl);
      console.log(`\nArticle Details:`);
      console.log(`  Title:   ${article.title}`);
      console.log(`  Link:    ${article.link}`);
      console.log(`  Image:   ${article.imageUrl || 'None'}`);
      console.log(`  Content: ${article.content.substring(0, 200)}...`);
    }

    console.log('\n--- Scraper test completed successfully! ---');
  } catch (error) {
    console.error('Scraper test failed:', error.message);
  }
}

testScraper();
