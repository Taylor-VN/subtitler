/**
 * Safe-area guide sets.
 *
 * Two different things are drawn, and they are not the same kind of claim:
 *
 *   safe   — the rectangle to keep text inside. Outside it, a band is tinted.
 *   avoid  — a region the platform's own interface sits on top of, so anything
 *            drawn there is covered rather than merely cropped.
 *
 * Every measurement is stored as a fraction of the frame, converted from the
 * platform's published pixel figures on their reference canvas (1080x1920 for
 * the vertical apps). Two provenances are mixed here and the `source` field
 * says which is which:
 *
 *   'spec'      the broadcaster or platform publishes these numbers.
 *   'practical' measured from the current interface. Interfaces move; treat
 *               these as a guide and re-check when an app redesigns.
 *
 * A set is offered only for the ratios in `ratios` — TikTok's zones mean
 * nothing on a 16:9 frame, and offering them there invites a wrong answer.
 */

const V_W = 1080;   // reference vertical canvas the published figures use
const V_H = 1920;

/** Published pixel insets on 1080x1920 -> fractions of the frame. */
function vertical(top, right, bottom, left) {
  return { top: top / V_H, right: right / V_W, bottom: bottom / V_H, left: left / V_W };
}

const SAFE_AREA_SETS = {
  none: {
    id: 'none',
    label: 'None',
    ratios: ['16x9', '1x1', '4x5', '9x16'],
    safe: null,
    avoid: [],
    source: 'spec',
    note: 'No guides drawn.'
  },

  generic: {
    id: 'generic',
    label: 'Generic 5% / 10%',
    ratios: ['16x9', '1x1', '4x5', '9x16'],
    safe: { top: 0.10, right: 0.10, bottom: 0.10, left: 0.10 },
    extraBox: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
    avoid: [],
    source: 'practical',
    note: 'The old 4:3-era convention: 5% action safe, 10% title safe. Kept as a neutral default.'
  },

  ebu_r95: {
    id: 'ebu_r95',
    label: '16:9 EBU R95 (broadcast)',
    ratios: ['16x9'],
    // R95 replaced the analogue 5/10% convention with a single 3.5% inset for
    // graphics and text on a 16:9 HD raster.
    safe: { top: 0.035, right: 0.035, bottom: 0.035, left: 0.035 },
    // The 14:9 centre extraction R95 also defines, for the SD down-conversion
    // that crops the sides: 14/16 of the width, full height.
    extraBox: { top: 0, right: (1 - 14 / 16) / 2, bottom: 0, left: (1 - 14 / 16) / 2 },
    extraLabel: '14:9',
    avoid: [],
    source: 'spec',
    note: 'EBU R95: 3.5% graphics safe area, plus the 14:9 centre extraction for SD down-conversion.'
  },

  youtube_16x9: {
    id: 'youtube_16x9',
    label: '16:9 YouTube',
    ratios: ['16x9'],
    safe: { top: 0.06, right: 0.06, bottom: 0.12, left: 0.06 },
    avoid: [
      { top: 0.88, left: 0, right: 0, bottom: 0, label: 'Player controls / progress bar' },
      { top: 0, left: 0.74, right: 0, bottom: 0.86, label: 'Cards, Share, Watch later' }
    ],
    source: 'practical',
    note: 'Keeps captions clear of the progress bar and control row along the bottom, '
        + 'and of the card and share affordances top-right.'
  },

  youtube_shorts: {
    id: 'youtube_shorts',
    label: '9:16 YouTube Shorts',
    ratios: ['9x16'],
    safe: vertical(130, 180, 480, 60),
    avoid: [
      { top: 0.75, left: 0, right: 0, bottom: 0, label: 'Title, channel, CTA' },
      { top: 0.42, left: 0.83, right: 0, bottom: 0.25, label: 'Like / comment / share rail' }
    ],
    source: 'practical',
    note: 'Measured from the current Shorts player: the title and channel block along the '
        + 'bottom and the action rail down the right.'
  },

  instagram_reels: {
    id: 'instagram_reels',
    label: '9:16 Instagram Reels',
    ratios: ['9x16'],
    // Instagram publishes 250 px top and 420 px bottom on a 1080x1920 canvas.
    safe: vertical(250, 180, 420, 60),
    avoid: [
      { top: 0.78, left: 0, right: 0, bottom: 0, label: 'Username, caption, audio' },
      { top: 0.42, left: 0.83, right: 0, bottom: 0.22, label: 'Action rail' }
    ],
    source: 'spec',
    note: 'Instagram\'s published Reels safe zone: 250 px clear at the top, 420 px at the '
        + 'bottom on 1080x1920, plus the action rail on the right.'
  },

  instagram_stories: {
    id: 'instagram_stories',
    label: '9:16 Instagram Stories',
    ratios: ['9x16'],
    // Instagram publishes 250 px clear top and bottom for Stories.
    safe: vertical(250, 60, 250, 60),
    avoid: [
      { top: 0, left: 0, right: 0, bottom: 0.87, label: 'Progress bar, profile, close' },
      { top: 0.87, left: 0, right: 0, bottom: 0, label: 'Reply bar' }
    ],
    source: 'spec',
    note: 'Instagram\'s published Stories safe zone: 250 px clear top and bottom on '
        + '1080x1920 — the progress bar and profile row above, the reply bar below.'
  },

  tiktok: {
    id: 'tiktok',
    label: '9:16 TikTok',
    ratios: ['9x16'],
    // TikTok publishes 130 top, 483 bottom, 44 left, 140 right on 1080x1920.
    safe: vertical(130, 140, 483, 44),
    avoid: [
      { top: 0.75, left: 0, right: 0, bottom: 0, label: 'Handle, caption, music' },
      { top: 0.36, left: 0.85, right: 0, bottom: 0.25, label: 'Action rail' }
    ],
    source: 'spec',
    note: 'TikTok\'s published safe zone: 130 px top, 483 px bottom, 44 px left and '
        + '140 px right on 1080x1920.'
  }
};

