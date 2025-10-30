from __future__ import annotations

import calendar
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from math import ceil, floor
from statistics import fmean, median
from types import SimpleNamespace
from typing import Any, Dict, Iterable, List

from sqlalchemy import or_

from . import db
from .metrics import compute_weighted_sentiment
from .models import Game, SessionLog
from .statuses import INSIGHT_BUCKET_BY_STATUS


_BUCKET_DISPLAY_ORDER = ("backlog", "wishlist")
_INSIGHT_BUCKET_SET = set(INSIGHT_BUCKET_BY_STATUS.values())
_INSIGHT_BUCKETS = tuple(
    bucket for bucket in _BUCKET_DISPLAY_ORDER if bucket in _INSIGHT_BUCKET_SET
)
if len(_INSIGHT_BUCKETS) < len(_INSIGHT_BUCKET_SET):
    _INSIGHT_BUCKETS = _INSIGHT_BUCKETS + tuple(
        sorted(_INSIGHT_BUCKET_SET - set(_INSIGHT_BUCKETS))
    )


def _normalize_genres(genres: Iterable[str] | None) -> list[str]:
    if not genres:
        return []
    normalized = []
    for genre in genres:
        if not genre:
            continue
        label = str(genre).strip()
        if label:
            normalized.append(label)
    return normalized


def summarize_genre_preferences() -> Dict[str, Any]:
    """Aggregate genre preferences split by backlog and wishlist.

    The aggregation distributes each game's weight evenly across its genres so
    multi-genre titles do not dominate the totals. For every genre we return the
    raw counts, weight share, and weighted average ELO for backlog and wishlist
    lists separately along with a combined rollup.
    """

    def _metric_factory() -> dict[str, float]:
        return {"count": 0, "weight": 0.0, "elo_sum": 0.0}

    bucket_genre_totals: dict[str, dict[str, dict[str, float]]] = {
        bucket: defaultdict(_metric_factory) for bucket in _INSIGHT_BUCKETS
    }
    bucket_game_counts: dict[str, int] = {bucket: 0 for bucket in _INSIGHT_BUCKETS}

    games: Iterable[Game] = Game.query.all()
    for game in games:
        status = (game.status or "").lower()
        bucket = INSIGHT_BUCKET_BY_STATUS.get(status)
        if bucket not in bucket_genre_totals:
            continue

        bucket_game_counts[bucket] += 1
        genres = _normalize_genres(game.genres)
        if not genres:
            continue

        weight_per_genre = 1.0 / len(genres)
        for genre in genres:
            entry = bucket_genre_totals[bucket][genre]
            entry["count"] += 1
            entry["weight"] += weight_per_genre
            entry["elo_sum"] += weight_per_genre * float(game.elo_rating or 0.0)

    status_summaries: dict[str, dict[str, Any]] = {}
    for bucket, genre_totals in bucket_genre_totals.items():
        total_weight = sum(metric["weight"] for metric in genre_totals.values())
        total_count = sum(metric["count"] for metric in genre_totals.values())
        genres_summary = []
        for genre, metrics in genre_totals.items():
            weight = metrics["weight"]
            average_elo = metrics["elo_sum"] / weight if weight else None
            genres_summary.append(
                {
                    "genre": genre,
                    "count": metrics["count"],
                    "weight": weight,
                    "share": (weight / total_weight) if total_weight else 0.0,
                    "average_elo": average_elo,
                }
            )

        genres_summary.sort(key=lambda item: (item["weight"], item["count"]), reverse=True)
        status_summaries[bucket] = {
            "total_games": bucket_game_counts.get(bucket, 0),
            "total_weight": total_weight,
            "total_count": total_count,
            "genres": genres_summary,
        }

    combined_weight = sum(summary["total_weight"] for summary in status_summaries.values())
    combined_genres = []
    all_genres = set()
    for totals in bucket_genre_totals.values():
        all_genres.update(totals.keys())

    def _format_entry(
        bucket: str, genre: str, totals: dict[str, dict[str, float]]
    ) -> dict[str, Any]:
        metrics = totals.get(genre, {"count": 0, "weight": 0.0, "elo_sum": 0.0})
        weight = metrics["weight"]
        average_elo = metrics["elo_sum"] / weight if weight else None
        status_total_weight = status_summaries.get(bucket, {}).get("total_weight", 0.0)
        return {
            "count": metrics["count"],
            "weight": weight,
            "share": (weight / status_total_weight) if status_total_weight else 0.0,
            "average_elo": average_elo,
            "elo_sum": metrics["elo_sum"],
        }

    for genre in sorted(all_genres):
        backlog_entry = _format_entry(
            "backlog",
            genre,
            bucket_genre_totals.get("backlog", defaultdict(_metric_factory)),
        )
        wishlist_entry = _format_entry(
            "wishlist",
            genre,
            bucket_genre_totals.get("wishlist", defaultdict(_metric_factory)),
        )

        total_weight = backlog_entry["weight"] + wishlist_entry["weight"]
        total_count = backlog_entry["count"] + wishlist_entry["count"]
        total_elo_sum = backlog_entry["elo_sum"] + wishlist_entry["elo_sum"]
        total_average_elo = total_elo_sum / total_weight if total_weight else None
        combined_genres.append(
            {
                "genre": genre,
                "backlog": {
                    "count": backlog_entry["count"],
                    "weight": backlog_entry["weight"],
                    "share": backlog_entry["share"],
                    "average_elo": backlog_entry["average_elo"],
                },
                "wishlist": {
                    "count": wishlist_entry["count"],
                    "weight": wishlist_entry["weight"],
                    "share": wishlist_entry["share"],
                    "average_elo": wishlist_entry["average_elo"],
                },
                "total": {
                    "count": total_count,
                    "weight": total_weight,
                    "share": (total_weight / combined_weight) if combined_weight else 0.0,
                    "average_elo": total_average_elo,
                },
                "dominant": _determine_dominant_list(
                    backlog_entry["weight"], wishlist_entry["weight"]
                ),
            }
        )

    combined_genres.sort(
        key=lambda item: (item["total"]["weight"], item["total"]["count"]), reverse=True
    )

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "backlog": status_summaries["backlog"],
        "wishlist": status_summaries["wishlist"],
        "genres": combined_genres,
    }


