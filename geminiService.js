import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

let aiInstance = null;

function getAIInstance() {
  if (!aiInstance) {
    if (!config.geminiApiKey) {
      throw new Error('Gemini API key is not configured in .env (GEMINI_API_KEY)');
    }
    aiInstance = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return aiInstance;
}

/**
 * Generates an engaging Facebook post using Gemini AI.
 * @param {string} title - The article title
 * @param {string} content - The article body or summary
 * @returns {Promise<string>} - The generated post text
 */
export async function generateFacebookPost(title, content) {
  console.log(`[Gemini] Generating Facebook post for article: "${title}" using model: ${config.geminiModel}`);
  
  try {
    const ai = getAIInstance();
    
    const prompt = `
Article Title: ${title}
Article Content/Summary: ${content}

Please write the Facebook post now. Make it direct, engaging, and ready to post.
`;

    const response = await ai.models.generateContent({
      model: config.geminiModel,
      contents: prompt,
      config: {
        systemInstruction: config.systemInstruction
      }
    });

    if (!response.text) {
      throw new Error('Empty response received from Gemini API');
    }

    let postContent = response.text.trim();
    
    // Clean up markdown bold asterisks (**) since Facebook doesn't render them and displays them raw
    postContent = postContent.replace(/\*\*/g, '');
    
    console.log(`[Gemini] Successfully generated post:\n---\n${postContent}\n---`);
    return postContent;
  } catch (error) {
    console.error('[Gemini Error] Failed to generate content:', error.message);
    throw error;
  }
}