/** Sets that make sense for a given project ratio, in menu order. */
function safeAreaSetsFor(ratioId) {
  return Object.values(SAFE_AREA_SETS).filter(set => set.ratios.indexOf(ratioId) !== -1);
}

function getSafeAreaSet(id) {
  return SAFE_AREA_SETS[id] || SAFE_AREA_SETS.generic;
}

/**
 * Renders a guide set into `container` as positioned children.
 *
 * Percentages rather than pixels: the program frame is a scaled copy of the
 * project resolution, so the guides track it through every resize and
 * fullscreen change without being redrawn.
 */
function renderSafeAreas(container, setId, ratioId) {
  if (!container) return null;
  container.innerHTML = '';

  const set = getSafeAreaSet(setId);
  if (!set || !set.safe || set.ratios.indexOf(ratioId) === -1) return null;

  const pct = (n) => `${(n * 100).toFixed(3)}%`;

  // Tint what the platform's interface covers, so the eye reads "do not put a
  // caption here" rather than "this line is a suggestion".
  (set.avoid || []).forEach(zone => {
    const el = document.createElement('div');
    el.className = 'safe-avoid';
    el.style.top = pct(zone.top || 0);
    el.style.left = pct(zone.left || 0);
    el.style.right = pct(zone.right || 0);
    el.style.bottom = pct(zone.bottom || 0);
    if (zone.label) el.title = zone.label;
    container.appendChild(el);
  });

  if (set.extraBox) {
    const extra = document.createElement('div');
    extra.className = 'safe-secondary';
    extra.style.top = pct(set.extraBox.top);
    extra.style.right = pct(set.extraBox.right);
    extra.style.bottom = pct(set.extraBox.bottom);
    extra.style.left = pct(set.extraBox.left);
    if (set.extraLabel) extra.dataset.label = set.extraLabel;
    container.appendChild(extra);
  }

  const safe = document.createElement('div');
  safe.className = 'safe-primary';
  safe.style.top = pct(set.safe.top);
  safe.style.right = pct(set.safe.right);
  safe.style.bottom = pct(set.safe.bottom);
  safe.style.left = pct(set.safe.left);
  container.appendChild(safe);

  const tag = document.createElement('div');
  tag.className = `safe-tag${set.source === 'practical' ? ' practical' : ''}`;
  tag.textContent = set.label;
  tag.title = set.note;
  container.appendChild(tag);

  return set;
}

window.SAFE_AREA_SETS = SAFE_AREA_SETS;
window.safeAreaSetsFor = safeAreaSetsFor;
window.getSafeAreaSet = getSafeAreaSet;
window.renderSafeAreas = renderSafeAreas;
