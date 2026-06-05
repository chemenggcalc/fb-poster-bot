# Automated Facebook Poster Bot

This is a Node.js automation bot that fetches articles from your website, selects an article **at random** from the unposted ones, uses Gemini AI to write an engaging Facebook post, and publishes it directly to your Facebook Page with its featured image.

It includes:
- **Duplicate Prevention:** Tracks posted articles in a local JSON database.
- **Auto-reset Option:** Optionally clears history and starts over randomly once all articles have been shared.
- **Fail-safe Posting:** Tries to post the featured image, falling back to a standard text/link preview post if the image is not reachable by Meta.
- **Scheduler:** Built-in cron scheduler that triggers posting at a configurable time every day.
- **Dry-run Mode:** Allows you to test the scraper and Gemini AI post generator without actually posting to Facebook.

---

## 🛠️ Prerequisites & Setup

### 1. Install Dependencies
Make sure you have Node.js (v18+) installed. Run the following command in the project directory:
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` in the root folder:
```bash
copy .env.example .env
```
Fill in the variables in `.env`:
*   `GEMINI_API_KEY`: Get your free API key from [Google AI Studio](https://aistudio.google.com/).
*   `FB_PAGE_ID`: The ID of your Facebook Page.
*   `FB_PAGE_ACCESS_TOKEN`: The Page Access Token with post permissions (see guide below).
*   `RSS_FEED_URL`: Your website's RSS Feed (e.g. `https://example.com/feed` or `https://example.com/rss`).
*   `WEBSITE_URL`: Your main website homepage (used as a fallback scraper if no RSS feed is found).
*   `CRON_SCHEDULE`: When to post (e.g. `0 9 * * *` is daily at 9:00 AM. See [crontab.guru](https://crontab.guru/) for help).
*   `RESET_POSTING_HISTORY_WHEN_EXHAUSTED`: Set to `true` to reuse articles randomly once all of them have been shared.

---

## 🔑 Facebook Access Token Quick Guide

To get a long-lived Facebook Page Access Token:
1.  Go to the [Meta for Developers Portal](https://developers.facebook.com/) and create a new App.
2.  Add the **Facebook Login** product to your app.
3.  Go to the **Graph API Explorer** tool: `https://developers.facebook.com/tools/explorer/`
4.  In the Explorer:
    *   Select your App.
    *   Under **User or Page**, select **Get Page Access Token** and approve your page.
    *   Add permissions: `pages_manage_posts`, `pages_read_engagement`, `publish_to_groups`.
    *   Click **Generate Access Token**.
5.  *Important:* This token will expire in 2 hours. To generate a permanent Page Access Token:
    *   Go to the [Access Token Tool](https://developers.facebook.com/tools/accesstoken/) or use the Graph API Explorer to exchange it for a Long-Lived Token (lasts 60 days).
    *   Alternatively, set up a System User under Facebook Business Manager and generate a System User Token that **never expires**.

---

## 🚀 Running the Bot

### 1. Test Fetching and AI Generation (Dry Run)
We highly recommend running a dry run first. This scrapes your website, picks a random article, asks Gemini to write the post, and prints the result to the console **without posting to Facebook**.
```bash
node scheduler.js --dry-run
```

### 2. Post Immediately (Live Test)
To test the full system end-to-end, fetching an article, generating a post, and posting it directly to Facebook right now:
```bash
node scheduler.js --run-now
```

### 3. Reset Posting History
If you want to clear your local database of posted articles so that any article can be randomly selected again:
```bash
node scheduler.js --reset-db
```

### 4. Start the Scheduler
To start the bot in scheduler mode. It will stay running in the background and trigger the posting job daily according to your configured `CRON_SCHEDULE`.
```bash
npm start
```

---

## 🖥️ Keeping it running 24/7

To run this process continuously in the background on your system or server, you can use **PM2** (Process Manager for Node.js):

1. Install PM2 globally:
   ```bash
   npm install pm2 -g
   ```
2. Start the bot scheduler:
   ```bash
   pm2 start scheduler.js --name "fb-automated-poster"
   ```
3. Ensure it starts automatically on system reboot:
   ```bash
   pm2 startup
   pm2 save
   ```
