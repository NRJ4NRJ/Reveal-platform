#!/usr/bin/env python3
"""
daily_pulse.py
-------------------
Fetches French renewable energy news (Solar PV, BESS, Wind) from the previous 30 hours
(72 hours on Mondays to cover Friday–Sunday),
builds a styled HTML email and either sends it or saves a browser preview.

Usage:
    python daily_pulse.py              # send email (requires config.py filled in)
    python daily_pulse.py --preview    # open HTML preview in browser only
"""

import argparse
import feedparser
import html as _html
import os
import re
import sys
import unicodedata
from calendar import timegm
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

# ── Try loading SMTP credentials from config.py (never commit this file) ───────
try:
    import config as _cfg
    SENDER_EMAIL = _cfg.SENDER_EMAIL
    SENDER_PASS  = _cfg.SENDER_PASS
    SMTP_SERVER  = _cfg.SMTP_SERVER
    SMTP_PORT    = _cfg.SMTP_PORT
    CC_EMAILS    = getattr(_cfg, 'CC_EMAILS', [])
except ImportError:
    SENDER_EMAIL = ""
    SENDER_PASS  = ""
    SMTP_SERVER  = "smtp.office365.com"
    SMTP_PORT    = 587
    CC_EMAILS    = []

def _env_first(name: str, current: str) -> str:
    value = os.getenv(name, "").strip()
    return value or current


def _env_int(name: str, current: int) -> int:
    value = os.getenv(name, "").strip()
    if not value:
        return current
    try:
        return int(value)
    except ValueError:
        return current


def _env_list(name: str, current: list[str]) -> list[str]:
    value = os.getenv(name, "").strip()
    if not value:
        return current
    return [item.strip() for item in value.split(",") if item.strip()]


SENDER_EMAIL = _env_first("DAILY_PULSE_SENDER_EMAIL", SENDER_EMAIL)
SENDER_PASS = _env_first("DAILY_PULSE_SENDER_PASS", SENDER_PASS)
SMTP_SERVER = _env_first("DAILY_PULSE_SMTP_SERVER", SMTP_SERVER)
SMTP_PORT = _env_int("DAILY_PULSE_SMTP_PORT", SMTP_PORT)
CC_EMAILS = _env_list("DAILY_PULSE_CC_EMAILS", CC_EMAILS)

RECIPIENT = _env_first("DAILY_PULSE_RECIPIENT", "richard.musi@8p2.fr")

# ── Dolfines banner — embedded once at startup ──────────────────────────────────
import base64 as _b64
_BANNER_PATH = Path(__file__).parent / "Mail Template" / "Bandeau Page.jpg"
try:
    with open(_BANNER_PATH, "rb") as _bf:
        _BANNER_SRC = f"data:image/jpeg;base64,{_b64.b64encode(_bf.read()).decode()}"
except Exception:
    _BANNER_SRC = ""   # fallback: no image shown

# ── Logos — resized and embedded at startup ──────────────────────────────────────
from PIL import Image as _PILImage
import io as _io

def _logo_src(path, width_px):
    """Open image, resize to width_px preserving aspect, return data URI."""
    try:
        img = _PILImage.open(path).convert("RGBA")
        h = int(img.height * width_px / img.width)
        img = img.resize((width_px, h), _PILImage.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="PNG")
        return f"data:image/png;base64,{_b64.b64encode(buf.getvalue()).decode()}"
    except Exception:
        return ""

_TMPL = Path(__file__).parent / "Mail Template"
_LOGO_82          = _logo_src(_TMPL / "Fichier 18orange.png",                    400)
_LOGO_DOLFINES    = _logo_src(_TMPL / "Logo-final-Dolfines-GROUP-EN-scaled.webp", 280)
_LOGO_82_WHITE    = _logo_src(_TMPL / "8p2 advisory white.png",                  240)

# ── RSS Feeds ───────────────────────────────────────────────────────────────────
# Google News RSS — best breadth, no API key required
GOOGLE_FEEDS = [
    ("Google · Solaire France",
     "https://news.google.com/rss/search?q=solaire+france&hl=fr&gl=FR&ceid=FR:fr"),
    ("Google · Photovoltaïque France",
     "https://news.google.com/rss/search?q=photovolta%C3%AFque+france&hl=fr&gl=FR&ceid=FR:fr"),
    ("Google · Stockage énergie France",
     "https://news.google.com/rss/search?q=stockage+%C3%A9nergie+france&hl=fr&gl=FR&ceid=FR:fr"),
    ("Google · BESS France",
     "https://news.google.com/rss/search?q=BESS+batterie+france&hl=fr&gl=FR&ceid=FR:fr"),
    ("Google · Éolien France",
     "https://news.google.com/rss/search?q=%C3%A9olien+france&hl=fr&gl=FR&ceid=FR:fr"),
    ("Google · Solar PV France EN",
     "https://news.google.com/rss/search?q=solar+PV+france&hl=en&gl=FR&ceid=FR:en"),
    ("Google · Battery Storage France EN",
     "https://news.google.com/rss/search?q=battery+storage+france&hl=en&gl=FR&ceid=FR:en"),
    ("Google · Wind Energy France EN",
     "https://news.google.com/rss/search?q=wind+energy+france&hl=en&gl=FR&ceid=FR:en"),
]