def _determine_dominant_list(backlog_weight: float, wishlist_weight: float) -> str:
    delta = backlog_weight - wishlist_weight
    tolerance = 1e-6
    if abs(delta) <= tolerance:
        return "balanced"
    return "backlog" if delta > 0 else "wishlist"


def summarize_genre_sentiment() -> Dict[str, Any]:
    """Aggregate weighted sentiment scores per genre from play sessions."""

    query = (
        db.session.query(SessionLog, Game)
        .outerjoin(
            Game,
            or_(
                SessionLog.game_id == Game.id,
                SessionLog.game_title == Game.title,
            ),
        )
        .all()
    )

    genre_samples: dict[str, list[SimpleNamespace]] = defaultdict(list)
    genre_status_samples: dict[str, dict[str, list[SimpleNamespace]]] = defaultdict(
        lambda: defaultdict(list)
    )
    genre_playtime: dict[str, float] = defaultdict(float)
    genre_status_playtime: dict[str, dict[str, float]] = defaultdict(
        lambda: defaultdict(float)
    )
    genre_session_counts: dict[str, int] = defaultdict(int)

    for session, game in query:
        if not game:
            continue
        genres = _normalize_genres(getattr(game, "genres", None))
        if not genres:
            continue

        try:
            minutes = float(session.playtime_minutes or 0)
        except (TypeError, ValueError):
            minutes = 0.0
        if minutes <= 0:
            continue

        share = minutes / len(genres)
        sentiment = str(session.sentiment or "").lower()
        status = str(getattr(game, "status", "")).lower()
        bucket = INSIGHT_BUCKET_BY_STATUS.get(status)

        for genre in genres:
            genre_samples[genre].append(
                SimpleNamespace(sentiment=sentiment, playtime_minutes=share)
            )
            genre_playtime[genre] += share
            genre_session_counts[genre] += 1

            if bucket in _INSIGHT_BUCKETS:
                genre_status_samples[genre][bucket].append(
                    SimpleNamespace(sentiment=sentiment, playtime_minutes=share)
                )
                genre_status_playtime[genre][bucket] += share

    genres_summary = []
    for genre, samples in genre_samples.items():
        result = compute_weighted_sentiment(samples)
        status_summary: dict[str, Any] = {}
        for status, status_samples in genre_status_samples.get(genre, {}).items():
            status_result = compute_weighted_sentiment(status_samples)
            status_summary[status] = {
                "weighted_sentiment": status_result.weighted_score,
                "total_playtime_minutes": genre_status_playtime[genre][status],
                "session_count": len(status_samples),
            }

        genres_summary.append(
            {
                "genre": genre,
                "weighted_sentiment": result.weighted_score,
                "total_playtime_minutes": genre_playtime[genre],
                "session_count": genre_session_counts[genre],
                "statuses": status_summary,
            }
        )

    genres_summary.sort(
        key=lambda entry: entry["total_playtime_minutes"],
        reverse=True,
    )

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "genres": genres_summary,
    }


