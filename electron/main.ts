import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { URL } from 'node:url';

type ImportStatus = 'not imported yet' | 'matched' | 'imported' | 'failed';

type ImportFile = {
  path: string;
  name: string;
  status: ImportStatus;
  detail?: string;
};

type Progress = {
  folder: string;
  playlistId: string;
  imported: string[];
};

type ImportOptions = {
  folder: string;
  playlistName: string;
  playlistDescription: string;
  clientId: string;
};

let mainWindow: BrowserWindow | null = null;
let importing = false;
let importControl: { paused: boolean; cancelled: boolean; controller: AbortController } | null = null;

class ImportCancelledError extends Error {
  constructor() {
    super('Import cancelled.');
  }
}

function send(payload: Record<string, unknown>): void {
  mainWindow?.webContents.send('import-event', payload);
}

function walkMp3Files(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) return walkMp3Files(filePath);
    return entry.isFile() && filePath.toLowerCase().endsWith('.mp3') ? [filePath] : [];
  });
}

type TrackCandidate = {
  artist?: string;
  track: string;
  album?: string;
  query: string;
};

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeText(left).split(' ').filter(Boolean));
  const rightTokens = new Set(normalizeText(right).split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap / new Set([...leftTokens, ...rightTokens]).size;
}

function parseFilename(filePath: string): TrackCandidate[] {
  const filename = path.basename(filePath, path.extname(filePath));
  const cleaned = filename
    .replace(/^\s*(?:disc\s*)?\d{1,3}\s*[-_. ]\s*/i, '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\((?:feat\.?|ft\.?|remaster|live|official)[^)]+\)/gi, ' ')
    .trim();
  const parts = cleaned.split(/\s+-\s+|\s*__+\s*|\s+[|~–—]\s+|\s+by\s+/i).map((part) => part.trim()).filter(Boolean);
  const candidates: TrackCandidate[] = [];
  const add = (track: string, artist?: string, album?: string) => {
    if (track) candidates.push({ track, artist, album, query: [track, artist, album].filter(Boolean).join(' ') });
  };
  if (parts.length > 1) {
    add(parts.slice(1).join(' - '), parts[0]);
    add(parts[0], parts.slice(1).join(' - '));
  } else {
    add(cleaned);
  }
  const parentFolder = path.basename(path.dirname(filePath));
  if (parentFolder) add(cleaned, parentFolder);
  return candidates;
}

async function getTrackCandidates(filePath: string): Promise<TrackCandidate[]> {
  const candidates = parseFilename(filePath);
  try {
    const metadata = await parseFile(filePath, { skipCovers: true });
    const track = metadata.common.title?.trim();
    const artist = metadata.common.artist?.trim() || metadata.common.albumartist?.trim();
    const album = metadata.common.album?.trim();
    if (track) candidates.unshift({ track, artist, album, query: [track, artist, album].filter(Boolean).join(' ') });
  } catch {
    // Filename candidates remain available when a file has no readable tags.
  }
  return candidates.filter((candidate, index, all) => (
    all.findIndex((other) => normalizeText(other.query) === normalizeText(candidate.query)) === index
  ));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatDuration(milliseconds: number): string {
  let seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (seconds || !parts.length) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  return parts.join(' ');
}

async function waitForRateLimit(milliseconds: number): Promise<void> {
  const endTime = Date.now() + milliseconds;
  while (true) {
    if (importControl?.cancelled) throw new ImportCancelledError();
    const remaining = endTime - Date.now();
    if (remaining <= 0) return;
    send({ type: 'message', message: `Spotify rate limit reached. Retrying in ${formatDuration(remaining)}...` });
    await sleep(Math.min(1_000, remaining));
  }
}

async function waitForResume(): Promise<void> {
  while (importControl?.paused && !importControl.cancelled) {
    await sleep(250);
  }
  if (importControl?.cancelled) throw new ImportCancelledError();
}

async function spotifyFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await waitForResume();
    const response = await fetch(url, {
      ...init,
      signal: importControl?.controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (response.ok) return response;
    if (response.status === 429 && attempt < 5) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 1_000 * 2 ** attempt);
      await waitForRateLimit(delay);
      continue;
    }
    if (importControl?.cancelled) throw new ImportCancelledError();
    throw new Error(`${init.method || 'GET'} ${url} failed: ${response.status} ${await response.text()}`);
  }
  throw new Error('Spotify request failed after multiple retries.');
}

