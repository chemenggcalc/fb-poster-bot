import sys

# Force UTF-8 stdout on Windows to prevent terminal print crashes with emojis/formulas
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

import requests
from bs4 import BeautifulSoup
import google.generativeai as genai
import random
import time
import json
import os

# ==========================================
# ENVIRONMENT LOADER
# ==========================================
def load_env():
    """Manually load environmental variables from .env file if it exists."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(env_path):
        print("Loading environment variables from .env file...")
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' in line:
                    parts = line.split('=', 1)
                    key = parts[0].strip()
                    val = parts[1].strip().strip("'\"")
                    if key not in os.environ:
                        os.environ[key] = val

# Load environmental variables
load_env()

# ==========================================
# CONFIGURATION
# ==========================================
WP_BASE_URL = "https://chemenggcalc.com"
DB_FILE = "data/posted_articles_linkedin.json"

# Ensure data directory exists
os.makedirs("data", exist_ok=True)

# Browser-like headers to bypass Cloudflare
SCRAPE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
    'Referer': 'https://chemenggcalc.com/',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
}

# Fetch credentials from environment
LINKEDIN_ACCESS_TOKEN = os.environ.get('LINKEDIN_ACCESS_TOKEN')
LINKEDIN_COMPANY_ID   = os.environ.get('LINKEDIN_ORG_ID')
GEMINI_API_KEY        = os.environ.get('GEMINI_API_KEY')


# ==========================================
# HELPERS
# ==========================================
def detect_cloudflare(html_content):
    """Detect if the content is a Cloudflare challenge page."""
    html_lower = html_content.lower()
    # Check for common challenge hallmarks
    if "challenge-platform" in html_lower or "cf-challenge" in html_lower or "cf_challenge" in html_lower:
        return True
    if "cloudflare" in html_lower and ("please enable cookies" in html_lower or "turn on javascript" in html_lower or "enable javascript" in html_lower):
        return True
    return False


def fetch_with_retry(url, max_retries=3):
    """Fetch a URL with retry logic and delays between attempts."""
    delays = [3, 6, 10]  # seconds between retries
    for attempt in range(1, max_retries + 1):
        try:
            res = requests.get(url, headers=SCRAPE_HEADERS, timeout=20)
            if res.status_code == 200:
                if detect_cloudflare(res.text):
                    raise Exception("Cloudflare challenge/blocking page detected (status 200)")
                return res
            print(f"  -> Attempt {attempt}/{max_retries} got status {res.status_code}")
        except Exception as e:
            print(f"  -> Attempt {attempt}/{max_retries} failed: {e}")

        if attempt < max_retries:
            wait = delays[attempt - 1] if attempt - 1 < len(delays) else 5
            print(f"  -> Waiting {wait}s before retry...")
            time.sleep(wait)

    # Final attempt — raise on failure
    res = requests.get(url, headers=SCRAPE_HEADERS, timeout=20)
    if res.status_code == 200 and detect_cloudflare(res.text):
        raise Exception("Cloudflare challenge/blocking page detected on final attempt")
    res.raise_for_status()
    return res


def prewarm_connection():
    """Visit the homepage first to pass initial Cloudflare checks."""
    print("Pre-warming connection by visiting homepage...")
    try:
        requests.get(WP_BASE_URL, headers=SCRAPE_HEADERS, timeout=15)
        print("Homepage visited successfully.")
    except Exception as e:
        print(f"Homepage pre-warm returned {e} — continuing anyway.")
    time.sleep(2)


# ==========================================
# GEMINI SETUP
# ==========================================
def get_gemini_model():
    print("Checking available Gemini models...")
    genai.configure(api_key=GEMINI_API_KEY)
    available = [m.name for m in genai.list_models() if 'generateContent' in m.supported_generation_methods]
    if not available:
        raise Exception("No suitable Gemini models found for your API key.")
    preferred = ['models/gemini-2.5-flash', 'models/gemini-1.5-flash', 'models/gemini-1.5-pro']
    chosen = next((m for m in preferred if m in available), available[0])
    print(f"Selected Gemini model: {chosen}")
    return genai.GenerativeModel(chosen.replace('models/', ''))


# ==========================================
# STEP 1 — GET ALL POST URLs FROM SOURCES
# ==========================================
def get_urls_from_wp_api():
    """Fetch post URLs using WordPress REST API."""
    print("Trying WordPress REST API...")
    all_urls = []
    page = 1
    per_page = 100
    while True:
        api_url = f"{WP_BASE_URL}/wp-json/wp/v2/posts?per_page={per_page}&page={page}&_fields=link"
        print(f"  -> Fetching REST API page {page}: {api_url}")
        try:
            res = fetch_with_retry(api_url)
            # Check if it's JSON
            if 'application/json' not in res.headers.get('Content-Type', '').lower():
                print(f"  -> Expected JSON but got Content-Type: {res.headers.get('Content-Type')}")
                return []
            
            data = res.json()
            if not isinstance(data, list) or len(data) == 0:
                break
            
            for post in data:
                if isinstance(post, dict) and 'link' in post:
                    all_urls.append(post['link'])
            
            # Check headers for pagination
            total_pages = int(res.headers.get('X-WP-TotalPages', 1))
            if page >= total_pages:
                break
            page += 1
            time.sleep(1)
        except Exception as e:
            print(f"  -> REST API failed on page {page}: {e}")
            if page == 1:
                return []
            break
            
    if all_urls:
        print(f"  -> Found {len(all_urls)} post URLs from WordPress REST API.")
    return all_urls


def get_urls_from_sitemaps():
    """Parse WordPress sitemaps and return all post URLs with retry logic."""
    print("Trying XML sitemaps...")
    sitemap_candidates = [
        f"{WP_BASE_URL}/post-sitemap.xml",
        f"{WP_BASE_URL}/sitemap_index.xml",
        f"{WP_BASE_URL}/sitemap.xml",
    ]
    post_urls = []

    for sitemap_url in sitemap_candidates:
        print(f"Trying sitemap: {sitemap_url}")
        try:
            res = fetch_with_retry(sitemap_url)
            content_type = res.headers.get('Content-Type', '').lower()
            if 'html' in content_type:
                print("  -> Warning: Received HTML instead of XML sitemap.")
                continue

            soup = BeautifulSoup(res.content, 'lxml-xml')

            # If this is a sitemap index, find the post-sitemap child
            sitemap_tags = soup.find_all('sitemap')
            if sitemap_tags:
                print("  -> Sitemap index found, locating post sitemap...")
                for s in sitemap_tags:
                    loc = s.find('loc')
                    if loc and 'post' in loc.text.lower():
                        print(f"  -> Post sitemap: {loc.text}")
                        time.sleep(2)  # Delay before fetching child sitemap
                        sub_res = fetch_with_retry(loc.text)
                        sub_content_type = sub_res.headers.get('Content-Type', '').lower()
                        if 'html' in sub_content_type:
                            print("  -> Warning: Received HTML instead of child XML sitemap.")
                            continue
                        sub_soup = BeautifulSoup(sub_res.content, 'lxml-xml')
                        post_urls = [u.text.strip() for u in sub_soup.find_all('loc')]
                        break

            # Direct URL sitemap
            if not post_urls:
                url_tags = soup.find_all('url')
                post_urls = [u.find('loc').text.strip() for u in url_tags if u.find('loc')]

            if post_urls:
                print(f"  -> Found {len(post_urls)} post URLs.")
                break
        except Exception as e:
            print(f"  -> Error fetching sitemap {sitemap_url}: {e}")
        # Delay before trying the next sitemap
        time.sleep(3)

    return post_urls


def get_urls_from_rss():
    """Fetch post URLs from RSS feed."""
    rss_feed_url = f"{WP_BASE_URL}/feed"
    print(f"Trying RSS feed: {rss_feed_url}")
    try:
        res = fetch_with_retry(rss_feed_url)
        content_type = res.headers.get('Content-Type', '').lower()
        if 'html' in content_type:
            print("  -> Warning: Received HTML instead of RSS feed XML.")
            return []
        
        soup = BeautifulSoup(res.content, 'lxml-xml')
        items = soup.find_all('item')
        urls = []
        for item in items:
            link_tag = item.find('link')
            if link_tag and link_tag.text.strip():
                urls.append(link_tag.text.strip())
        
        if urls:
            print(f"  -> Found {len(urls)} post URLs from RSS feed.")
        return urls
    except Exception as e:
        print(f"  -> RSS feed failed: {e}")
        return []


def get_all_post_urls():
    """Get all post URLs with multiple fallbacks: WP REST API -> Sitemap XML -> RSS Feed."""
    # Pre-warm connection first
    prewarm_connection()

    # Method 1: WordPress REST API (most reliable on Cloudflare)
    urls = get_urls_from_wp_api()
    if urls:
        return urls

    print("REST API failed. Waiting 5s before trying sitemaps...")
    time.sleep(5)

    # Method 2: Sitemap XML
    urls = get_urls_from_sitemaps()
    if urls:
        return urls

    print("Sitemaps failed. Waiting 5s before trying RSS feed...")
    time.sleep(5)

    # Method 3: RSS Feed
    urls = get_urls_from_rss()
    if urls:
        return urls

    raise Exception("Could not fetch post URLs from any source (WP REST API, Sitemap, or RSS Feed).")


def fetch_random_article():
    """Pick a random post from the sitemap (avoiding duplicates) and scrape details."""
    all_urls = get_all_post_urls()

    # Load posted history for duplicate protection
    posted_urls = []
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, "r") as f:
                posted_urls = json.load(f)
        except Exception:
            posted_urls = []

    # Filter out already posted links
    unposted_urls = [u for u in all_urls if u not in posted_urls]
    print(f"[Duplicate Protection] {len(unposted_urls)} of {len(all_urls)} articles are unposted on LinkedIn.")

    if not unposted_urls:
        print("[Duplicate Protection] All articles have been posted on LinkedIn! Resetting history...")
        posted_urls = []
        unposted_urls = all_urls
        if os.path.exists(DB_FILE):
            try:
                os.remove(DB_FILE)
            except Exception:
                pass

    for attempt in range(5):
        article_url = random.choice(unposted_urls)
        print(f"\nSelected URL (attempt {attempt+1}): {article_url}")

        try:
            res = fetch_with_retry(article_url)
            if detect_cloudflare(res.text):
                print("  -> Cloudflare challenge/blocking page detected on article, skipping...")
                continue

            soup = BeautifulSoup(res.content, 'lxml')

            # Title
            og_title = soup.find('meta', property='og:title')
            title = (og_title['content'] if og_title and og_title.get('content')
                     else (soup.find('h1').get_text(strip=True) if soup.find('h1') else article_url))

            # Description
            og_desc   = soup.find('meta', property='og:description')
            meta_desc = soup.find('meta', attrs={'name': 'description'})
            topic = (og_desc['content'] if og_desc and og_desc.get('content')
                     else (meta_desc['content'] if meta_desc and meta_desc.get('content')
                           else (soup.find('p').get_text(strip=True)[:500] if soup.find('p') else '')))

            # Full article text for formula extraction (first 4000 chars)
            content_area = (soup.find('div', class_='entry-content')
                            or soup.find('article') or soup.find('main') or soup)
            full_text = content_area.get_text(separator=' ', strip=True)[:4000]

            # Featured image — must be a real WordPress upload
            featured_image = None
            og_img = soup.find('meta', property='og:image')
            if og_img and og_img.get('content') and 'wp-content/uploads/' in og_img['content']:
                featured_image = og_img['content']

            if not featured_image:
                for img in content_area.find_all('img'):
                    src = img.get('src', '')
                    if 'wp-content/uploads/' in src and not src.startswith('data:'):
                        featured_image = src
                        break

            print(f"Title         : {title}")
            print(f"Featured Image: {featured_image}")
            return title, topic, full_text, article_url, featured_image, posted_urls
        except Exception as e:
            print(f"  -> Scrape error: {e}, retrying...")

    raise Exception("Failed to fetch a valid article after 5 attempts.")


# ==========================================
# STEP 2 — GENERATE POST WITH GEMINI
# ==========================================
def generate_linkedin_post(title, topic, full_text, article_url, model):
    print("Generating LinkedIn post using Gemini AI...")
    prompt = f"""