def build_genre_interest_sentiment() -> Dict[str, Any]:
    """Combine ELO interest with weighted sentiment enjoyment by genre."""

    preference_summary = summarize_genre_preferences()
    sentiment_summary = summarize_genre_sentiment()
    preference_lookup = {
        entry["genre"]: entry for entry in preference_summary.get("genres", [])
    }

    genres_payload = []
    for entry in sentiment_summary.get("genres", []):
        genre = entry["genre"]
        preference_entry = preference_lookup.get(genre, {})
        total_interest = preference_entry.get("total", {})
        average_elo = total_interest.get("average_elo")
        interest_score = (average_elo / 20.0) if average_elo is not None else None

        status_interest: dict[str, Any] = {}
        for bucket in _INSIGHT_BUCKETS:
            status_metrics = preference_entry.get(bucket, {})
            status_interest[bucket] = {
                "average_elo": status_metrics.get("average_elo"),
                "share": status_metrics.get("share"),
                "count": status_metrics.get("count"),
            }

        genres_payload.append(
            {
                "genre": genre,
                "interest": {
                    "average_elo": average_elo,
                    "interest_score": interest_score,
                    "statuses": status_interest,
                },
                "sentiment": entry,
            }
        )

    genres_payload.sort(
        key=lambda item: item["sentiment"].get("total_playtime_minutes", 0.0),
        reverse=True,
    )

    return {
        "generated_at": sentiment_summary.get("generated_at"),
        "genres": genres_payload,
    }


def _percentile(sorted_values: list[float], percentile: float) -> float | None:
    if not sorted_values:
        return None
    if percentile <= 0:
        return float(sorted_values[0])
    if percentile >= 1:
        return float(sorted_values[-1])

    index = (len(sorted_values) - 1) * percentile
    lower = floor(index)
    upper = ceil(index)
    lower_value = float(sorted_values[lower])
    upper_value = float(sorted_values[upper])
    if lower == upper:
        return lower_value
    fraction = index - lower
    return lower_value + (upper_value - lower_value) * fraction


def _describe_durations(values: list[int]) -> dict[str, Any]:
    if not values:
        return {
            "count": 0,
            "min": None,
            "max": None,
            "mean": None,
            "median": None,
            "percentiles": {"p10": None, "p25": None, "p75": None, "p90": None},
        }

    sorted_values = sorted(values)
    return {
        "count": len(sorted_values),
        "min": float(sorted_values[0]),
        "max": float(sorted_values[-1]),
        "mean": float(fmean(sorted_values)),
        "median": float(median(sorted_values)),
        "percentiles": {
            "p10": _percentile(sorted_values, 0.10),
            "p25": _percentile(sorted_values, 0.25),
            "p75": _percentile(sorted_values, 0.75),
            "p90": _percentile(sorted_values, 0.90),
        },
    }


