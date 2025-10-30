from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime
from math import ceil, floor
from statistics import fmean, median
from types import SimpleNamespace
from typing import Any, Dict, Iterable

from sqlalchemy import or_

from . import db
from .metrics import compute_weighted_sentiment
from .models import Game, SessionLog


_SUPPORTED_STATUSES = ("backlog", "wishlist")


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

    status_genre_totals: dict[str, dict[str, dict[str, float]]] = {
        status: defaultdict(lambda: {"count": 0, "weight": 0.0, "elo_sum": 0.0})
        for status in _SUPPORTED_STATUSES
    }
    status_game_counts: dict[str, int] = {status: 0 for status in _SUPPORTED_STATUSES}

    games: Iterable[Game] = Game.query.all()
    for game in games:
        status = (game.status or "").lower()
        if status not in status_genre_totals:
            continue

        status_game_counts[status] += 1
        genres = _normalize_genres(game.genres)
        if not genres:
            continue

        weight_per_genre = 1.0 / len(genres)
        for genre in genres:
            entry = status_genre_totals[status][genre]
            entry["count"] += 1
            entry["weight"] += weight_per_genre
            entry["elo_sum"] += weight_per_genre * float(game.elo_rating or 0.0)

    status_summaries: dict[str, dict[str, Any]] = {}
    for status, genre_totals in status_genre_totals.items():
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
        status_summaries[status] = {
            "total_games": status_game_counts.get(status, 0),
            "total_weight": total_weight,
            "total_count": total_count,
            "genres": genres_summary,
        }

    combined_weight = sum(summary["total_weight"] for summary in status_summaries.values())
    combined_genres = []
    all_genres = set()
    for totals in status_genre_totals.values():
        all_genres.update(totals.keys())

    def _format_entry(
        status: str, genre: str, totals: dict[str, dict[str, float]]
    ) -> dict[str, Any]:
        metrics = totals.get(genre, {"count": 0, "weight": 0.0, "elo_sum": 0.0})
        weight = metrics["weight"]
        average_elo = metrics["elo_sum"] / weight if weight else None
        status_total_weight = status_summaries.get(status, {}).get("total_weight", 0.0)
        return {
            "count": metrics["count"],
            "weight": weight,
            "share": (weight / status_total_weight) if status_total_weight else 0.0,
            "average_elo": average_elo,
            "elo_sum": metrics["elo_sum"],
        }

    for genre in sorted(all_genres):
        backlog_entry = _format_entry("backlog", genre, status_genre_totals["backlog"])
        wishlist_entry = _format_entry("wishlist", genre, status_genre_totals["wishlist"])

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

        for genre in genres:
            genre_samples[genre].append(
                SimpleNamespace(sentiment=sentiment, playtime_minutes=share)
            )
            genre_playtime[genre] += share
            genre_session_counts[genre] += 1

            if status in _SUPPORTED_STATUSES:
                genre_status_samples[genre][status].append(
                    SimpleNamespace(sentiment=sentiment, playtime_minutes=share)
                )
                genre_status_playtime[genre][status] += share

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
        for status in _SUPPORTED_STATUSES:
            status_metrics = preference_entry.get(status, {})
            status_interest[status] = {
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