# Direct feeds — tuple: (label, url, france_native)
# france_native=True  → French publication covering France primarily; no extra geo-filter needed
# france_native=False → Global publication; must mention France/French entity to be included
DIRECT_FEEDS = [
    ("PV Magazine FR",         "https://www.pv-magazine.fr/feed/",                             True),
    ("Révolution Énergétique", "https://www.revolutionenergetique.com/feed/",                   True),
    ("Enerzine",               "https://www.enerzine.com/feed",                                 True),
    ("Actu-Environnement",     "https://www.actu-environnement.com/rss/actualite_energie.xml",  True),
    ("PV Magazine (EN)",       "https://www.pv-magazine.com/feed/",                             False),
    ("Energy Storage News",    "https://www.energy-storage.news/feed/",                         False),
]

# Google feeds are France-targeted by query but Google still slips in global articles → treat as non-native
ALL_FEEDS = [(s, u, False) for s, u in GOOGLE_FEEDS] + DIRECT_FEEDS

# ── Classification keywords ─────────────────────────────────────────────────────
SOLAR_KW = [
    'solar', 'solaire', 'photovoltaïque', 'photovoltaic', ' pv ', 'pv,', 'pv.',
    'panneau solaire', 'centrale solaire', 'agrivoltaïque', 'agrivoltaic',
    'ombrière', 'tracker solaire', 'floating solar', 'bifacial',
    # CRE / French auction terms
    'appel d\'offres sol', 'appel d\'offres photovoltaïque', 'cre pv', 'cre solaire',
    'ppe3', 'ppe 3', 'ppe2', 'ppe 2',
    'guichet ouvert', 'complément de rémunération solaire',
]
SOLAR_PV_STRICT_KW = [
    'solar pv', 'photovoltaïque', 'photovoltaic', ' pv ', 'pv,', 'pv.',
    'panneau solaire', 'panneaux solaires', 'centrale solaire', 'centrales solaires',
    'parc solaire', 'ferme solaire', 'solar farm', 'solar plant', 'pv plant',
    'pv project', 'solar project', 'agrivoltaïque', 'agrivoltaic', 'ombrière',
    'tracker solaire', 'floating solar', 'bifacial', 'module solaire', 'module pv',
    'onduleur solaire', 'inverter', 'utility-scale solar', 'ground-mounted solar',
]
BESS_KW = [
    'battery', 'batterie', 'bess', 'stockage', 'storage', 'accumulation',
    'energy storage', 'stockage d\'énergie', 'lithium', 'grid-scale battery',
    'système de stockage', 'stationary storage', 'capacité de stockage',
    'stockage par batterie', 'batterie lithium', 'cre stockage',
]
WIND_KW = [
    'wind', 'éolien', 'éolienne', 'offshore', 'onshore', 'turbine',
    'parc éolien', 'wind farm', 'aérogénérateur',
]
ALL_ENERGY_KW = SOLAR_KW + BESS_KW + WIND_KW

# Negative keywords to avoid beauty / lifestyle / non-energy "solar" stories.
OFF_TOPIC_KW = [
    'crème solaire', 'creme solaire', 'écran solaire', 'ecran solaire',
    'sunscreen', 'sun cream', 'sunblock', 'spf ', 'uvb', 'uva', 'after-sun',
    'après-soleil', 'apres-soleil', 'bronzage', 'sun care', 'skincare',
    'soin solaire', 'soins solaires', 'cosmétique', 'cosmetique', 'cosmetics',
    'parfum solaire', 'fragrance solaire', 'fragrance', 'perfume', 'parfum',
    'eau de parfum', 'eau de toilette', 'beauty', 'beauté', 'beaute',
    'maquillage', 'make-up', 'makeup', 'peau', 'visage', 'lèvres', 'levres',
]