def summarize_lifecycle_metrics(*, today: date | None = None, backlog_limit: int = 8) -> Dict[str, Any]:
    """Generate lifecycle timing metrics for backlog management decisions."""

    reference_date = today or date.today()
    purchase_to_start_samples: list[dict[str, Any]] = []
    start_to_finish_samples: list[dict[str, Any]] = []
    purchase_to_finish_samples: list[dict[str, Any]] = []
    backlog_waiting: list[dict[str, Any]] = []

    games: Iterable[Game] = Game.query.all()
    for game in games:
        purchase_date = getattr(game, "purchase_date", None)
        start_date = getattr(game, "start_date", None)
        finish_date = getattr(game, "finish_date", None)

        if purchase_date and start_date:
            delta = (start_date - purchase_date).days
            purchase_to_start_samples.append(
                {
                    "game_id": game.id,
                    "title": game.title,
                    "days": int(delta),
                    "purchase_date": purchase_date.isoformat(),
                    "start_date": start_date.isoformat(),
                }
            )

        if start_date and finish_date:
            delta = (finish_date - start_date).days
            start_to_finish_samples.append(
                {
                    "game_id": game.id,
                    "title": game.title,
                    "days": int(delta),
                    "start_date": start_date.isoformat(),
                    "finish_date": finish_date.isoformat(),
                }
            )

        if purchase_date and finish_date:
            delta = (finish_date - purchase_date).days
            purchase_to_finish_samples.append(
                {
                    "game_id": game.id,
                    "title": game.title,
                    "days": int(delta),
                    "purchase_date": purchase_date.isoformat(),
                    "finish_date": finish_date.isoformat(),
                }
            )

        status = (game.status or "").lower()
        if status == "backlog" and not start_date:
            anchor_date = purchase_date
            if not anchor_date and getattr(game, "created_at", None):
                anchor_date = game.created_at.date()

            if anchor_date:
                wait_days = max(0, (reference_date - anchor_date).days)
                backlog_waiting.append(
                    {
                        "game_id": game.id,
                        "title": game.title,
                        "days_waiting": int(wait_days),
                        "purchase_date": purchase_date.isoformat()
                        if purchase_date
                        else None,
                        "added_date": anchor_date.isoformat(),
                    }
                )

    def _summarize(samples: list[dict[str, Any]]) -> dict[str, Any]:
        durations = [sample["days"] for sample in samples]
        statistics = _describe_durations(durations)
        longest_examples = sorted(samples, key=lambda entry: entry["days"], reverse=True)[:5]
        return {
            "statistics": statistics,
            "longest_examples": longest_examples,
        }

    backlog_waiting.sort(key=lambda entry: entry["days_waiting"], reverse=True)

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "purchase_to_start": _summarize(purchase_to_start_samples),
        "start_to_finish": _summarize(start_to_finish_samples),
        "purchase_to_finish": _summarize(purchase_to_finish_samples),
        "aging_backlog": backlog_waiting[: max(0, int(backlog_limit))],
    }


@dataclass(frozen=True)
class _PeriodWindow:
    start: date
    end: date


def _resolve_period_window(session_date: date, period: str) -> _PeriodWindow:
    if period == "month":
        start = session_date.replace(day=1)
        last_day = calendar.monthrange(session_date.year, session_date.month)[1]
        end = session_date.replace(day=last_day)
        return _PeriodWindow(start=start, end=end)
    if period == "week":
        iso_year, iso_week, _ = session_date.isocalendar()
        start = date.fromisocalendar(iso_year, iso_week, 1)
        end = start + timedelta(days=6)
        return _PeriodWindow(start=start, end=end)
    raise ValueError(f"Unsupported period: {period}")


def _format_period_label(window: _PeriodWindow, period: str) -> str:
    if period == "month":
        return window.start.strftime("%b %Y")
    if period == "week":
        week_number = window.start.isocalendar()[1]
        return f"Week {week_number} · {window.start.strftime('%b %d')}"
    return window.start.isoformat()


