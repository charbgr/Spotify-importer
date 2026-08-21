import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { URL } from 'node:url';

type Candidate = {
  filePath: string;
  artist?: string;
  track?: string;
  album?: string;
  query: string;
};

type SpotifyToken = {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
};

type CliOptions = {
  inputDir?: string;
  playlistName?: string;
  playlistDescription?: string;
  help: boolean;
};

type ImportProgress = {
  inputDir: string;
  playlistId: string;
  completedFiles: string[];
};

function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = { help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    const readValue = (option: string): string => {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`${option} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (arg === '--playlist-name') {
      options.playlistName = readValue(arg);
    } else if (arg === '--playlist-description') {
      options.playlistDescription = readValue(arg);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.inputDir) {
      throw new Error('Only one MP3 folder may be provided.');
    } else {
      options.inputDir = arg;
    }
  }

  return options;
}

const cliOptions = parseCliArgs(process.argv.slice(2));

if (cliOptions.help) {
  console.log(`Usage: npm run spotify:import -- /path/to/mp3-folder [options]

Options:
  --playlist-name "Name"             Override the folder name
  --playlist-description "Description" Set the playlist description
  --help                              Show this help`);
  process.exit(0);
}

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:53682/callback';
const INPUT_DIR = cliOptions.inputDir;

if (!SPOTIFY_CLIENT_ID) {
  throw new Error('Set SPOTIFY_CLIENT_ID first.');
}

if (!INPUT_DIR) {
  throw new Error('Usage: npm run spotify:import -- /path/to/mp3-folder');
}

const DEFAULT_PLAYLIST_NAME = cliOptions.playlistName
  || process.env.SPOTIFY_PLAYLIST_NAME
  || path.basename(path.resolve(INPUT_DIR));
const CUSTOM_PLAYLIST_DESCRIPTION = cliOptions.playlistDescription
  ?? process.env.SPOTIFY_PLAYLIST_DESCRIPTION;
const DEFAULT_PLAYLIST_DESCRIPTION = CUSTOM_PLAYLIST_DESCRIPTION
  || `Auto-generated from MP3 files in ${INPUT_DIR}`;
const RESOLVED_INPUT_DIR = path.resolve(INPUT_DIR);
const PROGRESS_ID = crypto.createHash('sha256').update(RESOLVED_INPUT_DIR).digest('hex').slice(0, 16);
const PROGRESS_PATH = path.resolve(`spotify-import-progress-${PROGRESS_ID}.json`);

const scopes = ['playlist-modify-private', 'playlist-read-private', 'user-read-private'];

function base64url(input: Buffer) {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createPkcePair() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function openInDefaultBrowser(url: string): void {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  execFile(command, args, (error) => {
    if (error) {
      console.log(`Could not open the browser automatically. Open this URL manually:\n${url}`);
    }
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function walkMp3Files(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return walkMp3Files(full);
    if (entry.isFile() && full.toLowerCase().endsWith('.mp3')) return [full];
    return [];
  });
}

function parseFilename(filePath: string): Candidate {
  const filename = path.basename(filePath, path.extname(filePath));
  const cleaned = filename
    .replace(/^\d+\s*[-_. ]\s*/, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\([^)]+\)/g, '')
    .trim();

  const parts = cleaned.split(/\s+-\s+| - | – | — /).map((p) => p.trim()).filter(Boolean);
  const artist = parts.length > 1 ? parts[0] : undefined;
  const track = parts.length > 1 ? parts.slice(1).join(' - ') : cleaned;
  const query = [track, artist].filter(Boolean).join(' ');
  return { filePath, artist, track, query };
}

async function getAuthCode(verifier: string, challenge: string): Promise<string> {
  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', SPOTIFY_CLIENT_ID!);
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('code_challenge', challenge);

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', REDIRECT_URI);
    if (reqUrl.pathname === '/callback' && reqUrl.searchParams.get('code')) {
      const code = reqUrl.searchParams.get('code')!;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Spotify authorization complete. You can close this tab.');
      server.close();
      (server as any).code = code;
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(53682, '127.0.0.1', resolve));
  const authorizationUrl = authUrl.toString();
  console.log(`Opening Spotify authorization in your default browser...\n${authorizationUrl}\n`);
  openInDefaultBrowser(authorizationUrl);

  while (!(server as any).code) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const code = (server as any).code as string;
  return code;
}

async function exchangeCodeForToken(code: string, verifier: string): Promise<SpotifyToken> {
  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID!,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }

  return response.json() as Promise<SpotifyToken>;
}

async function spotifyFetch(token: string, url: string, init: RequestInit = {}) {
  const maxAttempts = 6;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    if (response.ok) return response;

    if (response.status === 429 && attempt < maxAttempts - 1) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const backoffMilliseconds = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 1_000 * 2 ** attempt);
      console.log(`Spotify rate limit reached. Retrying in ${Math.ceil(backoffMilliseconds / 1000)}s...`);
      await sleep(backoffMilliseconds);
      continue;
    }

    throw new Error(`${init.method || 'GET'} ${url} failed: ${response.status} ${await response.text()}`);
  }

  throw new Error(`${init.method || 'GET'} ${url} failed after ${maxAttempts} attempts`);
}

async function searchTrack(token: string, candidate: Candidate) {
  const q = candidate.query.replace(/\s+/g, ' ').trim();
  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('type', 'track');
  url.searchParams.set('limit', '5');
  url.searchParams.set('market', 'from_token');
  url.searchParams.set('q', q);

  const response = await spotifyFetch(token, url.toString());
  const data = await response.json() as any;
  const items = data?.tracks?.items || [];
  if (!items.length) return null;

  const targetArtist = candidate.artist?.toLowerCase();
  const targetTrack = candidate.track?.toLowerCase();

  const scored = items.map((item: any) => {
    const artistNames = (item.artists || []).map((a: any) => a.name.toLowerCase());
    const trackName = String(item.name || '').toLowerCase();
    let score = 0;
    if (targetTrack && trackName === targetTrack) score += 10;
    if (targetTrack && trackName.includes(targetTrack)) score += 4;
    if (targetArtist && artistNames.some((name: string) => name === targetArtist)) score += 8;
    if (targetArtist && artistNames.some((name: string) => name.includes(targetArtist))) score += 3;
    return { item, score };
  });

  scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score);
  return scored[0].item;
}

async function findPlaylist(token: string, userId: string, name: string) {
  for (let offset = 0; ; offset += 50) {
    const url = new URL('https://api.spotify.com/v1/me/playlists');
    url.searchParams.set('limit', '50');
    url.searchParams.set('offset', String(offset));

    const response = await spotifyFetch(token, url.toString());
    const data = await response.json() as any;
    const match = (data.items || []).find((item: any) => (
      item.name === name && item.owner?.id === userId
    ));
    if (match) return match;
    if (!data.next || !(data.items || []).length) return null;
  }
}

function loadProgress(playlistId: string): ImportProgress {
  if (!fs.existsSync(PROGRESS_PATH)) {
    return { inputDir: RESOLVED_INPUT_DIR, playlistId, completedFiles: [] };
  }

  try {
    const progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')) as ImportProgress;
    if (progress.inputDir !== RESOLVED_INPUT_DIR || progress.playlistId !== playlistId) {
      return { inputDir: RESOLVED_INPUT_DIR, playlistId, completedFiles: [] };
    }
    return progress;
  } catch {
    console.log(`Could not read progress file. Starting from the first file: ${PROGRESS_PATH}`);
    return { inputDir: RESOLVED_INPUT_DIR, playlistId, completedFiles: [] };
  }
}

function saveProgress(progress: ImportProgress): void {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2) + '\n');
}

async function main() {
  const mp3Files = walkMp3Files(INPUT_DIR);
  if (!mp3Files.length) {
    throw new Error(`No mp3 files found in ${INPUT_DIR}`);
  }

  const { verifier, challenge } = createPkcePair();
  const code = await getAuthCode(verifier, challenge);
  const token = await exchangeCodeForToken(code, verifier);
  const accessToken = token.access_token;

  const meResponse = await spotifyFetch(accessToken, 'https://api.spotify.com/v1/me');
  const me = await meResponse.json() as any;
  let playlist = await findPlaylist(accessToken, me.id, DEFAULT_PLAYLIST_NAME);

  if (playlist) {
    console.log(`Using existing playlist: ${playlist.external_urls?.spotify || playlist.id}`);
    if (CUSTOM_PLAYLIST_DESCRIPTION !== undefined) {
      await spotifyFetch(accessToken, `https://api.spotify.com/v1/playlists/${playlist.id}`, {
        method: 'PUT',
        body: JSON.stringify({ description: CUSTOM_PLAYLIST_DESCRIPTION }),
      });
      console.log('Updated playlist description.');
    }
  } else {
    const playlistResponse = await spotifyFetch(accessToken, 'https://api.spotify.com/v1/me/playlists', {
      method: 'POST',
      body: JSON.stringify({
      name: DEFAULT_PLAYLIST_NAME,
      public: false,
      description: DEFAULT_PLAYLIST_DESCRIPTION,
      }),
    });
    playlist = await playlistResponse.json() as any;
    console.log(`Created playlist: ${playlist.external_urls?.spotify || playlist.id}`);
  }

  const progress = loadProgress(playlist.id);
  const completedFiles = new Set(progress.completedFiles);
  if (completedFiles.size) {
    console.log(`Resuming: ${completedFiles.size} file(s) already uploaded.`);
  }

  const unmatched: string[] = [];
  let matchedCount = 0;

  for (const filePath of mp3Files) {
    if (completedFiles.has(filePath)) continue;

    const candidate = parseFilename(filePath);
    const track = await searchTrack(accessToken, candidate);
    if (!track) {
      unmatched.push(filePath);
      continue;
    }
    process.stdout.write(`Matched ${path.basename(filePath)} -> ${track.artists?.[0]?.name || 'unknown'} - ${track.name}\n`);
    await spotifyFetch(accessToken, `https://api.spotify.com/v1/playlists/${playlist.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ uris: [track.uri] }),
    });
    matchedCount += 1;
    completedFiles.add(filePath);
    progress.completedFiles = [...completedFiles];
    saveProgress(progress);
  }

  const reportPath = path.resolve('spotify-import-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    playlist: playlist.external_urls?.spotify || playlist.id,
    matched: matchedCount,
    unmatched,
  }, null, 2) + '\n');

  console.log('\nDone.');
  console.log(`Playlist: ${playlist.external_urls?.spotify || playlist.id}`);
  console.log(`Matched: ${matchedCount}`);
  console.log(`Unmatched: ${unmatched.length}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Progress: ${PROGRESS_PATH}`);
  if (unmatched.length) {
    console.log('\nUnmatched files:');
    unmatched.slice(0, 50).forEach((file) => console.log(file));
    if (unmatched.length > 50) {
      console.log(`... and ${unmatched.length - 50} more`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