# France relevance — article must contain at least one of these to pass the geo-filter
# (applied to all non-native feeds)
FRANCE_KW = [
    'france', 'français', 'française', 'french', 'hexagone',
    # Regulators / institutions
    'cre ', ' cre', 'ademe', 'enedis', 'rte ', 'rte-france',
    'ministère de la transition', 'ministère de l\'énergie',
    # Major French developers & utilities (incl. abroad projects)
    'edf', 'engie', 'totalenergies', 'total energies', 'total eren',
    'neoen', 'voltalia', 'urbasolar', 'akuo', 'valeco', 'photosol',
    'qair', 'luxel', 'quadran', 'jpee', 'sonnedix', 'ideol',
    'glp energy', 'powerflex', 'arkolia', 'omnes capital', 'mirova',
    'lhyfe', 'hydrogène de france', 'reden solar', 'amarenco', 'helexia',
    'enerparc', 'baywa re', 'q energy', 'engie solar', 'edf renouvelables',
    'edf renewables', 'ingeteam', 'colas renouvelables',
    # French grid / market terms
    "appel d'offres", 'complément de rémunération', 'tarif d\'achat',
    'programmation pluriannuelle', 'ppe3', 'ppe 3', 'ppe ', 'réseau de transport',
    # French regions (useful when article title names a project location)
    'occitanie', 'bretagne', 'normandie', 'provence', 'nouvelle-aquitaine',
    'hauts-de-france', 'grand est', 'île-de-france', 'ile-de-france',
    'gironde', 'hérault', 'charente', 'loire', 'rhône',
]

_TOKEN_STOPWORDS = {
    'about', 'avec', 'dans', 'depuis', 'pour', 'pourquoi', 'sans', 'avec', 'chez',
    'this', 'that', 'from', 'into', 'over', 'under', 'after', 'before', 'will',
    'have', 'more', 'than', 'avec', 'dans', 'sous', 'plus', 'moins', 'their',
    'news', 'france', 'french', 'solar', 'solaire', 'energy', 'energie',
    'renewable', 'renewables', 'renewables', 'battery', 'batterie', 'storage',
    'stockage', 'wind', 'eolien', 'éolien', 'today', 'daily', 'says', 'said',
}

_CANONICAL_REPLACEMENTS = {
    'photovoltaïque': 'photovoltaic',
    'photovoltaiques': 'photovoltaic',
    'photovoltaic': 'photovoltaic',
    'solaire': 'solar',
    'éolien': 'wind',
    'eolien': 'wind',
    'éolienne': 'wind',
    'eolienne': 'wind',
    'batterie': 'battery',
    'batteries': 'battery',
    'stockage': 'storage',
    'menaces': 'threat',
    'menace': 'threat',
    'threats': 'threat',
    'cyberattaques': 'cyberattack',
    'cyberattaque': 'cyberattack',
    'cyberattacks': 'cyberattack',
    'cybersecurite': 'cybersecurity',
    'cybersécurité': 'cybersecurity',
    'piratage': 'cyberattack',
    'pirates': 'hacker',
    'hackers': 'hacker',
    'projet': 'project',
    'projets': 'project',
    'centrale': 'plant',
    'centrales': 'plant',
    'parc': 'farm',
}


# ── Helpers ─────────────────────────────────────────────────────────────────────
def _strip(raw: str) -> str:
    """Strip HTML tags and normalise whitespace."""
    clean = re.sub(r'<[^>]+>', ' ', raw)
    clean = _html.unescape(clean)
    return re.sub(r'\s+', ' ', clean).strip()


def _ascii_fold(text: str) -> str:
    return unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('ascii')


def _canonical_story_tokens(text: str) -> set[str]:
    folded = _ascii_fold(text.lower())
    folded = re.sub(r'[^a-z0-9]+', ' ', folded)
    tokens = []
    for tok in folded.split():
        tok = _CANONICAL_REPLACEMENTS.get(tok, tok)
        if len(tok) < 4 or tok in _TOKEN_STOPWORDS:
            continue
        tokens.append(tok)
    return set(tokens)


def _topic_markers(text: str) -> set[str]:
    markers = set()
    t = _ascii_fold(text.lower())
    if 'cyber' in t:
        markers.add('cyber')
    if any(k in t for k in ('threat', 'menace', 'attaque', 'attack', 'hacker', 'ransomware', 'malware')):
        markers.add('security')
    if any(k in t for k in ('grid', 'reseau', 'network', 'scada', 'ot ', 'ics ')):
        markers.add('infrastructure')
    if any(k in t for k in ('solar', 'solaire', 'photovolta', ' pv ')):
        markers.add('solar')
    if any(k in t for k in ('battery', 'batterie', 'bess', 'storage', 'stockage')):
        markers.add('bess')
    if any(k in t for k in ('wind', 'eol', 'turbine', 'offshore', 'onshore')):
        markers.add('wind')
    return markers


def _same_domain(link_a: str, link_b: str) -> bool:
    try:
        return urlparse(link_a).netloc.replace('www.', '') == urlparse(link_b).netloc.replace('www.', '')
    except Exception:
        return False


