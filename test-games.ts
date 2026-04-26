import SteamUser from 'steam-user';
import fetch from 'node-fetch';

const client = new SteamUser();

client.on('webSession', async (sessionID, cookies) => {
  console.log("Logged in!");
  // SteamUser provides getUserOwnedApps
  try {
    const apps = await client.getUserOwnedApps(client.steamID);
    console.log("getUserOwnedApps returned:", apps);
    process.exit(0);
  } catch (e) {
    console.log("Error getting apps via steam-user:", e);
    process.exit(1);
  }
});

client.logOn({
  accountName: 'ympbo54012',
  password: 'hure99746B'
});