function progressPath(folder: string): string {
  const id = crypto.createHash('sha256').update(path.resolve(folder)).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), `spotify-import-progress-${id}.json`);
}

function readProgress(folder: string, playlistId: string): Progress {
  const filePath = progressPath(folder);
  if (!fs.existsSync(filePath)) return { folder: path.resolve(folder), playlistId, imported: [] };
  try {
    const progress = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Progress;
    return progress.folder === path.resolve(folder) && progress.playlistId === playlistId
      ? progress
      : { folder: path.resolve(folder), playlistId, imported: [] };
  } catch {
    return { folder: path.resolve(folder), playlistId, imported: [] };
  }
}

function writeProgress(folder: string, progress: Progress): void {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(progressPath(folder), JSON.stringify(progress, null, 2) + '\n');
}

function openAuthorization(clientId: string): Promise<string> {
  const redirectUri = 'http://127.0.0.1:53682/callback';
  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const scopes = ['playlist-modify-private', 'playlist-read-private', 'user-read-private'];
  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('code_challenge', challenge);

  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || '/', redirectUri);
      const error = requestUrl.searchParams.get('error');
      const code = requestUrl.searchParams.get('code');
      if (error) {
        response.writeHead(400).end('Spotify authorization was denied.');
        server.close();
        reject(new Error(`Spotify authorization failed: ${error}`));
        return;
      }
      if (requestUrl.pathname === '/callback' && code) {
        response.writeHead(200, { 'Content-Type': 'text/plain' }).end('Authorization complete. You can close this tab.');
        server.close();
        resolve(`${code}\n${verifier}`);
        return;
      }
      response.writeHead(404).end('Not found');
    });
    server.on('error', reject);
    server.listen(53682, '127.0.0.1', () => {
      send({ type: 'message', message: 'Opening Spotify authorization in your browser...' });
      void shell.openExternal(authUrl.toString());
    });
  });
}