def _publisher_key(source: str, link: str) -> str:
    source_key = re.sub(r'\b(fr|en)\b', ' ', source.lower())
    source_key = re.sub(r'google\s*[·\-].*', 'google', source_key).strip()
    source_key = re.sub(r'[^a-z0-9]+', ' ', source_key)
    source_key = re.sub(r'\s+', ' ', source_key).strip()
    if source_key and source_key != 'google':
        return source_key
    host = urlparse(link).netloc.lower().replace('www.', '')
    host = re.sub(r'\.(com|fr|net|org|eu|co\.uk)$', '', host)
    return host


def _same_publisher(item_a: dict, item_b: dict) -> bool:
    return _publisher_key(item_a.get('source', ''), item_a.get('link', '')) == _publisher_key(
        item_b.get('source', ''), item_b.get('link', '')
    )


def _similar(item_a: dict, item_b: dict) -> bool:
    """Return True if two items are about the same story.

    Two rules, either one triggers dedup:
    1. Jaccard word overlap ≥ 35% (lowered from 45% to catch paraphrased headlines).
    2. Shared proper noun (company name etc.) + shared specific number — catches
       cases like 'Heliup lève 16 millions' vs 'Heliup : 16 millions levés'.
    3. Cross-language/full-text similarity on canonicalized title + summary, with
       either strong overlap or shared topical markers from the same source domain.
    """
    a = item_a['title']
    b = item_b['title']

    # Rule 1 — Jaccard on 4+ char tokens
    wa = set(re.findall(r'\w{4,}', a.lower()))
    wb = set(re.findall(r'\w{4,}', b.lower()))
    if wa and wb and len(wa & wb) / len(wa | wb) >= 0.35:
        return True

    # Rule 2 — same named entity + same specific number
    _GENERIC = {'France', 'French', 'Europe', 'Solar', 'Solaire', 'Wind',
                'Éolien', 'BESS', 'Paris', 'Energy', 'Énergie', 'Renewable'}
    na = set(re.findall(r'\b[A-ZÀÂÉÈÊËÎÏÔÙÛÜ]\w{3,}', a)) - _GENERIC
    nb = set(re.findall(r'\b[A-ZÀÂÉÈÊËÎÏÔÙÛÜ]\w{3,}', b)) - _GENERIC
    _YEARS = {str(y) for y in range(2020, 2036)}
    nums_a = set(re.findall(r'\b\d+\b', a)) - _YEARS
    nums_b = set(re.findall(r'\b\d+\b', b)) - _YEARS
    if na & nb and nums_a & nums_b:
        return True

    story_a = _canonical_story_tokens(item_a['title'] + ' ' + item_a.get('summary_raw', ''))
    story_b = _canonical_story_tokens(item_b['title'] + ' ' + item_b.get('summary_raw', ''))
    if story_a and story_b:
        overlap = len(story_a & story_b) / len(story_a | story_b)
        if overlap >= 0.72:
            return True
        if overlap >= 0.55 and _same_domain(item_a.get('link', ''), item_b.get('link', '')):
            return True
        if overlap >= 0.45 and _same_publisher(item_a, item_b):
            return True

    markers_a = _topic_markers(item_a['title'] + ' ' + item_a.get('summary_raw', ''))
    markers_b = _topic_markers(item_b['title'] + ' ' + item_b.get('summary_raw', ''))
    shared_markers = len(markers_a & markers_b)
    return shared_markers >= 2 and (
        _same_domain(item_a.get('link', ''), item_b.get('link', '')) or _same_publisher(item_a, item_b)
    )


def _categorize(text: str) -> str:
    """Return 'bess', 'solar', 'wind', or None."""
    t = text.lower()
    if any(kw in t for kw in BESS_KW):
        return 'bess'
    if any(kw in t for kw in SOLAR_KW):
        return 'solar'
    if any(kw in t for kw in WIND_KW):
        return 'wind'
    return None


def _short_summary(entry) -> str:
    raw = entry.get('summary', '') or entry.get('description', '') or ''
    clean = _strip(raw)
    return (clean[:220] + ' …') if len(clean) > 220 else clean


def _entry_dt(entry):
    """Return a timezone-aware datetime for the entry, or None."""
    for field in ('published_parsed', 'updated_parsed'):
        t = entry.get(field)
        if t:
            try:
                return datetime.fromtimestamp(timegm(t), tz=timezone.utc)
            except Exception:
                pass
    return None


