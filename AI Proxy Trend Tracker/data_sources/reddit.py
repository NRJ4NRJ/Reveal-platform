from __future__ import annotations

from datetime import UTC, datetime
from calendar import timegm

import feedparser
import pandas as pd

from data_sources.base import BaseConnector, normalize_records, utc_now_iso

_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/123.0.0.0 Safari/537.36"
)


class RedditConnector(BaseConnector):
    name = "reddit"
    source_type = "reddit"

    def fetch(self) -> tuple[pd.DataFrame, dict]:
        records: list[dict] = []
        max_per_sub = min(int(self.settings.get("max_records_per_source", 60)), 25)
        subreddits = self.settings.get("reddit_subreddits", [])
        ai_keywords = tuple(self.settings.get("ai_keywords", []))
        errors: list[str] = []

        for subreddit in subreddits:
            rss_url = f"https://www.reddit.com/r/{subreddit}/hot.rss?limit={max_per_sub}"
            try:
                feed = feedparser.parse(rss_url, request_headers={"User-Agent": _BROWSER_UA})
                for entry in feed.entries[:max_per_sub]:
                    title = (entry.get("title") or "").strip()
                    if not title:
                        continue
                    link = entry.get("link") or ""
                    snippet = (entry.get("summary") or "")[:500]

                    # For general subreddits, require at least one AI keyword
                    if subreddit.lower() in {"entrepreneur", "saas"}:
                        haystack = f"{title} {snippet}".lower()
                        if ai_keywords and not any(t in haystack for t in ai_keywords):
                            continue

                    # Parse date
                    pub = entry.get("published_parsed") or entry.get("updated_parsed")
                    if pub:
                        try:
                            created = datetime.fromtimestamp(timegm(pub), tz=UTC)
                        except Exception:
                            created = datetime.now(tz=UTC)
                    else:
                        created = datetime.now(tz=UTC)

                    records.append({
                        "source": f"reddit:r/{subreddit}",
                        "source_type": self.source_type,
                        "topic": "",
                        "title": title,
                        "url": link,
                        "date": created.isoformat(),
                        "hits": 1,
                        "engagement": 0.0,
                        "raw_text_snippet": snippet,
                        "author": entry.get("author", ""),
                        "meta": {},
                    })
            except Exception as exc:
                errors.append(f"r/{subreddit}: {exc}")

        frame = normalize_records(records, self.name)
        detail = f"Fetched {len(frame)} posts from {len(subreddits)} subreddits via RSS."
        if errors:
            detail += f" {len(errors)} failed: {'; '.join(errors[:2])}"
        return frame, {
            "connector": self.name,
            "last_run": utc_now_iso(),
            "status": "ok" if frame is not None and not frame.empty else "warning",
            "record_count": len(frame),
            "detail": detail,
        }
