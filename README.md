# Spotify Importer

Import a folder of local MP3 files into a Spotify playlist by matching each filename to a Spotify catalog track. The MP3 files are never uploaded to Spotify; the script adds Spotify track URIs to the playlist, so the playlist works on mobile and other devices.

## Requirements

- macOS, Linux, or Windows
- Node.js 20 or newer
- A Spotify account
- A Spotify Developer app
- Spotify Premium for the app owner while the app is in Development Mode

## Spotify Developer Setup

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Sign in with the Spotify account that will own the playlist.
3. Select **Create app**.
4. Enter an app name, for example `Spotify MP3 Importer`.
5. Use a description such as `A personal tool that matches MP3 filenames to Spotify tracks and creates playlists.`
6. Select **Web API** as the API.
7. Open the app settings and add this Redirect URI exactly:

   ```text
   http://127.0.0.1:53682/callback
   ```

8. Save the settings and copy the app's **Client ID**.
9. In **Settings -> Users Management**, add the Spotify email address that will authorize the importer. Apps in Development Mode only allow approved users.

The importer requests these scopes automatically:

- `playlist-modify-private`: create and modify private playlists
- `playlist-read-private`: find and reuse an existing playlist
- `user-read-private`: search the Spotify catalog

## Install

From this directory:

```bash
npm install
```

Set the Client ID in the terminal session. The Client ID is not a password and may be used in a local command like this:

```bash
export SPOTIFY_CLIENT_ID="your-client-id"
```

## Import MP3s

Run the importer with the folder containing the MP3 files:

```bash
npm run spotify:import -- "/path/to/your/mp3-folder"
```

For example:

```bash
npm run spotify:import -- ~/Downloads/torrent/Classic\ Rock\ Hits\ \(2026\)
```

The script opens Spotify authorization in the default browser. Approve access once, then the script searches each MP3 filename and adds matched tracks to a private playlist.

By default, the playlist name is the name of the MP3 folder:

```text
Classic Rock Hits (2026)
```

If that playlist already exists and is owned by the current Spotify user, it is reused instead of creating another playlist.

## Desktop App

The repository also includes an Electron desktop app with a drag-and-drop interface and a live status ledger for every MP3.

Build and launch it with:

```bash
npm run app
```

In the app, the Client ID field is a per-run override. You can paste a different Client ID there whenever needed. If `SPOTIFY_CLIENT_ID` is set before launching the app, it is loaded as the default value and can still be replaced in the field.

```bash
SPOTIFY_CLIENT_ID="your-client-id" npm run desktop
```

Then:

1. Paste the Spotify Client ID into the Client ID field.
2. Drag an MP3 folder onto the drop area, or choose it with the folder picker.
3. Confirm the playlist name and description.
4. Select **Start importing**.
5. Approve Spotify access in the browser window that opens.

Each file is shown with one of these statuses:

- **not imported yet**: discovered in the selected folder but not processed
- **matched**: a Spotify track was found and is being added
- **imported**: the Spotify track was successfully added to the playlist
- **failed**: no match was found or Spotify returned an error

The app saves a checkpoint after every successful upload. If the app stops halfway through, select the same folder and playlist again; already imported files are restored as **imported** and the remaining files continue from the first unfinished item.

## Playlist Options

Override the playlist name and description from the command line:

```bash
npm run spotify:import -- "/path/to/mp3-folder" \
  --playlist-name "Classic Rock Favorites" \
  --playlist-description "My favorite classic rock songs"
```

The description can also be set with an environment variable:

```bash
export SPOTIFY_PLAYLIST_DESCRIPTION="My favorite classic rock songs"
```

Run `--help` to see the available options:

```bash
npm run spotify:import -- --help
```

## Resume After a Failure

The importer saves progress immediately after every successful track upload. If it stops partway through, run the same command again. It will reuse the same playlist and skip files already recorded as uploaded.

Progress files are named like this and are stored in the project directory:

```text
spotify-import-progress-<folder-id>.json
```

Unmatched files are not marked as uploaded, so they can be retried on a later run.

The importer retries Spotify `429 Too Many Requests` responses using Spotify's `Retry-After` value when available, with exponential backoff as a fallback.

## Reports

After a successful run, the script writes:

```text
spotify-import-report.json
```

The report includes the playlist URL, the number of tracks matched during that run, and the unmatched filenames.

## Filename Matching

Filenames are interpreted using the common format:

```text
Artist - Track.mp3
```

Leading track numbers, bracketed tags, and parenthesized tags are removed. For example:

```text
001. Aerosmith - Dream On.mp3
```

is searched as `Dream On Aerosmith`.

## Troubleshooting

### `403 Forbidden` during playlist creation

Confirm that:

- The authorizing Spotify account is listed in the app's **Users Management** allowlist.
- The app owner has Spotify Premium while the app is in Development Mode.
- The redirect URI is exactly `http://127.0.0.1:53682/callback`.

### `Insufficient client scope`

Run the importer again and approve the latest permissions. The current version requests all three scopes listed above.

### Browser authorization does not return to the script

Confirm that port `53682` is available and that the redirect URI in the Developer Dashboard exactly matches the configured URI. You can override it with:

```bash
export SPOTIFY_REDIRECT_URI="http://127.0.0.1:53682/callback"
```

### No tracks are matched

Use `Artist - Track.mp3` filenames where possible. Review `spotify-import-report.json` for the files that need manual attention.

## Development

Type-check the importer with:

```bash
npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck spotify-import.ts
```