# ── Fetch ───────────────────────────────────────────────────────────────────────
def fetch_news(lookback_hours: int = 30) -> dict:
    cutoff       = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)
    articles     = {'solar': [], 'bess': [], 'wind': []}
    seen_items: list[dict] = []

    for source, url, france_native in ALL_FEEDS:
        try:
            feed = feedparser.parse(
                url,
                request_headers={'User-Agent': 'Mozilla/5.0 (compatible; DailyPulse/1.0)'}
            )
        except Exception as e:
            print(f"  [skip] {source}: {e}", file=sys.stderr)
            continue

        for entry in feed.entries:
            title = _strip(entry.get('title', '')).strip()
            if not title:
                continue

            # Date filter
            pub_dt = _entry_dt(entry)
            if pub_dt and pub_dt < cutoff:
                continue

            summary_raw = entry.get('summary', '') or entry.get('description', '') or ''
            combined    = title + ' ' + _strip(summary_raw)
            combined_l  = combined.lower()

             # Exclude obviously off-topic "solar" beauty/lifestyle stories.
            if any(kw in combined_l for kw in OFF_TOPIC_KW):
                continue

            # Energy topic filter
            if not any(kw in combined_l for kw in ALL_ENERGY_KW):
                continue

            # France geo-filter — skip non-French articles from global sources
            if not france_native and not any(kw in combined_l for kw in FRANCE_KW):
                continue

            cat = _categorize(combined)
            if cat is None:
                continue

            if cat == 'solar' and not any(kw in combined_l for kw in SOLAR_PV_STRICT_KW):
                continue

            item = {
                'title':       title,
                'summary_raw': _strip(summary_raw),
                'link':        entry.get('link', '#'),
                'source':      source,
                'cat':         cat,
            }

            if any(_similar(item, existing) for existing in seen_items):
                continue

            seen_items.append(item)
            articles[cat].append({
                'title':   title,
                'summary': _short_summary(entry),
                'link':    entry.get('link', '#'),
                'source':  source,
                'date':    pub_dt.strftime('%d %b %H:%M') if pub_dt else '',
                '_sort_dt': pub_dt or datetime.min.replace(tzinfo=timezone.utc),
            })

    # Sort each section by date (newest first), cap at 12 items per section
    for cat in articles:
        articles[cat] = sorted(
            articles[cat],
            key=lambda a: a.get('_sort_dt', datetime.min.replace(tzinfo=timezone.utc)),
            reverse=True,
        )[:12]
        for article in articles[cat]:
            article.pop('_sort_dt', None)

    return articles


# ── Email builder (Dolfines template) ───────────────────────────────────────────
_SECTION_COLORS = {
    'solar': ('#F5C518', '#FFFDF0', '☀️', 'Solar PV'),
    'bess':  ('#4a6fa5', '#EFF4FB', '🔋', 'Battery / BESS'),
    'wind':  ('#1a1a2e', '#F4F6F9', '💨', 'Wind'),
}


def _section_html(cat: str, items: list) -> str:
    if not items:
        return ''
    accent, bg, emoji, label = _SECTION_COLORS[cat]
    # Solar header text is dark (yellow bg); BESS and Wind use white text
    header_color = '#1a1a2e' if cat == 'solar' else '#ffffff'
    rows = ''
    for i, a in enumerate(items):
        date_badge = (
            f'<span style="font-size:10px; color:#9ca3af; margin-left:8px;">'
            f'{_html.escape(a["date"])}</span>'
            if a['date'] else ''
        )
        bottom_border = '' if i == len(items) - 1 else 'border-bottom:1px solid #e8ecf0;'
        rows += f'''
        <tr style="background:{bg};">
          <td style="padding:7px 24px; {bottom_border}">
            <p style="margin:0 0 2px 0; font-family:'Open Sans',Arial,sans-serif;
                      font-size:13.5px; font-weight:bold; line-height:1.3;">
              <a href="{_html.escape(a['link'], quote=True)}"
                 target="_blank" rel="noopener noreferrer"
                 style="color:#1a1a2e; text-decoration:none; font-weight:bold;
                        font-family:'Open Sans',Arial,sans-serif; font-size:13.5px;">
                {_html.escape(a['title'])}
              </a>{date_badge}
            </p>
            <p style="margin:0 0 3px 0; font-family:'Open Sans',Arial,sans-serif;
                      font-size:12px; color:#4b5563; line-height:1.1; text-align:justify;">
              {_html.escape(a['summary'])}
            </p>
            <p style="margin:0; font-family:'Open Sans',Arial,sans-serif;
                      font-size:11px; color:#9ca3af;">
              {_html.escape(a['source'])}&nbsp;&middot;&nbsp;<a
                href="{_html.escape(a['link'], quote=True)}"
                target="_blank" rel="noopener noreferrer"
                style="color:{accent}; font-weight:bold; text-decoration:none;
                       font-family:'Open Sans',Arial,sans-serif; font-size:11px;">
                Lire l&#8217;article &rarr;
              </a>
            </p>
          </td>
        </tr>'''

    count_label = f'{len(items)} article{"s" if len(items) != 1 else ""}'
    return f'''
      <tr>
        <td style="background:{accent}; padding:10px 24px;">
          <span style="font-size:13px; font-weight:bold; color:{header_color};
                       letter-spacing:0.4px;
                       font-family:'Open Sans',Arial,sans-serif;">
            {emoji}&nbsp; {label} &mdash; {count_label}
          </span>
        </td>
      </tr>
      {rows}'''