You are a social media manager for 'ChemEnggCalc', a chemical engineering tools & resources company.

Write a LinkedIn post based on the article below.

Article Title: {title}
Article Summary: {topic}
Article Full Content (use for formulas): {full_text}

===== POST STRUCTURE =====

1. OPENING HOOK (1 line): A relatable problem for chemical engineers. Use 1-2 emojis.

2. PROBLEM (2-3 short lines): The engineering pain point.

3. SOLUTION (2-3 short lines): What the article/calculator solves.

4. THE FORMULA (2 lines): Find any formula from the article content. Write it in plain text (e.g. "Q = m x Cp x delta-T"). Briefly explain symbols. If no formula, mention the key method. Start with "The Formula:"

5. KEY TAKEAWAYS (3 bullet points using "-"): Under 12 words each.

6. HASHTAGS (1 line, 5-6 tags): e.g. #ChemicalEngineering #ChemEnggCalc #ProcessEngineering

===== RULES =====
- 150-200 words MAX. Keep it concise.
- NO markdown: no **bold**, no *italic*, no ```code```.
- Plain text only. Use emojis for emphasis.
- Put a blank line between every section.
- Do NOT include any call-to-action or article URL (it will be added automatically).
- Do NOT add any placeholder text.
- COMPLETE the entire post — do not cut off mid-sentence.
"""
    response = model.generate_content(prompt)
    post_text = response.text.strip()

    # Clean up any markdown formatting that Gemini might add
    post_text = post_text.replace('**', '')

    if len(post_text) > 2800:
        print(f"Warning: Post is {len(post_text)} chars — may be truncated by LinkedIn.")
    return post_text


# ==========================================
# STEP 3 — UPLOAD IMAGE TO LINKEDIN
# ==========================================
def upload_image_to_linkedin(access_token, company_id, image_url):
    print("Uploading featured image to LinkedIn...")
    author_urn = company_id if company_id.startswith("urn:li:") else f"urn:li:organization:{company_id}"

    headers = {
        'Authorization': f'Bearer {access_token}',
        'Content-Type': 'application/json',
        'LinkedIn-Version': '202604',
        'X-Restli-Protocol-Version': '2.0.0'
    }

    # 1. Initialize upload
    init_res = requests.post(
        "https://api.linkedin.com/rest/images?action=initializeUpload",
        headers=headers,
        json={"initializeUploadRequest": {"owner": author_urn}},
        timeout=15
    )
    init_data = init_res.json()

    if 'value' not in init_data:
        raise Exception(f"Failed to initialize image upload: {init_res.text}")

    upload_url = init_data['value']['uploadUrl']
    image_urn  = init_data['value']['image']

    # 2. Download image from WordPress and push to LinkedIn
    img_bytes = requests.get(image_url, headers={
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://chemenggcalc.com/'
    }, timeout=15).content

    put_res = requests.put(upload_url, headers={'Authorization': f'Bearer {access_token}'}, data=img_bytes, timeout=30)

    if put_res.status_code not in (200, 201):
        raise Exception(f"Image binary upload failed: {put_res.status_code} {put_res.text}")

    print(f"Image uploaded. URN: {image_urn}")
    print("Waiting 15 seconds for LinkedIn to process the image...")
    time.sleep(15)
    return image_urn


# ==========================================
# STEP 4 — CREATE LINKEDIN POST
# ==========================================
def create_linkedin_post(access_token, company_id, post_text, image_urn=None):
    print("Publishing post to LinkedIn...")
    author_urn = company_id if company_id.startswith("urn:li:") else f"urn:li:organization:{company_id}"

    headers = {
        'Authorization': f'Bearer {access_token}',
        'Content-Type': 'application/json',
        'LinkedIn-Version': '202604',
        'X-Restli-Protocol-Version': '2.0.0'
    }

    payload = {
        "author": author_urn,
        "commentary": post_text,
        "visibility": "PUBLIC",
        "distribution": {
            "feedDistribution": "MAIN_FEED",
            "targetEntities": [],
            "thirdPartyDistributionChannels": []
        },
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False
    }

    if image_urn:
        payload["content"] = {
            "media": {
                "id": image_urn
            }
        }

    res = requests.post("https://api.linkedin.com/rest/posts", headers=headers, json=payload, timeout=20)

    if res.status_code == 201:
        restli_id = res.headers.get("x-restli-id", "UNKNOWN")
        print("Successfully posted to LinkedIn!")
        print(f"Direct Link: https://www.linkedin.com/feed/update/{restli_id}")
        return True
    else:
        print("Failed to post on LinkedIn.")
        print("Status Code:", res.status_code)
        print("Response:", res.text)
        return False


# ==========================================
# MAIN
# ==========================================
def main():
    try:
        is_dry_run = '--dry-run' in sys.argv

        if is_dry_run:
            if not GEMINI_API_KEY:
                raise Exception("Missing GEMINI_API_KEY in environment for dry run.")
        else:
            if not GEMINI_API_KEY or not LINKEDIN_ACCESS_TOKEN or not LINKEDIN_COMPANY_ID:
                raise Exception("Missing credentials! Verify GEMINI_API_KEY, LINKEDIN_ACCESS_TOKEN, and LINKEDIN_ORG_ID in environment.")

        # 1. Init Gemini
        model = get_gemini_model()

        # 2. Fetch random article from sitemap
        title, topic, full_text, article_url, featured_image, posted_urls = fetch_random_article()

        # 3. Generate LinkedIn post text (with formula)
        post_text = generate_linkedin_post(title, topic, full_text, article_url, model)

        # 4. Prepend article URL to the first line (like Facebook posts)
        if article_url and article_url not in post_text:
            post_text = f"Read here: {article_url}\n\n{post_text}"

        print("\n========== GENERATED POST ==========")
        print(post_text)
        print("====================================\n")

        if featured_image:
            print(f"Featured Image: {featured_image}")
        else:
            print("No featured image found — will post text only.")

        # Check for dry run
        if is_dry_run:
            print("\n===== DRY RUN - POST DETAILS =====")
            print(f"Target Org ID: {LINKEDIN_COMPANY_ID or 'Not Configured (Dry Run)'}")
            print(f"Image URL:     {featured_image or 'None (Will post text only)'}")
            print(f"Article Link:  {article_url}")
            print("--- Generated LinkedIn Caption ---")
            print(post_text)
            print("==================================\n")
            print("Dry run completed successfully. Post was generated but not published.")
            return

        # 4. Bypasses prompt if running in automated environment
        is_automated = 'GITHUB_ACTIONS' in os.environ
        if not is_automated:
            user_input = input("\nDo you want to publish this post to LinkedIn? (yes/no): ").strip().lower()
            if user_input not in ['yes', 'y']:
                print("Publishing aborted by user.")
                return

        # 5. Upload image if available
        image_urn = None
        if featured_image:
            image_urn = upload_image_to_linkedin(LINKEDIN_ACCESS_TOKEN, LINKEDIN_COMPANY_ID, featured_image)

        # 6. Publish post
        success = create_linkedin_post(LINKEDIN_ACCESS_TOKEN, LINKEDIN_COMPANY_ID, post_text, image_urn)

        # 7. Record to database if successfully posted
        if success:
            posted_urls.append(article_url)
            with open(DB_FILE, "w") as f:
                json.dump(posted_urls, f, indent=2)
            print("[Database] Saved post URL to LinkedIn database.")

    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    main()
