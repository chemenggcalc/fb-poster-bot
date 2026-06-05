import axios from 'axios';
import { config } from './config.js';

/**
 * Publishes a post to the Facebook page.
 * If an imageUrl is provided, it posts to /{page-id}/photos.
 * Otherwise, it posts to /{page-id}/feed.
 * Includes a robust fallback to text/link post if photo upload fails.
 * 
 * @param {string} message - The post body text (caption)
 * @param {string|null} imageUrl - The article's featured image URL
 * @param {string} articleUrl - The link to the original article
 * @returns {Promise<string>} - The Facebook post ID
 */
export async function publishToFacebook(message, imageUrl, articleUrl) {
  if (!config.fbPageAccessToken || !config.fbPageId) {
    throw new Error('Facebook Page Access Token or Page ID is missing in .env configuration');
  }

  const fbVersion = 'v20.0';
  const baseUrl = `https://graph.facebook.com/${fbVersion}`;

  // Format final message to prepend the article URL for both photo captions and text feed updates
  let finalMessage = message;
  if (articleUrl && !message.includes(articleUrl)) {
    finalMessage = `Read here: ${articleUrl}\n\n${message}`;
  }

  // If there's an image, try to post as a photo
  if (imageUrl) {
    console.log(`[Facebook] Attempting to publish photo post with image: ${imageUrl}`);
    try {
      const response = await axios.post(`${baseUrl}/${config.fbPageId}/photos`, {
        url: imageUrl,
        caption: finalMessage,
        access_token: config.fbPageAccessToken
      }, {
        timeout: 15000
      });

      if (response.data && (response.data.id || response.data.post_id)) {
        const postId = response.data.post_id || response.data.id;
        console.log(`[Facebook] Successfully posted photo! Post ID: ${postId}`);
        return postId;
      }
      
      throw new Error(`Unexpected Graph API response: ${JSON.stringify(response.data)}`);
    } catch (error) {
      console.warn('[Facebook Warning] Photo upload failed. Falling back to link post. Error:', 
        error.response?.data?.error?.message || error.message
      );
      // Fall through to link post if photo posting fails
    }
  }

  // Text/Link Post fallback or default if no image is present
  console.log(`[Facebook] Publishing text/link post to page feed...`);
  try {
    const response = await axios.post(`${baseUrl}/${config.fbPageId}/feed`, {
      message: finalMessage,
      link: articleUrl || undefined, // Facebook will generate a card preview for the URL
      access_token: config.fbPageAccessToken
    }, {
      timeout: 15000
    });

    if (response.data && response.data.id) {
      console.log(`[Facebook] Successfully posted text/link update! Post ID: ${response.data.id}`);
      return response.data.id;
    }

    throw new Error(`Unexpected Graph API response: ${JSON.stringify(response.data)}`);
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    console.error('[Facebook Error] Failed to publish post:', errorMsg);
    throw new Error(`Facebook API Error: ${errorMsg}`);
  }
}