def _executive_summary(articles: dict) -> str:
    """Pick the 5 most notable headlines across categories for the executive summary."""
    cat_labels = {'solar': 'Solar PV', 'bess': 'Battery / BESS', 'wind': 'Wind'}
    # Pull top articles: up to 2 solar, 2 bess, 1 wind; fall back if fewer available
    picks = []
    for cat, limit in [('solar', 2), ('bess', 2), ('wind', 1)]:
        for a in articles[cat][:limit]:
            picks.append((cat, a))
    # If any section was empty, fill remaining slots from others
    for cat in ('solar', 'bess', 'wind'):
        for a in articles[cat]:
            if len(picks) >= 5:
                break
            if not any(p[1] is a for p in picks):
                picks.append((cat, a))
        if len(picks) >= 5:
            break

    accent_map = {'solar': '#B8860B', 'bess': '#4a6fa5', 'wind': '#1a1a2e'}
    rows = ''
    for cat, a in picks[:5]:
        accent = accent_map[cat]
        label  = cat_labels[cat]
        rows += f'''
        <tr>
          <td style="padding:4px 0; vertical-align:top;">
            <table cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="width:6px; min-width:6px; padding-top:4px; vertical-align:top;">
                <div style="width:6px; height:6px; border-radius:50%;
                            background:{accent};"></div>
              </td>
              <td style="padding-left:10px; font-family:'Open Sans',Arial,sans-serif;
                         font-size:13px; line-height:1.35; color:#1a1a2e;">
                <span style="font-size:10px; font-weight:bold; color:{accent};
                             text-transform:uppercase; letter-spacing:0.4px;">
                  {_html.escape(label)}&nbsp;
                </span>
                <a href="{_html.escape(a['link'], quote=True)}"
                   target="_blank" rel="noopener noreferrer"
                   style="color:#1a1a2e; text-decoration:none; font-weight:bold;">
                  {_html.escape(a['title'])}
                </a>
              </td>
            </tr></table>
          </td>
        </tr>'''
    return rows


