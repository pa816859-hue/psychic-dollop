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
from .statuses import (
    INSIGHT_BUCKET_BY_STATUS,
    INSIGHT_BUCKET_DISPLAY_ORDER,
    INSIGHT_BUCKET_METADATA,
    OWNED_STATUSES,
)


_DEFAULT_BUCKET_DISPLAY_ORDER = tuple(INSIGHT_BUCKET_DISPLAY_ORDER)
if not _DEFAULT_BUCKET_DISPLAY_ORDER:
    _DEFAULT_BUCKET_DISPLAY_ORDER = tuple(INSIGHT_BUCKET_BY_STATUS.values())

_INSIGHT_BUCKET_SET = set(INSIGHT_BUCKET_BY_STATUS.values())
_INSIGHT_BUCKETS = tuple(
    bucket for bucket in _DEFAULT_BUCKET_DISPLAY_ORDER if bucket in _INSIGHT_BUCKET_SET
)
if len(_INSIGHT_BUCKETS) < len(_INSIGHT_BUCKET_SET):
    _INSIGHT_BUCKETS = _INSIGHT_BUCKETS + tuple(
        sorted(_INSIGHT_BUCKET_SET - set(_INSIGHT_BUCKETS))
    )


def _humanize_bucket(bucket: str) -> str:
    parts = bucket.replace("-", " ").replace("_", " ").split()
    if not parts:
        return bucket.title()
    return " ".join(part.capitalize() for part in parts)


def _resolve_bucket_metadata(bucket: str) -> dict[str, str]:
    metadata = INSIGHT_BUCKET_METADATA.get(bucket, {})
    label = metadata.get("label") or _humanize_bucket(bucket)
    description = metadata.get("description", "")
    color = metadata.get("color")
    payload: dict[str, str] = {"label": label, "description": description}
    if color:
        payload["color"] = color
    return payload


