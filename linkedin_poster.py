import sys

# Force UTF-8 stdout on Windows to prevent terminal print crashes with emojis/formulas
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

import requests
import urllib.parse
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
WP_BASE_URL = "https://chemenggcalc.com/category/calculator/"
DB_FILE = "data/posted_articles_linkedin.json"

# Sitemap is the primary source of post URLs (covers ALL published posts,
# unlike RSS which is capped at ~10 most recent items)
SITEMAP_URL = "https://chemenggcalc.com/post-sitemap.xml"

EXCLUDE_PATTERNS = [
    "/category/", "/tag/", "/author/", "/page/",
    "/about-us", "/contact-us", "/privacy-policy",
    "/disclaimer", "/terms-and-conditions",
    "/wp-json", "/feed", "/sitemap",
]

# Ensure data directory exists
os.makedirs("data", exist_ok=True)

# Simple, honest bot User-Agent — proven to pass Cloudflare on this site
# (the elaborate fake-Chrome header set was actually triggering bot detection;
# this minimal self-identifying UA is what the working Pinterest automation uses)
SCRAPE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; ChemEnggCalcBot/1.0; +https://chemenggcalc.com)"
}

# Fetch credentials from environment
LINKEDIN_ACCESS_TOKEN = os.environ.get('LINKEDIN_ACCESS_TOKEN')
LINKEDIN_COMPANY_ID   = os.environ.get('LINKEDIN_ORG_ID')
GEMINI_API_KEY        = os.environ.get('GEMINI_API_KEY')

env_feed = os.environ.get('RSS_FEED_URL')
is_old_feed = env_feed and (env_feed.strip().rstrip('/') == 'https://chemenggcalc.com/feed')
RSS_FEED_URL = 'https://chemenggcalc.com/category/calculator/feed/' if (not env_feed or is_old_feed) else env_feed


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
# SITEMAP-BASED URL DISCOVERY (primary)
# ==========================================
def is_real_post(url, base_url="https://chemenggcalc.com"):
    """Filter out non-article URLs (category pages, author pages, legal pages, etc)."""
    if not url:
        return False
    path = url.replace(base_url, "").rstrip("/")
    if path in ("", "/"):
        return False
    return not any(p in url for p in EXCLUDE_PATTERNS)


def parse_locs(xml_bytes):
    """Extract all <loc> values from an XML sitemap document."""
    soup = BeautifulSoup(xml_bytes, "lxml-xml")
    return [loc.get_text(strip=True) for loc in soup.find_all("loc") if loc.get_text(strip=True)]


def get_urls_from_sitemap(sitemap_url=SITEMAP_URL):
    """
    Fetch all post URLs directly from post-sitemap.xml.
    If this URL ever turns out to be a sitemap index instead of a flat
    sitemap (i.e. its <loc> entries are themselves .xml files), recurse
    into each of those sub-sitemaps automatically.
    """
    try:
        print(f"Fetching sitemap: {sitemap_url}")
        res = fetch_with_retry(sitemap_url)
        locs = parse_locs(res.content)
        if not locs:
            print("  -> No <loc> entries found in sitemap.")
            return []

        xml_locs = [l for l in locs if l.lower().endswith(".xml")]
        if xml_locs:
            # It's actually a sitemap index — recurse into each sub-sitemap
            print(f"  -> {sitemap_url} is a sitemap index with {len(xml_locs)} sub-sitemap(s); recursing...")
            all_urls = []
            for sm in xml_locs:
                all_urls.extend(get_urls_from_sitemap(sm))
            urls = all_urls
        else:
            urls = [l for l in locs if is_real_post(l)]

        # De-duplicate while preserving order
        seen = set()
        deduped = []
        for u in urls:
            if u not in seen:
                seen.add(u)
                deduped.append(u)

        print(f"  -> {len(deduped)} post URLs found in {sitemap_url}.")
        return deduped
    except Exception as e:
        print(f"  -> Failed to fetch {sitemap_url}: {e}")
        return []


