// Lyrically Song Resolver V2
// Dependency-free, deterministic metadata normalization + candidate scoring.
// This module does NOT call network APIs. It only prepares and scores metadata.

const NOISE_PATTERNS = [
  /\bofficial\s+(?:music\s+)?video\b/gi,
  /\bofficial\s+audio\b/gi,
  /\bmusic\s+video\b/gi,
  /\blyric\s+video\b/gi,
  /\blyrics?\b/gi,
  /\bfull\s+(?:song|video)\b/gi,
  /\bofficial\b/gi,
  /\bvisualizer\b/gi,
  /\bvideo\b/gi,
  /\baudio\b/gi,
  /\b(?:hd|hq|4k|8k)\b/gi,
  /\b(?:feat\.?|ft\.?)\s+[^\]\[()|]+/gi,
  /\b(?:with)\s+[^\]\[()|]+/gi
];

const VARIANT_RULES = [
  { type: 'slowed_reverb', patterns: [/\bslowed\s*\+?\s*reverb\b/i, /\bslowed\s+and\s+reverb\b/i] },
  { type: 'slowed', patterns: [/\bslowed\b/i] },
  { type: 'speed_up', patterns: [/\bsped\s*up\b/i, /\bspeed\s*up\b/i] },
  { type: 'lofi', patterns: [/\blo[-\s]?fi\b/i, /\blofi\b/i] },
  { type: 'nightcore', patterns: [/\bnightcore\b/i] },
  { type: '8d', patterns: [/\b8d(?:\s+audio)?\b/i] },
  { type: 'bass_boosted', patterns: [/\bbass\s*boost(?:ed)?\b/i] },
  { type: 'acoustic', patterns: [/\bacoustic\b/i] },
  { type: 'live', patterns: [/\blive\b/i, /\blive\s+performance\b/i] },
  { type: 'unplugged', patterns: [/\bunplugged\b/i] },
  { type: 'remix', patterns: [/\bremix\b/i, /\brework\b/i, /\bedit\b/i] },
  { type: 'mashup', patterns: [/\bmashup\b/i, /\bmedley\b/i] },
  { type: 'cover', patterns: [/\bcover\b/i, /\bcover\s+version\b/i] },
  { type: 'karaoke', patterns: [/\bkaraoke\b/i] },
  { type: 'instrumental', patterns: [/\binstrumental\b/i, /\binstrumental\s+version\b/i] }
];

function normalizeText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[–—−]/g, '-')
    .replace(/[“”‘’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSegment(value = '') {
  let text = String(value).trim();

  for (const pattern of NOISE_PATTERNS) {
    text = text.replace(pattern, ' ');
  }

  // Remove known version markers from the title query while preserving them
  // separately through detectVariant().
  for (const rule of VARIANT_RULES) {
    for (const pattern of rule.patterns) {
      text = text.replace(pattern, ' ');
    }
  }

  text = text
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[-|:]+\s*/, '')
    .replace(/\s*[-|:]+\s*$/, '')
    .replace(/\s+[-–—]\s*$/, '')
    .trim();

  return text;
}

function detectVariant(value = '') {
  const text = String(value);
  for (const rule of VARIANT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return { type: rule.type, confidence: 1 };
    }
  }
  return { type: 'original', confidence: 1 };
}

function splitArtistNames(value = '') {
  if (!value) return [];

  return String(value)
    .replace(/•.*$/g, '')
    .replace(/\b(feat\.?|ft\.?|featuring|with)\b/gi, ',')
    .replace(/[&]/g, ',')
    .split(/,|\s+x\s+/i)
    .map(normalizeText)
    .filter(Boolean);
}

function diceSimilarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);

  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.92;

  const aTokens = [...new Set(left.split(' '))];
  const bTokens = [...new Set(right.split(' '))];
  const bSet = new Set(bTokens);
  const intersection = aTokens.filter((token) => bSet.has(token)).length;

  if (!intersection) return 0;
  return (2 * intersection) / (aTokens.length + bTokens.length);
}

function titleSimilarity(candidates, entryTitle) {
  const values = Array.isArray(candidates) ? candidates : [candidates];
  let best = 0;
  for (const candidate of values) {
    best = Math.max(best, diceSimilarity(candidate, entryTitle));
  }
  return best;
}

function artistSimilarity(hints, entryArtist) {
  if (!hints?.length || !entryArtist) return null;

  const entryNames = splitArtistNames(entryArtist);
  let best = 0;

  for (const hint of hints) {
    for (const entryName of entryNames) {
      best = Math.max(best, diceSimilarity(hint, entryName));
    }
    best = Math.max(best, diceSimilarity(hint, entryArtist));
  }

  return best;
}