def _collect_game_lookup(
    game_ids: Iterable[int | None],
    game_titles: Iterable[str | None],
) -> tuple[dict[int, Game], dict[str, Game]]:
    ids = {identifier for identifier in game_ids if identifier}
    titles = {str(title).strip() for title in game_titles if title}

    filters = []
    if ids:
        filters.append(Game.id.in_(ids))
    if titles:
        filters.append(Game.title.in_(titles))

    if not filters:
        return {}, {}

    if len(filters) == 1:
        games = Game.query.filter(filters[0]).all()
    else:
        games = Game.query.filter(or_(*filters)).all()

    by_id = {game.id: game for game in games if game.id is not None}
    by_title = {game.title.lower(): game for game in games if game.title}
    return by_id, by_title


def _resolve_game_for_session(
    session: SessionLog,
    *,
    games_by_id: dict[int, Game],
    games_by_title: dict[str, Game],
) -> Game | None:
    if session.game_id and session.game_id in games_by_id:
        return games_by_id[session.game_id]

    title = (session.game_title or "").strip().lower()
    if title and title in games_by_title:
        return games_by_title[title]

    return None


def summarize_engagement_trend(
    *,
    period: str = "month",
    start_date: date | None = None,
    end_date: date | None = None,
) -> Dict[str, Any]:
    period = (period or "month").lower()
    if period not in {"month", "week"}:
        raise ValueError("Period must be 'month' or 'week'")

    query = SessionLog.query
    if start_date:
        query = query.filter(SessionLog.session_date >= start_date)
    if end_date:
        query = query.filter(SessionLog.session_date <= end_date)

    sessions: List[SessionLog] = query.order_by(SessionLog.session_date.asc()).all()
    games_by_id, games_by_title = _collect_game_lookup(
        (session.game_id for session in sessions),
        (session.game_title for session in sessions),
    )

    timeline_map: dict[date, dict[str, Any]] = {}

    for session in sessions:
        session_day = getattr(session, "session_date", None)
        if not isinstance(session_day, date):
            continue

        try:
            minutes = float(getattr(session, "playtime_minutes", 0) or 0)
        except (TypeError, ValueError):
            minutes = 0.0
        if minutes <= 0:
            continue

        window = _resolve_period_window(session_day, period)
        entry = timeline_map.setdefault(
            window.start,
            {
                "window": window,
                "sessions": [],
                "total_minutes": 0.0,
                "titles": defaultdict(float),
                "title_meta": {},
                "genres": defaultdict(float),
                "titles_set": set(),
            },
        )

        entry["sessions"].append(session)
        entry["total_minutes"] += minutes

        resolved_game = _resolve_game_for_session(
            session, games_by_id=games_by_id, games_by_title=games_by_title
        )
        raw_title = (
            getattr(resolved_game, "title", None)
            or getattr(session, "game_title", None)
            or "Unknown Title"
        )
        display_title = str(raw_title).strip() or "Unknown Title"
        resolved_game_id = getattr(resolved_game, "id", None) or getattr(
            session, "game_id", None
        )
        title_key = (resolved_game_id, display_title.lower())
        entry["titles"][title_key] += minutes
        entry["titles_set"].add(title_key)
        entry["title_meta"].setdefault(
            title_key,
            {
                "title": display_title,
                "game_id": resolved_game_id,
            },
        )

        genres = _normalize_genres(getattr(resolved_game, "genres", None))
        if genres:
            share = minutes / len(genres)
            for genre in genres:
                entry["genres"][genre] += share

    timeline: List[Dict[str, Any]] = []
    for start_key in sorted(timeline_map.keys()):
        bucket = timeline_map[start_key]
        window = bucket["window"]
        total_minutes = bucket["total_minutes"]
        sessions_for_period = bucket["sessions"]
        sentiment_result = compute_weighted_sentiment(sessions_for_period)

        sorted_titles = sorted(
            (
                {
                    "minutes": minutes,
                    "share": (minutes / total_minutes) if total_minutes else 0.0,
                    "game_id": bucket["title_meta"][title_key]["game_id"],
                    "title": bucket["title_meta"][title_key]["title"],
                }
                for title_key, minutes in bucket["titles"].items()
            ),
            key=lambda entry: entry["minutes"],
            reverse=True,
        )

        top_titles: List[Dict[str, Any]] = []
        other_minutes = 0.0
        for index, record in enumerate(sorted_titles):
            if index < 3:
                top_titles.append(record)
            else:
                other_minutes += record["minutes"]
        if other_minutes > 0:
            top_titles.append(
                {
                    "title": "Other Titles",
                    "minutes": other_minutes,
                    "share": (other_minutes / total_minutes) if total_minutes else 0.0,
                    "game_id": None,
                }
            )

        sorted_genres = sorted(
            (
                {
                    "genre": genre,
                    "minutes": minutes,
                    "share": (minutes / total_minutes) if total_minutes else 0.0,
                }
                for genre, minutes in bucket["genres"].items()
            ),
            key=lambda entry: entry["minutes"],
            reverse=True,
        )[:5]

        timeline.append(
            {
                "period_start": window.start.isoformat(),
                "period_end": window.end.isoformat(),
                "label": _format_period_label(window, period),
                "total_minutes": total_minutes,
                "average_sentiment": sentiment_result.weighted_score,
                "sentiment_minutes": sentiment_result.weighted_minutes,
                "active_titles": len(bucket["titles_set"]),
                "top_titles": top_titles,
                "top_genres": sorted_genres,
            }
        )

    callouts: List[Dict[str, Any]] = []
    for index in range(1, len(timeline)):
        current = timeline[index]
        previous = timeline[index - 1]
        current_minutes = current["total_minutes"]
        previous_minutes = previous["total_minutes"]
        if current_minutes <= 0 and previous_minutes <= 0:
            continue

        change_minutes = current_minutes - previous_minutes
        percent_change = None
        if previous_minutes > 0:
            percent_change = change_minutes / previous_minutes

        if current_minutes >= previous_minutes * 1.5 and change_minutes >= 120:
            percent_label = (
                f"{percent_change:.0%}" if percent_change is not None else "significantly"
            )
            callouts.append(
                {
                    "type": "spike",
                    "period_start": current["period_start"],
                    "label": f"Playtime surged {percent_label} vs prior {period}",
                    "change_minutes": change_minutes,
                    "percent_change": percent_change,
                    "drivers": {
                        "titles": [
                            driver
                            for driver in current["top_titles"]
                            if driver["title"] != "Other Titles"
                        ],
                        "genres": current["top_genres"][:3],
                    },
                }
            )
            continue

        if (
            previous_minutes > 0
            and current_minutes <= previous_minutes * 0.6
            and change_minutes <= -120
        ):
            percent_label = (
                f"{abs(percent_change):.0%}" if percent_change is not None else "sharply"
            )
            callouts.append(
                {
                    "type": "dip",
                    "period_start": current["period_start"],
                    "label": f"Engagement dipped {percent_label} vs prior {period}",
                    "change_minutes": change_minutes,
                    "percent_change": percent_change,
                    "drivers": {
                        "titles": [
                            driver
                            for driver in previous["top_titles"]
                            if driver["title"] != "Other Titles"
                        ],
                        "genres": previous["top_genres"][:3],
                    },
                }
            )

    for period_entry in timeline:
        total_minutes = period_entry["total_minutes"]
        sentiment_score = period_entry["average_sentiment"] or 0.0
        if total_minutes >= 240 and sentiment_score <= 45:
            callouts.append(
                {
                    "type": "burnout",
                    "period_start": period_entry["period_start"],
                    "label": "High playtime but low sentiment—consider rotating titles.",
                    "change_minutes": None,
                    "percent_change": None,
                    "drivers": {
                        "titles": [
                            driver
                            for driver in period_entry["top_titles"]
                            if driver["title"] != "Other Titles"
                        ],
                        "genres": period_entry["top_genres"][:3],
                    },
                }
            )

    response: Dict[str, Any] = {
        "period": period,
        "timeline": timeline,
        "callouts": callouts,
    }

    if sessions:
        valid_dates = [
            session.session_date
            for session in sessions
            if isinstance(session.session_date, date)
        ]
        if valid_dates:
            response["range"] = {
                "start": min(valid_dates).isoformat(),
                "end": max(valid_dates).isoformat(),
            }

    if start_date:
        response.setdefault("range", {})["requested_start"] = start_date.isoformat()
    if end_date:
        response.setdefault("range", {})["requested_end"] = end_date.isoformat()

    return response