def build_html(articles: dict, date_label: str) -> str:
    total = sum(len(v) for v in articles.values())
    body  = ''.join(_section_html(cat, articles[cat]) for cat in ('solar', 'bess', 'wind'))

    if not body.strip():
        body = '''
        <tr><td style="padding:32px; text-align:center; color:#9ca3af; font-size:13px;
                       font-family:'Open Sans',Arial,sans-serif;">
          Aucun article trouv&#233; pour aujourd&#8217;hui.<br>
          Il peut s&#8217;agir d&#8217;un week-end ou d&#8217;un jour f&#233;ri&#233;.
        </td></tr>'''

    banner_tag = (
        f'<a href="https://www.8p2.fr" target="_blank" rel="noopener noreferrer"'
        f' style="display:block; text-decoration:none; border:0; line-height:0; font-size:0;">'
        f'<img src="{_BANNER_SRC}" alt="Dolfines &#8212; Experts in Operational Excellence"'
        f' width="600" height="auto" border="0"'
        f' style="display:block; width:600px; height:auto; border:0; outline:none;"></a>'
        if _BANNER_SRC else
        '<div style="background:#1a1a2e; height:120px;"></div>'
    )

    exec_rows = _executive_summary(articles)

    logo_82_tag = (
        f'<a href="https://www.8p2.fr" target="_blank" rel="noopener noreferrer"'
        f' style="display:inline-block; text-decoration:none; border:0;">'
        f'<img src="{_LOGO_82}" alt="8.2 Advisory" height="28" border="0"'
        f' style="display:inline-block; height:28px; width:auto; border:0;'
        f' vertical-align:middle; text-decoration:none;"></a>'
        if _LOGO_82 else ''
    )
    logo_dolfines_tag = (
        f'<a href="https://www.dolfines.com" target="_blank" rel="noopener noreferrer"'
        f' style="display:inline-block; text-decoration:none; border:0;">'
        f'<img src="{_LOGO_DOLFINES}" alt="Dolfines" height="42" border="0"'
        f' style="display:inline-block; height:42px; width:auto; border:0;'
        f' vertical-align:middle; text-decoration:none;"></a>'
        if _LOGO_DOLFINES else ''
    )
    logo_82_white_tag = (
        f'<a href="https://www.8p2.fr" target="_blank" rel="noopener noreferrer"'
        f' style="display:inline-block; text-decoration:none; border:0;">'
        f'<img src="{_LOGO_82_WHITE}" alt="8.2 Advisory" width="222" border="0"'
        f' style="display:block; width:222px; max-width:100%; height:auto; border:0;"></a>'
        if _LOGO_82_WHITE else ''
    )

    return f'''<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>8.2 Daily Pulse | {_html.escape(date_label)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0; padding:0; background-color:#f4f6f9;
             font-family:'Open Sans',Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#f4f6f9; padding:32px 0;">
<tr><td align="center" valign="top">

  <table width="600" cellpadding="0" cellspacing="0" border="0"
         style="max-width:600px; width:100%; background:#ffffff;
                border-radius:6px; overflow:hidden;
                box-shadow:0 4px 20px rgba(0,0,0,0.10);">

    <!-- Logos bar — white background -->
    <tr>
      <td style="padding:14px 24px 8px 24px; background:#ffffff;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td valign="middle" style="text-align:left;">
              {logo_dolfines_tag}
            </td>
            <td valign="middle" style="text-align:right;">
              {logo_82_tag}
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Banner -->
    <tr>
      <td style="padding:0; margin:0; line-height:0;">
        {banner_tag}
      </td>
    </tr>

    <!-- Yellow accent bar -->
    <tr>
      <td style="background:#F5C518; height:4px; font-size:0; line-height:0;">&nbsp;</td>
    </tr>

    <!-- Digest header -->
    <tr>
      <td style="padding:28px 40px 0 40px;">
        <h1 style="margin:0 0 6px 0; font-family:'Open Sans',Arial,sans-serif;
                   font-size:22px; line-height:1.3; color:#1a1a2e; font-weight:bold;">
          8.2 Daily Pulse
        </h1>
        <p style="margin:0; font-family:'Open Sans',Arial,sans-serif;
                  font-size:12px; color:#4a6fa5; font-weight:bold;
                  letter-spacing:0.5px; text-transform:uppercase;">
          {_html.escape(date_label)} &nbsp;&middot;&nbsp;
          {total} article{"s" if total != 1 else ""}
          &nbsp;&middot;&nbsp; Solar PV &middot; BESS &middot; Wind
        </p>
      </td>
    </tr>

    <!-- Executive summary -->
    <tr>
      <td style="padding:20px 40px 0 40px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"
               style="background:#f4f6f9; border-radius:6px;
                      border-left:4px solid #F5C518;">
          <tr>
            <td style="padding:16px 20px;">
              <p style="margin:0 0 10px 0; font-family:'Open Sans',Arial,sans-serif;
                        font-size:11px; font-weight:bold; color:#4a6fa5;
                        letter-spacing:0.6px; text-transform:uppercase;">
                Executive Summary &nbsp;&mdash;&nbsp; Top stories today
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                {exec_rows}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Divider -->
    <tr>
      <td style="padding:20px 40px 0 40px;">
        <hr style="border:none; border-top:1px solid #e0e4ea; margin:0;">
      </td>
    </tr>

    <!-- Articles -->
    <tr>
      <td style="padding:0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          {body}
        </table>
      </td>
    </tr>

    <!-- Divider -->
    <tr>
      <td style="padding:0 40px;">
        <hr style="border:none; border-top:1px solid #e0e4ea; margin:0;">
      </td>
    </tr>

    <!-- CTA -->
    <tr>
      <td style="padding:32px 40px 0 40px; text-align:center;">
        <a href="https://www.8p2.fr"
           target="_blank" rel="noopener noreferrer"
           style="display:inline-block; background:#F5C518; color:#1a1a2e;
                  font-family:'Open Sans',Arial,sans-serif;
                  font-size:13px; font-weight:bold; text-decoration:none;
                  padding:12px 32px; border-radius:30px; letter-spacing:0.5px;">
          Discover Our Solutions &nbsp;&rarr;
        </a>
      </td>
    </tr>

    <!-- Contact strip -->
    <tr>
      <td style="padding:32px 40px 0 40px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="background:#1a1a2e; border-radius:6px; padding:20px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle">
                    <p style="margin:0 0 2px 0; font-family:'Open Sans',Arial,sans-serif;
                              font-size:14px; font-weight:bold; color:#F5C518;">
                      Richard Musi
                    </p>
                    <p style="margin:0 0 10px 0; font-family:'Open Sans',Arial,sans-serif;
                              font-size:12px; color:#93b4d0;">
                      Head of Renewables &nbsp;&middot;&nbsp; 8.2 Advisory
                    </p>
                    <p style="margin:0; font-family:'Open Sans',Arial,sans-serif;
                              font-size:12px; color:#aabccc; line-height:1.8;">
                      &#9993;&nbsp;
                      <a href="mailto:richard.musi@8p2.fr"
                         style="color:#aabccc; text-decoration:none;">
                        richard.musi@8p2.fr
                      </a><br>
                      &#127760;&nbsp;
                      <a href="https://www.8p2.fr"
                         style="color:#F5C518; text-decoration:none;">
                        www.8p2.fr
                      </a>
                    </p>
                  </td>
                  <td align="right" valign="middle" style="padding-left:16px; white-space:nowrap;">
                    {logo_82_white_tag}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="padding:24px 40px 32px 40px; text-align:center;">
        <p style="margin:0; font-family:'Open Sans',Arial,sans-serif;
                  font-size:10.5px; color:#9ca3af; line-height:1.7;">
          Digest automatique g&#233;n&#233;r&#233; le {_html.escape(date_label)}
          &nbsp;&middot;&nbsp;
          Sources&nbsp;: Google News, PV Magazine FR, R&#233;volution &#201;nerg&#233;tique,
          Enerzine, Actu-Environnement, Energy Storage News
        </p>
      </td>
    </tr>

  </table>

</td></tr>
</table>
</body>
</html>'''