function durationSimilarity(sourceDuration, candidateDuration) {
  if (!sourceDuration || !candidateDuration) return null;

  const diff = Math.abs(Number(sourceDuration) - Number(candidateDuration));
  if (diff <= 2) return 1;
  if (diff <= 5) return 0.9;
  if (diff <= 10) return 0.75;
  if (diff <= 20) return 0.5;
  if (diff <= 35) return 0.2;
  return 0;
}

function variantSimilarity(sourceVariant, candidateVariant) {
  const source = sourceVariant || 'original';
  const candidate = candidateVariant || 'original';

  if (source === candidate) return 1;
  if (source === 'original' && candidate === 'original') return 1;

  // A YouTube edit can still use the original lyrics. Do not make this a hard fail.
  const softCompatible = new Set([
    'lofi:original',
    'slowed:original',
    'slowed_reverb:original',
    'speed_up:original',
    '8d:original',
    'bass_boosted:original'
  ]);

  if (softCompatible.has(`${source}:${candidate}`) || softCompatible.has(`${candidate}:${source}`)) {
    return 0.65;
  }

  return 0.15;
}

function extractVariantText(value = '') {
  return `${value}`;
}

function normalizeTrackMetadata({ platform = 'youtube', title = '', artist = '', duration = 0 } = {}) {
  const rawTitle = String(title || '').trim();
  const rawArtist = String(artist || '').trim();
  const source = platform === 'youtube-music' ? 'youtube-music' : 'youtube';

  const variant = detectVariant(rawTitle);
  const hasPipe = rawTitle.includes('|');
  const pipeParts = rawTitle.split('|').map((part) => part.trim()).filter(Boolean);

  const titleCandidates = [];

  if (hasPipe) {
    // On regular YouTube, the first pipe-delimited segment is very commonly
    // the actual song title; the following segments are often actors, movies,
    // labels, or uploader-added context.
    titleCandidates.push(cleanSegment(pipeParts[0]));
  }

  const dashParts = rawTitle.split(/\s[-–—]\s/).map((part) => part.trim()).filter(Boolean);
  if (!hasPipe && dashParts.length >= 2) {
    // Keep both sides as hypotheses. We intentionally do not decide whether
    // the uploader wrote "Artist - Title" or "Title - Artist" here.
    titleCandidates.push(cleanSegment(dashParts[0]));
    titleCandidates.push(cleanSegment(dashParts[dashParts.length - 1]));
  }

  if (!hasPipe && dashParts.length < 2) {
    titleCandidates.push(cleanSegment(rawTitle));
  }

  const uniqueTitles = [...new Set(
    titleCandidates
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value) => normalizeText(value).length > 1)
  )];

  // YouTube Music provides actual artist metadata much more reliably.
  // Normal YouTube's channel is treated as uploader, not artist.
  let artistHints = [];
  let uploader = '';
  let metadataConfidence = source === 'youtube-music' ? 0.9 : 0.35;

  if (source === 'youtube-music') {
    artistHints = splitArtistNames(rawArtist);
  } else {
    uploader = rawArtist;
  }

  const primaryTitle = uniqueTitles[0] || rawTitle;
  const normalizedTitle = normalizeText(primaryTitle);

  return {
    source,
    rawTitle,
    rawArtist,
    uploader,
    titleCandidates: uniqueTitles.slice(0, 4),
    primaryTitle,
    normalizedTitle,
    artistHints,
    albumHint: pipeParts.length >= 3 ? cleanSegment(pipeParts[pipeParts.length - 1]) : '',
    variant: {
      type: variant.type,
      raw: extractVariantText(rawTitle)
    },
    duration: Number(duration) || 0,
    metadataConfidence
  };
}

function buildLookupQueries(metadata) {
  const queries = [];
  const titles = metadata.titleCandidates.length
    ? metadata.titleCandidates
    : [metadata.primaryTitle || metadata.rawTitle];
  const artist = metadata.artistHints.join(' ');

  for (const title of titles.slice(0, 2)) {
    const query = artist ? `${artist} ${title}`.trim() : title;
    if (query) queries.push(query);
  }

  return [...new Set(queries)].slice(0, 2);
}

