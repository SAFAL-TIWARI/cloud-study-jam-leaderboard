import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { kv } from '@vercel/kv';
import axios from 'axios';
import * as cheerio from 'cheerio';

// Cache ka time (seconds me) - yahan 30 minutes hai
const CACHE_DURATION_SECONDS = 1800; // 30 * 60

// Google Sheets ko load karne ke liye helper function
async function loadGoogleSheet() {
  try {
    // Validate environment variables
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL is not set');
    }
    if (!process.env.GOOGLE_PRIVATE_KEY) {
      throw new Error('GOOGLE_PRIVATE_KEY is not set');
    }
    if (!process.env.GOOGLE_SHEET_ID) {
      throw new Error('GOOGLE_SHEET_ID is not set');
    }

    console.log('Loading Google Sheet with ID:', process.env.GOOGLE_SHEET_ID);
    
    // JWT authentication setup (google-spreadsheet v4+ ke liye)
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
      ]
    });
    
    // Google Sheet ID se document initialize karein (auth ke saath)
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    
    // Sheet ki info load karein
    try {
      await doc.loadInfo();
    } catch (loadError) {
      console.error('loadInfo error:', loadError.message);
      throw new Error(`Failed to load sheet info: ${loadError.message}`);
    }
    
    console.log('Sheet loaded, total sheets:', doc.sheetsByIndex.length);
    
    // Pehli sheet ko select karein (index 0)
    const sheet = doc.sheetsByIndex[0];
    console.log('Selected sheet title:', sheet.title);
    
    // Rows ko get karein
    const rows = await sheet.getRows();
    
    console.log('Total rows in sheet:', rows.length);
    console.log('Sheet headers:', sheet.headerValues);
    
    if (rows.length === 0) {
      throw new Error('No rows found in the spreadsheet');
    }
    
    // Sirf User Name aur Google Cloud Skills Boost Profile URL waale columns ko extract karein
    const data = rows.map(row => {
      const name = row.get('User Name');
      const url = row.get('Google Cloud Skills Boost Profile URL');
      
      if (!name || !url) {
        console.warn('Row missing required fields:', { name, url });
      }
      
      return {
        name: name || 'Unknown',
        url: url || '',
      };
    });
    
    console.log('Extracted', data.length, 'participants');
    return data;
  } catch (error) {
    console.error('Error in loadGoogleSheet:', error.message);
    console.error('Full error:', error);
    throw error;
  }
}

// Ek profile ko scrape karne ke liye helper function
async function scrapeProfile(url) {
  if (!url || !url.startsWith('http')) {
    return { badgeCount: 0, arcadeComplete: 0 };
  }

  try {
    // Axios se webpage ka HTML download karein
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 10000 // 10 second timeout
    });

    // Cheerio se HTML ko load karein
    const $ = cheerio.load(data);

    // -----------------------------------------------------------------
    // 🚨 WARNING: Yeh selectors (class names) Google ke update karne par
    // badal sakte hain aur code crash ho sakta hai.
    // -----------------------------------------------------------------
    
    // Yahan hum 'profile-badge' class waale saare elements dhoondh rahe hain
    // Aapko yeh class apne browser me "Inspect Element" karke verify karni hogi
    const badgeElements = $('div.profile-badge');
    
    // Skill badges ko count karein (Arcade badge ko EXCLUDE karein)
    let badgeCount = 0;
    let arcadeComplete = 0;

    badgeElements.each((i, el) => {
      // Badge ka title dhoondein
      const badgeTitle = $(el).find('span.ql-title-medium').text();
      
      // Yahan 'The Arcade' ya jo bhi aapke arcade game badge ka naam hai, woh daalein
      if (badgeTitle.includes('The Arcade')) {
        arcadeComplete = 1;
      } else {
        // Agar Arcade nahi hai, toh skill badge count karein
        badgeCount++;
      }
    });

    return { badgeCount, arcadeComplete };
  } catch (error) {
    console.error(`Error scraping ${url}: ${error.message}`);
    // Agar profile private hai ya error aata hai
    return { badgeCount: 0, arcadeComplete: 0, error: 'Private or Invalid Profile' };
  }
}

// Helper function: Limited concurrency ke saath scraping (speed vs rate limiting balance)
async function scrapeProfilesWithLimitedConcurrency(participants, concurrencyLimit = 5) {
  const results = new Array(participants.length);
  let activeRequests = 0;
  let currentIndex = 0;

  return new Promise((resolve, reject) => {
    const processNext = async () => {
      if (currentIndex >= participants.length) {
        // Jab saare requests process ho jayein
        if (activeRequests === 0) {
          resolve(results);
        }
        return;
      }

      if (activeRequests < concurrencyLimit) {
        const index = currentIndex;
        const participant = participants[currentIndex];
        currentIndex++;
        activeRequests++;

        try {
          const result = await scrapeProfile(participant.url);
          results[index] = result;
        } catch (error) {
          console.error(`Error for participant ${index}:`, error);
          results[index] = { badgeCount: 0, arcadeComplete: 0, error: error.message };
        } finally {
          activeRequests--;
          processNext();
        }
      }
    };

    // concurrencyLimit requests ko simultaneously start karein
    for (let i = 0; i < Math.min(concurrencyLimit, participants.length); i++) {
      processNext();
    }
  });
}

// Main API handler
export default async function handler(req, res) {
  const CACHE_KEY = 'leaderboard_data';

  try {
    // 1. Check if KV cache is configured
    let cachedData = null;
    const isKVConfigured = process.env.KV_REST_API_TOKEN && process.env.KV_REST_API_URL;
    
    if (isKVConfigured) {
      cachedData = await kv.get(CACHE_KEY);
      if (cachedData) {
        // Agar cache me data hai, toh wahi bhej dein (FAST)
        return res.status(200).json({ source: 'cache', data: cachedData });
      }
    }

    // 2. Agar cache me data nahi hai, toh "Fresh Data" laayein (SLOW)
    
    // Google Sheet se participants ki list fetch karein
    const participants = await loadGoogleSheet();

    // 5 profiles ko parallel mein scrape karein (speed aur stability ka balance)
    const results = await scrapeProfilesWithLimitedConcurrency(participants, 5);

    // Data ko combine karein
    const freshData = participants.map((participant, index) => ({
      name: participant.name,
      ...results[index],
    }));

    // Data ko sort karein (Highest badges first)
    freshData.sort((a, b) => b.badgeCount - a.badgeCount);

    // 3. Naye data ko cache me save karein (agle 30 min ke liye) - sirf agar KV configured hai
    if (isKVConfigured) {
      await kv.set(CACHE_KEY, freshData, { ex: CACHE_DURATION_SECONDS });
    }

    // Naya data user ko bhej dein
    return res.status(200).json({ source: 'fresh', data: freshData });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}