# ── Send email ───────────────────────────────────────────────────────────────────
def send_email(html_body: str, date_label: str, recipient: str | None = None,
               cc_emails: list[str] | None = None) -> None:
    import smtplib
    import ssl
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    to_email = recipient or RECIPIENT
    cc_list = CC_EMAILS if cc_emails is None else cc_emails
    recipients = [to_email, *cc_list]
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"8.2 Daily Pulse | {date_label}"
    msg["From"] = SENDER_EMAIL
    msg["To"] = to_email
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    context = ssl.create_default_context()
    try:
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=60) as server:
            server.ehlo()
            server.starttls(context=context)
            server.ehlo()
            server.login(SENDER_EMAIL, SENDER_PASS)
            server.sendmail(SENDER_EMAIL, recipients, msg.as_string())
    except Exception as smtp_err:
        if sys.platform != "win32":
            raise RuntimeError(f"SMTP send failed: {smtp_err}") from smtp_err
        print(f"  SMTP send failed: {smtp_err}")
        print("  Falling back to Outlook COM ...")
        import time
        import win32com.client

        try:
            outlook = win32com.client.GetActiveObject("Outlook.Application")
        except Exception:
            outlook = win32com.client.Dispatch("Outlook.Application")
            time.sleep(3)

        mail = outlook.CreateItem(0)
        mail.Subject = f"8.2 Daily Pulse | {date_label}"
        mail.BodyFormat = 2
        mail.HTMLBody = html_body
        mail.To = to_email
        if cc_list:
            mail.CC = "; ".join(cc_list)
        mail.Send()

    cc_note = f"  CC: {', '.join(cc_list)}" if cc_list else ""
    print(f"  Email sent to {to_email}{cc_note}")


# ── Main ────────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='8.2 Daily Pulse')
    parser.add_argument('--preview', action='store_true',
                        help='Save HTML to disk and open in browser (no email sent)')
    parser.add_argument('--recipient', default=RECIPIENT,
                        help='Override recipient email address')
    parser.add_argument('--no-cc', action='store_true',
                        help='Send without CC recipients')
    args = parser.parse_args()

    _d = datetime.now()
    _suffix = 'th' if 11 <= _d.day <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(_d.day % 10, 'th')
    date_label = f"{_d.day}{_suffix} {_d.strftime('%B %Y')}"
    print(f"Fetching 8.2 Daily Pulse news for {date_label} ...")

    # On Mondays, extend lookback to cover Friday + Saturday + Sunday (72 h)
    lookback = 72 if datetime.now().weekday() == 0 else 30
    articles = fetch_news(lookback_hours=lookback)
    print(f"  Solar: {len(articles['solar'])}  |  BESS: {len(articles['bess'])}"
          f"  |  Wind: {len(articles['wind'])}")

    html_body = build_html(articles, date_label)

    preview_path = Path(__file__).parent / 'digest_preview.html'
    preview_path.write_text(html_body, encoding='utf-8')

    if args.preview or not SENDER_EMAIL:
        print(f"  Preview saved: {preview_path}")
        import http.server, socketserver, webbrowser
        _dir = str(preview_path.parent)
        class _H(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=_dir, **kwargs)
            def log_message(self, *a): pass
        with socketserver.TCPServer(('127.0.0.1', 0), _H) as srv:
            srv.timeout = 5
            port = srv.server_address[1]
            webbrowser.open(f'http://127.0.0.1:{port}/{preview_path.name}')
            for _ in range(3):  # serve HTML + any follow-up requests (favicon etc.)
                srv.handle_request()
    else:
        send_email(
            html_body,
            date_label,
            recipient=args.recipient,
            cc_emails=[] if args.no_cc else None,
        )
        print(f"  Preview also saved: {preview_path}")


if __name__ == '__main__':
    main()