function scoreLyricsCandidate(entry, metadata) {
  const entryTitle = entry?.trackName || '';
  const entryArtist = entry?.artistName || '';
  const entryVariant = detectVariant(`${entryTitle} ${entry?.albumName || ''}`).type;

  const titleScore = titleSimilarity(metadata.titleCandidates, entryTitle);
  const artistScore = artistSimilarity(metadata.artistHints, entryArtist);
  const durationScore = durationSimilarity(metadata.duration, entry?.duration);
  const versionScore = variantSimilarity(metadata.variant.type, entryVariant);
  const lyricQuality = entry?.syncedLyrics ? 1 : entry?.plainLyrics ? 0.4 : 0;

  let score;
  if (artistScore !== null) {
    score =
      titleScore * 0.42 +
      artistScore * 0.28 +
      (durationScore ?? 0.5) * 0.18 +
      versionScore * 0.08 +
      lyricQuality * 0.04;
  } else {
    score =
      titleScore * 0.58 +
      (durationScore ?? 0.5) * 0.28 +
      versionScore * 0.10 +
      lyricQuality * 0.04;
  }

  const reasons = [];
  if (titleScore >= 0.95) reasons.push('title_exact');
  else if (titleScore >= 0.80) reasons.push('title_strong');
  else if (titleScore >= 0.65) reasons.push('title_partial');

  if (artistScore !== null) {
    if (artistScore >= 0.95) reasons.push('artist_exact');
    else if (artistScore >= 0.80) reasons.push('artist_strong');
    else if (artistScore < 0.5) reasons.push('artist_weak');
  }

  if (durationScore !== null) {
    if (durationScore >= 0.9) reasons.push('duration_close');
    else if (durationScore >= 0.5) reasons.push('duration_reasonable');
    else if (durationScore < 0.2) reasons.push('duration_far');
  }

  if (versionScore >= 0.9) reasons.push('version_match');
  else if (versionScore < 0.3) reasons.push('version_mismatch');

  if (entry?.syncedLyrics) reasons.push('synced_lyrics');

  let confidence = 'low';
  if (score >= 0.82 && titleScore >= 0.82) confidence = 'high';
  else if (score >= 0.68 && titleScore >= 0.65) confidence = 'medium';

  return {
    entry,
    score,
    confidence,
    titleScore,
    artistScore,
    durationScore,
    versionScore,
    reasons
  };
}

function rankLyricsCandidates(results, metadata) {
  const candidates = (Array.isArray(results) ? results : [])
    .filter(Boolean)
    .map((entry) => scoreLyricsCandidate(entry, metadata))
    .sort((a, b) => b.score - a.score);

  return {
    best: candidates[0] || null,
    candidates: candidates.slice(0, 10)
  };
}

function makeResolution(metadata, ranked) {
  if (!ranked?.best) {
    return {
      status: 'not_found',
      confidence: 'low',
      score: 0,
      title: metadata.primaryTitle,
      artist: metadata.artistHints.join(', '),
      variant: metadata.variant.type,
      reasons: []
    };
  }

  const best = ranked.best;
  const entry = best.entry;

  let confidence = best.confidence;
  const reasons = [...best.reasons];

  // When YouTube does not provide a trustworthy artist, protect against
  // generic titles such as "Hello", "Home", etc. If another candidate
  // is almost as strong, do not call the match high-confidence.
  const second = ranked.candidates?.[1];
  if (!metadata.artistHints.length && second && (best.score - second.score) < 0.04) {
    confidence = confidence === 'high' ? 'medium' : 'low';
    reasons.push('close_competitor');
  }

  if (!metadata.artistHints.length && metadata.primaryTitle.split(/\s+/).length <= 1 && best.score < 0.95) {
    confidence = confidence === 'high' ? 'medium' : confidence;
    reasons.push('generic_title');
  }

  return {
    status: confidence === 'low' ? 'ambiguous' : 'resolved',
    confidence,
    score: Number(best.score.toFixed(4)),
    title: entry.trackName || metadata.primaryTitle,
    artist: entry.artistName || metadata.artistHints.join(', '),
    album: entry.albumName || '',
    duration: entry.duration || null,
    variant: detectVariant(`${entry.trackName || ''} ${entry.albumName || ''}`).type,
    reasons,
    sourceMetadata: {
      source: metadata.source,
      uploader: metadata.uploader,
      rawTitle: metadata.rawTitle,
      rawArtist: metadata.rawArtist
    }
  };
}

export {
  buildLookupQueries,
  makeResolution,
  normalizeText,
  normalizeTrackMetadata,
  rankLyricsCandidates
};
