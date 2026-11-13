# bin/ — local binaries (not committed)

`yt-dlp.exe` is **not** part of this repository (it is a 22 MB third-party binary).
The plugin works without it for direct media URLs (ffmpeg handles those); it is only
needed for site-specific extraction when batch-downloading a corpus.

Fetch it once into this directory:

```powershell
Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" `
  -OutFile "bin/yt-dlp.exe"
```

Or with a package manager of your choice (`winget install yt-dlp`, `scoop install yt-dlp`,
`pip install yt-dlp`). `lib/ingest.js` looks for it in this directory first, then on `PATH`,
then in the usual Windows install locations.

yt-dlp is released under the Unlicense (public domain). Respect the terms of service of
whatever site you download from, and the copyright of the media itself.
