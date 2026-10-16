# VidGate

YouTube-style app with two roles.

- **Administrator** connects one Gmail / YouTube account. Every video YouTube gives that account comes into the admin's **To review** list. The admin approves or rejects each one (or many at once, or a whole channel with a rule).
- **User** sees and plays only the approved videos. Rejected and pending videos never leave the server.

## What comes in from the connected account

| Source | What it pulls |
|---|---|
| Subscriptions | Latest uploads (default 10) from every channel the account subscribes to |
| Liked | Videos the account liked |
| Playlists | Every video in the account's own playlists |
| Trending | Top trending videos overall and in every YouTube category for your region (default India) |
| Search | Anything the admin searches for across all of YouTube |
| Link | Any single video the admin pastes |

Sync runs right after connecting, then every 6 hours, or on **Sync now**.

**Limit:** YouTube's official API does not give out an account's personal Home-page recommendations or watch history, so those cannot be copied exactly. The sources above are everything the official API allows. The API also has a free quota of 10,000 units a day; a full sync uses a few hundred units and each search uses 100.

## 1. Run it (works right away with demo videos)

1. Install Node.js 18 or newer from https://nodejs.org
2. In this folder:

```
npm install
npm start
```

3. Open http://localhost:3000 and log in as **admin / admin123**.
4. Click **Load demo videos**, approve a few, then log out and log in as **student / student123** to see the user side.

## 2. Connect a real YouTube account (one-time Google setup)

1. Go to https://console.cloud.google.com and create a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen** → External → fill the app name and your email → add your Gmail under **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web application** → Authorized redirect URI: `http://localhost:3000/auth/google/callback`.
5. Copy `config.example.json` to `config.json` and paste the Client ID and Client Secret.
6. Restart (`npm start`), log in as admin, click **Connect YouTube account**, and sign in with the Gmail whose YouTube you want.

## Settings (config.json)

| Key | Meaning |
|---|---|
| region | Country code for trending (IN, US, …) |
| videosPerChannel | How many latest uploads to take from each subscribed channel |
| trendingPerCategory | How many trending videos per category |
| autoSyncHours | How often to sync automatically (0 = off) |

## Files

```
server.js            backend, Google sign-in, YouTube sync, admin + user API
public/index.html    login, admin review screens, user feed
public/app.js        frontend logic
public/style.css     styles
config.example.json  template for Google settings
data.json            created automatically (users, videos, decisions, rules)
```

Change the default passwords before letting other people use the app. The app controls what users see inside VidGate; it cannot block youtube.com itself.