# ==========================================
# RSS-BASED URL DISCOVERY (fallback only)
# ==========================================
def get_urls_from_rss(feed_url):
    """Fetch post URLs from RSS feed via api.rss2json.com proxy to bypass Cloudflare."""
    proxy_url = f"https://api.rss2json.com/v1/api.json?rss_url={urllib.parse.quote(feed_url)}"
    print(f"Trying RSS feed via proxy: {proxy_url}")
    try:
        res = fetch_with_retry(proxy_url)
        data = res.json()
        if data.get('status') == 'ok' and isinstance(data.get('items'), list):
            urls = [item.get('link') for item in data.get('items') if item.get('link')]
            if urls:
                print(f"  -> Found {len(urls)} post URLs from RSS feed via proxy.")
                return urls
        print(f"  -> Proxy returned status: {data.get('status')}")
    except Exception as e:
        print(f"  -> RSS proxy failed: {e}")

    # Fallback to direct fetch in case the proxy is down
    print(f"Trying direct RSS fetch as fallback: {feed_url}")
    try:
        res = fetch_with_retry(feed_url)
        content_type = res.headers.get('Content-Type', '').lower()
        if 'html' in content_type:
            print("  -> Warning: Received HTML instead of RSS feed XML on direct fetch.")
            return []

        soup = BeautifulSoup(res.content, 'lxml-xml')
        items = soup.find_all('item')
        urls = []
        for item in items:
            link_tag = item.find('link')
            if link_tag and link_tag.text.strip():
                urls.append(link_tag.text.strip())

        if urls:
            print(f"  -> Found {len(urls)} post URLs from direct RSS feed.")
        return urls
    except Exception as e:
        print(f"  -> Direct RSS feed fallback failed: {e}")
        return []


def get_all_post_urls():
    """
    Get all post URLs. Sitemap is primary (covers ALL published posts/calculators).
    RSS feeds are only used as a fallback if the sitemap fetch fails entirely,
    since RSS is capped at ~10 most recent items.
    """
    # 1. Primary: sitemap
    urls = get_urls_from_sitemap()
    if urls:
        return urls

    # 2. Fallback: calculator RSS feed
    print("Sitemap fetch failed or returned no posts. Falling back to RSS feed...")
    urls = get_urls_from_rss(RSS_FEED_URL)
    if urls:
        return urls

    # 3. Fallback: blog RSS feed
    print("Calculator feed failed or returned no posts. Trying blog feed...")
    blog_feed_url = 'https://chemenggcalc.com/category/blog/feed/'
    urls = get_urls_from_rss(blog_feed_url)
    if urls:
        return urls

    raise Exception(f"Could not fetch post URLs from Sitemap ({SITEMAP_URL}), Calculator Feed, or Blog Feed.")


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

    # LinkedIn's commentary field hard-caps at 3000 characters. Anything over
    # gets rejected or silently mangled server-side, which is what was causing
    # "doesn't post full article sometimes". We leave headroom for the
    # "Read here: <url>\n\n" prefix added later in main().
    LINKEDIN_HARD_LIMIT = 2900  # leave ~100 chars headroom for the URL prefix
    if len(post_text) > LINKEDIN_HARD_LIMIT:
        print(f"Warning: Post is {len(post_text)} chars — truncating to {LINKEDIN_HARD_LIMIT} to fit LinkedIn's limit.")
        post_text = post_text[:LINKEDIN_HARD_LIMIT].rsplit('\n', 1)[0].rstrip() + "..."

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
    img_resp = requests.get(image_url, headers=SCRAPE_HEADERS, timeout=15)
    if img_resp.status_code != 200:
        raise Exception(f"Failed to download featured image ({img_resp.status_code}) from {image_url}")
    img_bytes = img_resp.content
    if not img_bytes or len(img_bytes) < 100:
        raise Exception(f"Downloaded image from {image_url} looks empty/invalid ({len(img_bytes)} bytes)")

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

        # 5. Upload image if available (fall back to text-only post if this fails,
        #    instead of letting it crash the whole run before we ever attempt the post)
        image_urn = None
        if featured_image:
            try:
                image_urn = upload_image_to_linkedin(LINKEDIN_ACCESS_TOKEN, LINKEDIN_COMPANY_ID, featured_image)
            except Exception as e:
                print(f"[Image Upload Failed] {e}")
                print("Continuing with a text-only post instead of aborting.")
                image_urn = None

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
