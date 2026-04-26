import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import SteamUser from 'steam-user';
import { HttpsProxyAgent } from 'https-proxy-agent';
import 'lzma';
import 'adm-zip';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

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
      const respond = (status: number, data: any) => {
        if (!responded) {
          responded = true;
          try { client.logOff(); } catch (e) {}
          res.status(status).json(data);
        }
      };

      const timeout = setTimeout(() => {
        respond(408, { error: 'Logon attempt timed out (Steam servers might be slow)' });
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
        
        try {
          let games: any[] = [];
          let gameCount = 0;
          
          try {
              const appsData = await client.getUserOwnedApps(steamId, { includeAppInfo: true, includePlayedFreeGames: true });
              games = appsData.apps || [];
              gameCount = appsData.app_count || games.length;
          } catch (e) {
              console.error('Error fetching owned apps:', e);
          }

          let userData = null;
          try {
              const cookieStr = cookies.join('; ');
              let fetchOpts: any = { headers: { Cookie: cookieStr } };
              if (proxy) {
                  fetchOpts.agent = new HttpsProxyAgent(proxy.startsWith('http') ? proxy : `http://${proxy}`);
              }
              
              const profileRes = await fetch(`https://steamcommunity.com/profiles/${steamId.toString()}/?xml=1`, fetchOpts);
              const text = await profileRes.text();

              if (!text.includes('<error>')) {
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
                  steamid: steamId.toString(),
                  personaname: personaname || username,
                  avatarfull: avatarfull || 'https://steamcommunity-a.akamaihd.net/public/images/applications/store/default.png',
                  communityvisibilitystate: visibilityStateStr ? parseInt(visibilityStateStr, 10) : 3,
                  personastate,
                  loccountrycode: location || '',
                  timecreated,
                  profileurl: `https://steamcommunity.com/profiles/${steamId.toString()}`
                };
              }
          } catch (e) {
              console.error('Error fetching XML persona:', e);
          }

          if (!userData) {
              userData = {
                  steamid: steamId.toString(),
                  personaname: username,
                  avatarfull: 'https://steamcommunity-a.akamaihd.net/public/images/applications/store/default.png',
                  communityvisibilitystate: 3,
                  personastate: 0,
                  loccountrycode: '',
                  timecreated: 0,
                  profileurl: `https://steamcommunity.com/profiles/${steamId.toString()}`
              }
          }

          respond(200, {
            success: true,
            steamId: steamId.toString(),
            profile: userData,
            games: games,
            game_count: gameCount,
            walletBalance: engineWalletBalance
          });
        } catch (e) {
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
