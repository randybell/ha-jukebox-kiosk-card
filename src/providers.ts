/** Provider badge from an MA URI, e.g. "spotify://track/abc" -> "Spotify". */
const LABELS: Record<string, string> = {
  library: 'Library',
  spotify: 'Spotify',
  spotify_connect: 'Spotify',
  apple_music: 'Apple Music',
  tidal: 'Tidal',
  qobuz: 'Qobuz',
  deezer: 'Deezer',
  ytmusic: 'YT Music',
  youtube_music: 'YT Music',
  soundcloud: 'SoundCloud',
  tunein: 'TuneIn',
  radiobrowser: 'Radio',
  radio_browser: 'Radio',
  plex: 'Plex',
  jellyfin: 'Jellyfin',
  opensubsonic: 'Subsonic',
  subsonic: 'Subsonic',
  filesystem_local: 'Local files',
  filesystem_smb: 'Network files',
  filesystem_nfs: 'Network files',
  builtin: 'Built-in',
  audible: 'Audible',
  audiobookshelf: 'Audiobookshelf',
  podcastfeed: 'Podcast',
  itunes_podcasts: 'Podcasts',
  siriusxm: 'SiriusXM',
  bbc_sounds: 'BBC Sounds',
};

export function providerKey(uri: string | undefined): string {
  if (!uri) return '';
  const m = /^([a-z0-9_\-]+):\/\//i.exec(uri);
  if (!m) return '';
  // MA instance ids look like "filesystem_smb--a1b2c3" -> domain "filesystem_smb"
  return m[1].toLowerCase().split('--')[0];
}

export function providerLabel(uri: string | undefined, fallback?: string): string {
  const key = providerKey(uri) || (fallback ?? '').toLowerCase().split('--')[0];
  if (!key) return '';
  // any provider's radio station (radiobrowser://radio/<uuid>, tunein://radio/...) is badged plainly as Radio
  if (key !== 'library' && /^[a-z0-9_\-]+:\/\/radio\//i.test(uri ?? '')) return 'Radio';
  if (LABELS[key]) return LABELS[key];
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
