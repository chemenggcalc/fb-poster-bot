import { getArticles } from './scraper.js';

async function test() {
  console.log('Testing Scraper and Feed Parser with loaded .env config...');
  
  try {
    const articles = await getArticles();
    console.log(`\nSuccessfully fetched ${articles.length} articles!`);
    
    // Print top 3 articles
    const topArticles = articles.slice(0, 3);
    topArticles.forEach((article, i) => {
      console.log(`\n[Article #${i + 1}]`);
      console.log(`Title: ${article.title}`);
      console.log(`Link:  ${article.link}`);
      console.log(`Image: ${article.imageUrl || 'None'}`);
      console.log(`Content Snippet (first 100 chars): "${article.content?.slice(0, 100).trim()}..."`);
    });
    
    console.log('\nScraper test completed successfully!');
  } catch (error) {
    console.error('Scraper test failed with error:', error);
  }
}

test();
