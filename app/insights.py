from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, Iterable

from .models import Game


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