async function authenticate(clientId: string): Promise<string> {
  const result = await openAuthorization(clientId);
  const [code, verifier] = result.split('\n');
  const body = new URLSearchParams({ client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:53682/callback', code_verifier: verifier });
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  const token = await response.json() as { access_token: string };
  return token.access_token;
}

async function findPlaylist(token: string, userId: string, name: string): Promise<any | null> {
  for (let offset = 0; ; offset += 50) {
    const url = new URL('https://api.spotify.com/v1/me/playlists');
    url.searchParams.set('limit', '50');
    url.searchParams.set('offset', String(offset));
    const data = await (await spotifyFetch(token, url.toString())).json() as any;
    const match = (data.items || []).find((item: any) => item.name === name && item.owner?.id === userId);
    if (match) return match;
    if (!data.next || !(data.items || []).length) return null;
  }
}

async function searchTrack(token: string, filePath: string): Promise<any | null> {
  const candidates = await getTrackCandidates(filePath);
  let best: { item: any; score: number } | null = null;

  for (const candidate of candidates) {
    const url = new URL('https://api.spotify.com/v1/search');
    url.searchParams.set('type', 'track');
    url.searchParams.set('limit', '10');
    url.searchParams.set('market', 'from_token');
    url.searchParams.set('q', candidate.query.replace(/\s+/g, ' ').trim());
    const data = await (await spotifyFetch(token, url.toString())).json() as any;

    for (const item of data?.tracks?.items || []) {
      const artistNames = (item.artists || []).map((artist: any) => artist.name);
      const trackName = String(item.name || '');
      const albumName = String(item.album?.name || '');
      const normalizedTrack = normalizeText(trackName);
      const targetTrack = normalizeText(candidate.track);
      let score = tokenSimilarity(candidate.track, trackName) * 10;
      if (normalizedTrack === targetTrack) score += 18;
      else if (normalizedTrack.includes(targetTrack) || targetTrack.includes(normalizedTrack)) score += 8;
      if (candidate.artist) {
        const artistMatch = artistNames.some((artist: string) => normalizeText(artist) === normalizeText(candidate.artist!));
        const artistSimilar = artistNames.some((artist: string) => tokenSimilarity(artist, candidate.artist!) >= 0.5);
        if (artistMatch) score += 18;
        else if (artistSimilar) score += 8;
      }
      if (candidate.album && normalizeText(albumName) === normalizeText(candidate.album)) score += 5;
      if (!best || score > best.score) best = { item, score };
    }
  }

  if (!best) return null;
  const minimumScore = candidates.some((candidate) => candidate.artist) ? 24 : 14;
  return best.score >= minimumScore ? best.item : null;
}

async function runImport(options: ImportOptions): Promise<void> {
  if (!options.clientId.trim()) throw new Error('Enter your Spotify Client ID first.');
  const files = walkMp3Files(options.folder);
  if (!files.length) throw new Error('No MP3 files were found in that folder.');
  const initialFiles: ImportFile[] = files.map((filePath) => ({ path: filePath, name: path.basename(filePath), status: 'not imported yet' }));
  send({ type: 'files', files: initialFiles });

  const token = await authenticate(options.clientId.trim());
  const me = await (await spotifyFetch(token, 'https://api.spotify.com/v1/me')).json() as any;
  let playlist = await findPlaylist(token, me.id, options.playlistName);
  if (!playlist) {
    playlist = await (await spotifyFetch(token, 'https://api.spotify.com/v1/me/playlists', {
      method: 'POST',
      body: JSON.stringify({ name: options.playlistName, public: false, description: options.playlistDescription }),
    })).json();
    send({ type: 'message', message: `Created playlist: ${playlist.name}` });
  } else {
    await spotifyFetch(token, `https://api.spotify.com/v1/playlists/${playlist.id}`, {
      method: 'PUT',
      body: JSON.stringify({ description: options.playlistDescription }),
    });
    send({ type: 'message', message: `Using existing playlist: ${playlist.name}` });
  }

  const progress = readProgress(options.folder, playlist.id);
  const imported = new Set(progress.imported);
  const statuses = new Map<string, ImportFile>(initialFiles.map((file) => [file.path, file]));
  for (const filePath of imported) {
    const file = statuses.get(filePath);
    if (file) file.status = 'imported';
  }
  send({ type: 'files', files: [...statuses.values()] });

  for (const filePath of files) {
    if (imported.has(filePath)) continue;
    const file = statuses.get(filePath)!;
    try {
      await waitForResume();
      const track = await searchTrack(token, filePath);
      if (!track) {
        file.status = 'failed';
        file.detail = 'No Spotify match found';
        send({ type: 'status', file });
        continue;
      }
      file.status = 'matched';
      file.detail = `${track.artists?.[0]?.name || 'Unknown artist'} - ${track.name}`;
      send({ type: 'status', file });
      await spotifyFetch(token, `https://api.spotify.com/v1/playlists/${playlist.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ uris: [track.uri] }),
      });
      file.status = 'imported';
      send({ type: 'status', file });
      imported.add(filePath);
      progress.imported = [...imported];
      writeProgress(options.folder, progress);
    } catch (error) {
      if (error instanceof ImportCancelledError || importControl?.cancelled) break;
      file.status = 'failed';
      file.detail = error instanceof Error ? error.message : String(error);
      send({ type: 'status', file });
    }
  }

  if (importControl?.cancelled) {
    send({ type: 'cancelled', message: 'Import cancelled. Completed files are saved and will be skipped next time.' });
    return;
  }

  const failed = [...statuses.values()].filter((file) => file.status === 'failed').length;
  const reportPath = path.join(app.getPath('userData'), 'spotify-import-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ playlist: playlist.external_urls?.spotify || playlist.id, files: [...statuses.values()] }, null, 2) + '\n');
  send({ type: 'complete', playlistUrl: playlist.external_urls?.spotify, reportPath, message: failed ? `Finished with ${failed} failed file(s).` : 'Import complete.' });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'Spotify Importer',
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#f5f0e8',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  void mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-default-client-id', () => process.env.SPOTIFY_CLIENT_ID || '');

ipcMain.handle('start-import', async (_event, options: ImportOptions) => {
  if (importing) throw new Error('An import is already running.');
  importing = true;
  importControl = { paused: false, cancelled: false, controller: new AbortController() };
  try {
    await runImport(options);
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    importing = false;
    importControl = null;
  }
});

ipcMain.handle('pause-import', () => {
  if (!importControl) return;
  importControl.paused = !importControl.paused;
  send({ type: importControl.paused ? 'paused' : 'resumed', message: importControl.paused ? 'Import paused.' : 'Import resumed.' });
});

ipcMain.handle('cancel-import', () => {
  if (!importControl) return;
  importControl.cancelled = true;
  importControl.controller.abort();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