_BUCKET_METADATA = {
    bucket: _resolve_bucket_metadata(bucket) for bucket in _INSIGHT_BUCKETS
}


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
    """Aggregate genre preferences for every insights bucket.

    The aggregation distributes each game's weight evenly across its genres so
    multi-genre titles do not dominate the totals. For every genre we return the
    raw counts, weight share, and weighted average ELO for each status bucket as
    well as a combined roll-up across all tracked lists.
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
        bucket_entries: dict[str, dict[str, Any]] = {}
        total_weight = 0.0
        total_count = 0
        total_elo_sum = 0.0

        for bucket in _INSIGHT_BUCKETS:
            bucket_totals = bucket_genre_totals.get(bucket, defaultdict(_metric_factory))
            entry_metrics = _format_entry(bucket, genre, bucket_totals)
            bucket_entries[bucket] = entry_metrics
            total_weight += entry_metrics["weight"]
            total_count += entry_metrics["count"]
            total_elo_sum += entry_metrics["elo_sum"]

        total_average_elo = total_elo_sum / total_weight if total_weight else None

        dominant_bucket, dominant_share = _determine_dominant_bucket(
            {bucket: metrics["weight"] for bucket, metrics in bucket_entries.items()},
            total_weight,
        )

        combined_genres.append(
            {
                "genre": genre,
                "buckets": {
                    bucket: {
                        "count": metrics["count"],
                        "weight": metrics["weight"],
                        "share": metrics["share"],
                        "average_elo": metrics["average_elo"],
                    }
                    for bucket, metrics in bucket_entries.items()
                },
                "total": {
                    "count": total_count,
                    "weight": total_weight,
                    "share": (total_weight / combined_weight) if combined_weight else 0.0,
                    "average_elo": total_average_elo,
                },
                "dominant": dominant_bucket,
                "dominant_share": dominant_share,
            }
        )

    combined_genres.sort(
        key=lambda item: (item["total"]["weight"], item["total"]["count"]), reverse=True
    )

    bucket_metadata = {
        bucket: _BUCKET_METADATA.get(bucket, _resolve_bucket_metadata(bucket))
        for bucket in _INSIGHT_BUCKETS
    }

    for bucket, summary in status_summaries.items():
        metadata = bucket_metadata.get(bucket, {})
        summary["label"] = metadata.get("label", _humanize_bucket(bucket))
        summary["description"] = metadata.get("description", "")
        if metadata.get("color"):
            summary["color"] = metadata["color"]

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "bucket_order": list(_INSIGHT_BUCKETS),
        "bucket_metadata": bucket_metadata,
        "buckets": status_summaries,
        "genres": combined_genres,
    }


def _determine_dominant_bucket(
    bucket_weights: dict[str, float], total_weight: float
) -> tuple[str, float | None]:
    tolerance = 1e-6
    if total_weight <= tolerance:
        return "balanced", None

    sorted_weights = sorted(
        bucket_weights.items(), key=lambda item: item[1], reverse=True
    )
    top_bucket, top_weight = sorted_weights[0]
    if top_weight <= tolerance:
        return "balanced", None

    tied = [bucket for bucket, weight in sorted_weights if abs(weight - top_weight) <= tolerance]
    if len(tied) > 1:
        return "balanced", None

    share = top_weight / total_weight if total_weight else None
    return top_bucket, share


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
        "bucket_order": list(_INSIGHT_BUCKETS),
        "bucket_metadata": {
            bucket: _BUCKET_METADATA.get(bucket, _resolve_bucket_metadata(bucket))
            for bucket in _INSIGHT_BUCKETS
        },
    }


def build_genre_interest_sentiment() -> Dict[str, Any]:
    """Combine ELO interest with weighted sentiment enjoyment by genre."""

    preference_summary = summarize_genre_preferences()
    sentiment_summary = summarize_genre_sentiment()
    preference_lookup = {
        entry["genre"]: entry for entry in preference_summary.get("genres", [])
    }
    preference_buckets = preference_summary.get("bucket_metadata", {})

    genres_payload = []
    for entry in sentiment_summary.get("genres", []):
        genre = entry["genre"]
        preference_entry = preference_lookup.get(genre, {})
        total_interest = preference_entry.get("total", {})
        average_elo = total_interest.get("average_elo")
        interest_score = (average_elo / 20.0) if average_elo is not None else None

        status_interest: dict[str, Any] = {}
        bucket_entries = preference_entry.get("buckets", {})
        for bucket in _INSIGHT_BUCKETS:
            status_metrics = bucket_entries.get(bucket, {})
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
        "bucket_order": list(_INSIGHT_BUCKETS),
        "bucket_metadata": {
            bucket: preference_buckets.get(bucket, _BUCKET_METADATA.get(bucket, {}))
            for bucket in _INSIGHT_BUCKETS
        },
    }


def summarize_price_insights(
    *, today: date | None = None, top_limit: int = 5
) -> Dict[str, Any]:
    """Generate pricing-focused insights across backlog and wishlist games."""

    today = today or date.today()

    def _init_currency_record() -> dict[str, Any]:
        return {
            "owned_amount": 0.0,
            "owned_count": 0,
            "backlog_amount": 0.0,
            "backlog_count": 0,
            "wishlist_amount": 0.0,
            "wishlist_count": 0,
            "tracked_hours": 0.0,
            "tracked_titles": 0,
        }

    currency_totals: dict[str, dict[str, Any]] = defaultdict(_init_currency_record)
    backlog_candidates: list[dict[str, Any]] = []
    wishlist_candidates: list[dict[str, Any]] = []
    priced_games: list[dict[str, Any]] = []
    savings_totals: dict[str, dict[str, float]] = defaultdict(
        lambda: {
            "total_saved": 0.0,
            "discounted_count": 0,
            "percent_total": 0.0,
            "percent_count": 0,
        }
    )
    savings_entries: dict[str, list[dict[str, Any]]] = defaultdict(list)

    games: Iterable[Game] = Game.query.all()
    for game in games:
        status = (game.status or "").lower()

        list_amount: float | None = None
        list_currency: str | None = None
        if game.price_amount is not None:
            try:
                list_amount = float(game.price_amount)
            except (TypeError, ValueError):
                list_amount = None
            else:
                if list_amount < 0:
                    list_amount = None
                else:
                    list_currency = (game.price_currency or "MYR").upper()

        purchase_amount: float | None = None
        purchase_currency: str | None = None
        if game.purchase_price_amount is not None:
            try:
                purchase_amount = float(game.purchase_price_amount)
            except (TypeError, ValueError):
                purchase_amount = None
            else:
                if purchase_amount < 0:
                    purchase_amount = None
                else:
                    purchase_currency = (
                        game.purchase_price_currency or list_currency or "MYR"
                    )
                    if purchase_currency:
                        purchase_currency = purchase_currency.upper()

        effective_amount = (
            purchase_amount if purchase_amount is not None else list_amount
        )
        if effective_amount is None:
            continue

        currency = (purchase_currency or list_currency or "MYR").upper()
        if list_amount is not None and not list_currency:
            list_currency = currency
        if purchase_amount is not None and not purchase_currency:
            purchase_currency = currency

        record = currency_totals[currency]
        if status in OWNED_STATUSES:
            record["owned_amount"] += effective_amount
            record["owned_count"] += 1

        if status == "backlog":
            record["backlog_amount"] += effective_amount
            record["backlog_count"] += 1
            backlog_candidates.append(
                {
                    "id": game.id,
                    "title": game.title,
                    "price": {"amount": effective_amount, "currency": currency},
                    "purchase_date": game.purchase_date.isoformat()
                    if game.purchase_date
                    else None,
                    "days_owned": (today - game.purchase_date).days
                    if isinstance(game.purchase_date, date)
                    else None,
                    "elo_rating": float(game.elo_rating or 0.0),
                }
            )
        elif status == "wishlist":
            record["wishlist_amount"] += effective_amount
            record["wishlist_count"] += 1
            wishlist_candidates.append(
                {
                    "id": game.id,
                    "title": game.title,
                    "price": {"amount": effective_amount, "currency": currency},
                    "elo_rating": float(game.elo_rating or 0.0),
                    "created_at": game.created_at.isoformat()
                    if isinstance(game.created_at, datetime)
                    else None,
                }
            )

        if (
            purchase_amount is not None
            and list_amount is not None
            and list_currency == currency
            and purchase_currency == currency
            and list_amount > purchase_amount
        ):
            saved_amount = list_amount - purchase_amount
            savings_record = savings_totals[currency]
            savings_record["total_saved"] += saved_amount
            savings_record["discounted_count"] += 1
            percent = None
            if list_amount > 0:
                percent = (saved_amount / list_amount) * 100.0
                savings_record["percent_total"] += percent
                savings_record["percent_count"] += 1

            savings_entries[currency].append(
                {
                    "id": game.id,
                    "title": game.title,
                    "list_price": {"amount": list_amount, "currency": currency},
                    "purchase_price": {
                        "amount": purchase_amount,
                        "currency": currency,
                    },
                    "saved_amount": saved_amount,
                    "saved_percent": percent,
                    "purchase_date": game.purchase_date.isoformat()
                    if isinstance(game.purchase_date, date)
                    else None,
                }
            )

        priced_games.append(
            {
                "game": game,
                "currency": currency,
                "amount": effective_amount,
                "status": status,
                "list_price": (
                    {"amount": list_amount, "currency": list_currency}
                    if list_amount is not None and list_currency
                    else None
                ),
                "purchase_price": (
                    {"amount": purchase_amount, "currency": purchase_currency}
                    if purchase_amount is not None and purchase_currency
                    else None
                ),
            }
        )

    priced_game_ids = [
        entry["game"].id for entry in priced_games if entry.get("game") and entry["game"].id
    ]
    sessions_by_game: dict[int, list[SessionLog]] = defaultdict(list)
    if priced_game_ids:
        session_rows: Iterable[SessionLog] = SessionLog.query.filter(
            SessionLog.game_id.in_(priced_game_ids)
        ).all()
        for session in session_rows:
            if session.game_id:
                sessions_by_game[int(session.game_id)].append(session)

    value_map: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for entry in priced_games:
        game = entry["game"]
        currency = entry["currency"]
        amount = entry["amount"]
        status = entry["status"]
        list_price = entry.get("list_price")
        purchase_price = entry.get("purchase_price")
        sessions = sessions_by_game.get(game.id or -1, [])
        total_minutes = 0.0
        for session in sessions:
            try:
                minutes = float(session.playtime_minutes or 0)
            except (TypeError, ValueError):
                minutes = 0.0
            if minutes > 0:
                total_minutes += minutes

        total_hours = total_minutes / 60.0
        value_entry: dict[str, Any] = {
            "id": game.id,
            "title": game.title,
            "status": status,
            "price": {"amount": amount, "currency": currency},
            "total_hours": total_hours,
            "hours_per_currency": None,
            "cost_per_hour": None,
            "enjoyment_per_cost": None,
            "sentiment_score": None,
        }

        if purchase_price:
            value_entry["purchase_price"] = purchase_price
        if list_price:
            value_entry["list_price"] = list_price

        if total_hours > 0:
            hours_per_currency = (total_hours / amount) if amount > 0 else None
            cost_per_hour = (amount / total_hours) if total_hours > 0 else None
            value_entry["hours_per_currency"] = hours_per_currency
            value_entry["cost_per_hour"] = cost_per_hour

            sentiment_result = compute_weighted_sentiment(sessions)
            sentiment_score = sentiment_result.weighted_score
            value_entry["sentiment_score"] = sentiment_score

            if amount > 0:
                if sentiment_score is not None:
                    enjoyment_factor = max(min(sentiment_score / 100.0, 1.0), 0.0)
                    value_entry["enjoyment_per_cost"] = enjoyment_factor * hours_per_currency
                else:
                    value_entry["enjoyment_per_cost"] = hours_per_currency

            record = currency_totals[currency]
            record["tracked_hours"] += total_hours
            record["tracked_titles"] += 1

        value_map[currency].append(value_entry)

    for currency, record in currency_totals.items():
        owned_count = record.get("owned_count", 0) or 0
        backlog_count = record.get("backlog_count", 0) or 0
        wishlist_count = record.get("wishlist_count", 0) or 0

        record["average_owned_price"] = (
            record["owned_amount"] / owned_count if owned_count else None
        )
        record["average_backlog_price"] = (
            record["backlog_amount"] / backlog_count if backlog_count else None
        )
        record["average_wishlist_price"] = (
            record["wishlist_amount"] / wishlist_count if wishlist_count else None
        )
        tracked_titles = record.get("tracked_titles", 0) or 0
        record["average_tracked_hours"] = (
            record["tracked_hours"] / tracked_titles if tracked_titles else None
        )

    def _best_sort_key(entry: dict[str, Any]) -> tuple[float, float]:
        enjoyment = entry.get("enjoyment_per_cost")
        hours_per_currency = entry.get("hours_per_currency") or 0.0
        if enjoyment is None:
            enjoyment = hours_per_currency
        return (float(enjoyment), float(hours_per_currency))

    def _worst_sort_key(entry: dict[str, Any]) -> tuple[float, float]:
        cost_per_hour = entry.get("cost_per_hour")
        total_hours = entry.get("total_hours") or 0.0
        if cost_per_hour is None:
            return (-float("inf"), -float(total_hours))
        return (float(cost_per_hour), -float(total_hours))

    value_summary: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for currency, entries in value_map.items():
        best_candidates = [
            entry
            for entry in entries
            if entry.get("hours_per_currency")
            and (entry.get("total_hours") or 0) >= 1.0
        ]
        underutilized_candidates = [
            entry
            for entry in entries
            if entry.get("cost_per_hour") is not None
            and entry.get("status") in OWNED_STATUSES
        ]

        best_entries = sorted(
            best_candidates, key=_best_sort_key, reverse=True
        )[: max(0, int(top_limit))]
        underutilized_entries = sorted(
            underutilized_candidates, key=_worst_sort_key, reverse=True
        )[: max(0, int(top_limit))]

        value_summary[currency] = {
            "best": best_entries,
            "underutilized": underutilized_entries,
        }

    backlog_candidates.sort(
        key=lambda item: (item["price"]["amount"], item.get("days_owned") or -1),
        reverse=True,
    )
    wishlist_candidates.sort(
        key=lambda item: (item["price"]["amount"], item.get("elo_rating", 0.0)),
        reverse=True,
    )

    wishlist_interest = sorted(
        wishlist_candidates,
        key=lambda item: item.get("elo_rating", 0.0),
        reverse=True,
    )

    resolved_totals = {
        currency: {
            key: (round(value, 2) if isinstance(value, float) else value)
            for key, value in record.items()
        }
        for currency, record in currency_totals.items()
    }

    savings_summary: dict[str, dict[str, Any]] = {}
    for currency, totals in savings_totals.items():
        discounted_count = int(totals.get("discounted_count", 0) or 0)
        if discounted_count <= 0:
            continue

        total_saved = float(totals.get("total_saved", 0.0) or 0.0)
        percent_count = totals.get("percent_count", 0) or 0
        percent_total = float(totals.get("percent_total", 0.0) or 0.0)
        average_discount = (
            percent_total / percent_count if percent_count else None
        )

        entries = savings_entries.get(currency, [])
        entries.sort(
            key=lambda item: (
                float(item.get("saved_amount", 0.0) or 0.0),
                float(item.get("saved_percent") or 0.0),
            ),
            reverse=True,
        )
        limit = max(0, int(top_limit))
        formatted_entries: list[dict[str, Any]] = []
        for entry in entries[:limit]:
            formatted: dict[str, Any] = {
                "id": entry.get("id"),
                "title": entry.get("title"),
                "saved_amount": round(float(entry.get("saved_amount", 0.0)), 2),
                "saved_percent": (
                    round(float(entry.get("saved_percent")), 1)
                    if entry.get("saved_percent") is not None
                    else None
                ),
                "purchase_date": entry.get("purchase_date"),
            }
            list_price = entry.get("list_price")
            if isinstance(list_price, dict):
                formatted["list_price"] = {
                    "amount": round(float(list_price.get("amount", 0.0)), 2),
                    "currency": list_price.get("currency", currency),
                }
            purchase_price = entry.get("purchase_price")
            if isinstance(purchase_price, dict):
                formatted["purchase_price"] = {
                    "amount": round(float(purchase_price.get("amount", 0.0)), 2),
                    "currency": purchase_price.get("currency", currency),
                }
            formatted_entries.append(formatted)

        savings_summary[currency] = {
            "total_saved": round(total_saved, 2),
            "discounted_count": discounted_count,
            "average_discount_percent": (
                round(average_discount, 1) if average_discount is not None else None
            ),
            "top_deals": formatted_entries,
        }

    primary_currency = None
    if resolved_totals:
        primary_currency = max(
            resolved_totals.items(),
            key=lambda item: (
                item[1].get("owned_amount", 0.0),
                item[1].get("backlog_amount", 0.0),
                item[1].get("wishlist_amount", 0.0),
            ),
        )[0]

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "currency_totals": resolved_totals,
        "primary_currency": primary_currency,
        "backlog": {
            "most_expensive": backlog_candidates[: max(0, int(top_limit))],
            "total_priced": sum(
                record.get("backlog_count", 0) for record in resolved_totals.values()
            ),
        },
        "wishlist": {
            "most_expensive": wishlist_candidates[: max(0, int(top_limit))],
            "highest_interest": wishlist_interest[: max(0, int(top_limit))],
            "total_priced": sum(
                record.get("wishlist_count", 0) for record in resolved_totals.values()
            ),
        },
        "value_for_money": value_summary,
        "savings": savings_summary,
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
    if period == "day":
        return _PeriodWindow(start=session_date, end=session_date)
    raise ValueError(f"Unsupported period: {period}")


def _format_period_label(window: _PeriodWindow, period: str) -> str:
    if period == "month":
        return window.start.strftime("%b %Y")
    if period == "week":
        week_number = window.start.isocalendar()[1]
        return f"Week {week_number} · {window.start.strftime('%b %d')}"
    if period == "day":
        return window.start.strftime("%b %d")
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
    if period not in {"month", "week", "day"}:
        raise ValueError("Period must be 'month', 'week', or 'day'")

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
