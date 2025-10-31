from __future__ import annotations

import csv
import io
import logging
import random
import threading
import time
from datetime import date, datetime, timedelta
from html import unescape
from itertools import combinations
from typing import Iterable, Tuple
import re

import requests
from flask import Blueprint, jsonify, render_template, request
from sqlalchemy import func, or_
from sqlalchemy.exc import SQLAlchemyError

from . import db
from .insights import (
    build_genre_interest_sentiment,
    summarize_engagement_trend,
    summarize_genre_preferences,
    summarize_lifecycle_metrics,
)
from .models import Comparison, Game, SessionLog
from .metrics import compute_weighted_sentiment
from .statuses import (
    DEFAULT_STATUS,
    OWNED_STATUSES,
    STATUS_VALUES,
    normalize_status_value,
    requires_purchase_date,
    validate_status,
)

bp = Blueprint("core", __name__)

logger = logging.getLogger(__name__)


class SteamMetadataError(Exception):
    """Raised when Steam metadata could not be retrieved."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


class RateLimiter:
    """Simple time-based rate limiter for external API calls."""

    def __init__(self, min_interval: float) -> None:
        self.min_interval = max(0.0, float(min_interval))
        self._lock = threading.Lock()
        self._last_call = 0.0

    def wait(self) -> None:
        if self.min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_call
            if elapsed < self.min_interval:
                time.sleep(self.min_interval - elapsed)
                now = time.monotonic()
            self._last_call = now


steam_rate_limiter = RateLimiter(0.35)


@bp.route("/")
def home():
    status_counts = {
        status: count
        for status, count in db.session.query(Game.status, func.count(Game.id)).group_by(Game.status)
    }

    owned_total = sum(status_counts.get(status, 0) for status in OWNED_STATUSES)
    backlog_total = status_counts.get("backlog", 0)
    playing_total = status_counts.get("playing", 0)
    occasional_total = status_counts.get("occasional", 0)
    finished_total = status_counts.get("story_clear", 0) + status_counts.get("full_clear", 0)
    wishlist_total = status_counts.get("wishlist", 0)
    dropped_total = status_counts.get("dropped", 0)

    total_sessions = SessionLog.query.count()

    library_summary = {
        "owned_total": owned_total,
        "backlog_total": backlog_total,
        "active_total": playing_total + occasional_total,
        "finished_total": finished_total,
        "wishlist_total": wishlist_total,
        "dropped_total": dropped_total,
        "total_sessions": total_sessions,
        "completion_percent": round((finished_total / owned_total) * 100) if owned_total else 0,
    }

    recent_window = date.today() - timedelta(days=14)
    recent_sessions = (
        SessionLog.query.order_by(SessionLog.session_date.desc(), SessionLog.created_at.desc())
        .limit(20)
        .all()
    )

    recent_minutes = 0
    active_days: set[date] = set()
    sentiment_counts = {"good": 0, "mediocre": 0, "bad": 0}

    for session in recent_sessions:
        if session.session_date and session.session_date >= recent_window:
            recent_minutes += session.playtime_minutes
            active_days.add(session.session_date)
            if session.sentiment in sentiment_counts:
                sentiment_counts[session.sentiment] += 1

    def format_minutes(minutes: int) -> str:
        hours, remainder = divmod(minutes, 60)
        if hours and remainder:
            return f"{hours}h {remainder}m"
        if hours:
            return f"{hours}h"
        return f"{remainder}m"

    last_session = recent_sessions[0] if recent_sessions else None

    missing_titles = {s.game_title for s in recent_sessions if not s.game_id}
    title_map = {}
    if missing_titles:
        title_map = {
            game.title: game
            for game in Game.query.filter(Game.title.in_(tuple(missing_titles))).all()
        }

    recent_games = []
    seen_keys: set[str | int] = set()
    for session in recent_sessions:
        key: str | int = session.game_id or session.game_title.lower()
        if key in seen_keys:
            continue
        seen_keys.add(key)
        game = session.game or title_map.get(session.game_title)
        recent_games.append(
            {
                "title": session.game_title,
                "session_date": session.session_date,
                "playtime_minutes": session.playtime_minutes,
                "sentiment": session.sentiment,
                "game": game,
            }
        )
        if len(recent_games) >= 6:
            break

    sentiment_display = {
        "good": "Upbeat",
        "mediocre": "Mixed",
        "bad": "Rough",
    }

    dominant_sentiment = None
    if any(sentiment_counts.values()):
        dominant_sentiment = max(sentiment_counts.items(), key=lambda item: item[1])[0]

    activity_summary = {
        "recent_minutes": recent_minutes,
        "recent_playtime_label": format_minutes(recent_minutes) if recent_minutes else "No playtime yet",
        "active_days": len(active_days),
        "sentiment_counts": sentiment_counts,
        "dominant_sentiment": sentiment_display.get(dominant_sentiment) if dominant_sentiment else None,
        "last_session": last_session,
        "last_session_game": (
            (last_session.game if last_session else None)
            or (title_map.get(last_session.game_title) if last_session else None)
        ),
    }

    return render_template(
        "home.html",
        page_id="home",
        library_summary=library_summary,
        recent_games=recent_games,
        activity_summary=activity_summary,
    )


@bp.route("/games/add")
def add_game_page():
    return render_template("add_game.html", page_id="add-game")


@bp.route("/library")
def library_page():
    return render_template("library.html", page_id="library")


@bp.route("/rankings")
def rankings_page():
    return render_template("rankings.html", page_id="rankings")


@bp.route("/sessions")
def sessions_page():
    return render_template("sessions.html", page_id="sessions")


@bp.route("/insights")
def insights_page():
    return render_template("insights.html", page_id="insights")


@bp.route("/games/<int:game_id>")
def game_detail_page(game_id: int):
    game = Game.query.get_or_404(game_id)
    sessions = (
        SessionLog.query.filter(
            (SessionLog.game_id == game.id) | (SessionLog.game_title == game.title)
        )
        .order_by(SessionLog.session_date.desc())
        .all()
    )

    weighted_result = compute_weighted_sentiment(sessions)
    weighted_score = weighted_result.weighted_score
    total_minutes = weighted_result.total_minutes
    score_color = _score_to_color(weighted_score)
    score_percent = (
        max(0.0, min(100.0, weighted_score)) if weighted_score is not None else 0.0
    )
    total_hours = total_minutes / 60 if total_minutes else 0.0

    return render_template(
        "game_detail.html",
        page_id="game-detail",
        game=game,
        sessions=sessions,
        weighted_score=weighted_score,
        score_color=score_color,
        score_percent=score_percent,
        total_minutes=total_minutes,
        total_hours=total_hours,
    )


@bp.route("/settings")
def settings_page():
    return render_template("settings.html", page_id="settings")


@bp.route("/api/settings/purge-data", methods=["POST"])
def purge_all_data():
    payload = request.get_json(silent=True) or {}
    confirmation_value = str(payload.get("confirm", "")).strip()

    if confirmation_value.lower() != "delete":
        return (
            jsonify({"error": "Type DELETE in the confirmation field to purge data."}),
            400,
        )

    try:
        comparisons_deleted = Comparison.query.delete(synchronize_session=False)
        sessions_deleted = SessionLog.query.delete(synchronize_session=False)
        games_deleted = Game.query.delete(synchronize_session=False)
        db.session.commit()
    except SQLAlchemyError as error:
        db.session.rollback()
        logger.exception("Failed to purge database", exc_info=error)
        return jsonify({"error": "Failed to purge database."}), 500

    total_deleted = (comparisons_deleted or 0) + (sessions_deleted or 0) + (
        games_deleted or 0
    )
    return jsonify(
        {
            "deleted": {
                "comparisons": comparisons_deleted or 0,
                "sessions": sessions_deleted or 0,
                "games": games_deleted or 0,
            },
            "total_deleted": total_deleted,
        }
    )


@bp.route("/api/insights/genres")
def insights_genre_summary():
    summary = summarize_genre_preferences()
    return jsonify(summary)


@bp.route("/api/insights/genre-sentiment")
def insights_genre_sentiment():
    summary = build_genre_interest_sentiment()
    return jsonify(summary)


@bp.route("/api/insights/lifecycle")
def insights_lifecycle_metrics():
    summary = summarize_lifecycle_metrics()
    return jsonify(summary)


@bp.route("/api/insights/engagement-trend")
def insights_engagement_trend():
    period = request.args.get("period", "month")
    start_param = request.args.get("start") or request.args.get("start_date")
    end_param = request.args.get("end") or request.args.get("end_date")

    def _parse_date(value: str | None, label: str) -> date | None:
        if not value:
            return None
        try:
            return date.fromisoformat(value)
        except ValueError as exc:  # pragma: no cover - user input validation
            raise ValueError(f"{label} must be a valid YYYY-MM-DD date") from exc

    try:
        start_date = _parse_date(start_param, "start")
        end_date = _parse_date(end_param, "end")
        summary = summarize_engagement_trend(
            period=period, start_date=start_date, end_date=end_date
        )
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    return jsonify(summary)


@bp.route("/import/backlog")
def backlog_import_page():
    return render_template("import_backlog.html", page_id="import-backlog")


@bp.route("/import/wishlist")
def wishlist_import_page():
    return render_template("import_wishlist.html", page_id="import-wishlist")


def _parse_date_field(
    value: str | None,
    label: str,
    required: bool = False,
    required_message: str | None = None,
) -> date | None:
    value = (value or "").strip()
    if not value:
        if required:
            message = required_message or f"{label} is required."
            raise ValueError(message)
        return None

    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(
            f"{label} must be a valid date in YYYY-MM-DD format."
        ) from exc


def _validate_status(status: str | None) -> str:
    return validate_status(status)


def normalize_existing_game_statuses() -> int:
    """Normalize stored game statuses to supported values.

    Returns the number of rows that were updated during normalization.
    """

    allowed = set(STATUS_VALUES)
    updated = 0
    for game in Game.query.all():
        normalized = normalize_status_value(game.status)
        if normalized not in allowed:
            normalized = DEFAULT_STATUS
        if game.status != normalized:
            game.status = normalized
            updated += 1

    if updated:
        db.session.commit()

    return updated


def _clean_description(value: str | None) -> str | None:
    if not value:
        return None
    text = unescape(value)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip() or None


def _search_steam_app_id(title: str) -> str | None:
    query = (title or "").strip()
    if not query:
        return None

    url = "https://store.steampowered.com/api/storesearch/"
    params = {"term": query, "cc": "us", "l": "en"}

    try:
        steam_rate_limiter.wait()
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise SteamMetadataError(f"Steam search failed: {exc}", 502) from exc

    try:
        payload = response.json()
    except ValueError as exc:
        raise SteamMetadataError("Invalid response from Steam search.", 502) from exc

    items = payload.get("items") or []
    if not isinstance(items, list):
        return None

    normalized = query.lower()
    fallback: str | None = None
    for item in items:
        if not isinstance(item, dict):
            continue
        app_id = item.get("id")
        name = (item.get("name") or "").strip()
        if not app_id:
            continue
        app_id_str = str(app_id)
        if name.lower() == normalized:
            return app_id_str
        if fallback is None:
            fallback = app_id_str
    return fallback


def _fetch_steam_metadata(app_id: str) -> dict:
    app_id = (app_id or "").strip()
    if not app_id:
        return {"genres": [], "icon_url": None, "title": None, "short_description": None}

    url = "https://store.steampowered.com/api/appdetails"
    try:
        steam_rate_limiter.wait()
        response = requests.get(url, params={"appids": app_id}, timeout=10)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise SteamMetadataError(f"Steam API request failed: {exc}", 502) from exc

    try:
        payload = response.json()
    except ValueError as exc:
        raise SteamMetadataError("Invalid response from Steam API.", 502) from exc

    entry = payload.get(str(app_id))
    if not entry or not entry.get("success"):
        raise SteamMetadataError("Steam did not return details for that App ID.")

    data = entry.get("data") or {}

    genres: list[str] = []
    for genre in data.get("genres") or []:
        if not isinstance(genre, dict):
            continue
        description = (genre.get("description") or "").strip()
        if description:
            genres.append(description)

    icon_url = (
        data.get("header_image")
        or data.get("capsule_image")
        or data.get("capsule_imagev5")
    )
    if not icon_url:
        icon_hash = (data.get("img_icon_url") or "").strip()
        if icon_hash:
            icon_url = (
                "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/"
                f"{app_id}/{icon_hash}.jpg"
            )

    title = (data.get("name") or "").strip() or None
    short_description = _clean_description(
        data.get("short_description") or data.get("about_the_game")
    )

    return {
        "genres": genres,
        "icon_url": icon_url,
        "title": title,
        "short_description": short_description,
    }


def _apply_steam_metadata(
    game: Game, app_id: str | None, metadata: dict | None = None
) -> None:
    if not app_id:
        game.genres = []
        game.icon_url = None
        game.short_description = None
        return

    if metadata is None:
        metadata = _fetch_steam_metadata(app_id)

    game.genres = metadata.get("genres", [])
    game.icon_url = metadata.get("icon_url")
    game.short_description = metadata.get("short_description")
    if not game.title:
        fetched_title = metadata.get("title")
        if fetched_title:
            game.title = fetched_title


@bp.route("/api/games", methods=["GET", "POST"])
def games_collection():
    if request.method == "POST":
        payload = request.get_json(force=True)
        title = (payload.get("title") or "").strip()
        status = normalize_status_value(payload.get("status"))
        steam_app_id = (payload.get("steam_app_id") or "").strip() or None
        modes = payload.get("modes") or []
        thoughts = (payload.get("thoughts") or "").strip() or None

        metadata = None
        if steam_app_id:
            try:
                metadata = _fetch_steam_metadata(steam_app_id)
            except SteamMetadataError as exc:
                return jsonify({"error": str(exc)}), exc.status_code
            if not title:
                title = metadata.get("title") or ""

        if not title:
            return jsonify({"error": "Title is required."}), 400

        try:
            _validate_status(status)
        except ValueError as exc:  # pragma: no cover - defensive
            return jsonify({"error": str(exc)}), 400

        try:
            purchase_date = _parse_date_field(
                payload.get("purchase_date"),
                "Purchase date",
                required=requires_purchase_date(status),
                required_message="Purchase date is required once you've purchased the game.",
            )
            start_date = _parse_date_field(payload.get("start_date"), "Start date")
            finish_date = _parse_date_field(payload.get("finish_date"), "Finish date")
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        if Game.query.filter_by(title=title).first():
            return jsonify({"error": "Game with this title already exists."}), 400

        game = Game(title=title, status=status, steam_app_id=steam_app_id)
        game.modes = [m.strip() for m in modes if m.strip()]
        game.purchase_date = purchase_date
        game.start_date = start_date
        game.finish_date = finish_date
        game.thoughts = thoughts

        if steam_app_id:
            _apply_steam_metadata(game, steam_app_id, metadata)
        else:
            game.genres = []
            game.icon_url = None
            game.short_description = None

        db.session.add(game)
        db.session.commit()

        return jsonify(game.to_dict()), 201

    games = Game.query.order_by(Game.elo_rating.desc(), Game.title.asc()).all()
    return jsonify([game.to_dict() for game in games])


def _parse_csv_date(value: str | None, label: str) -> date | None:
    value = (value or "").strip()
    if not value:
        return None

    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Could not parse {label}: '{value}'.")


def _parse_modes_field(value: str | None) -> list[str]:
    text = (value or "").strip()
    if not text:
        return []
    for delimiter in ("/", "&", "|"):
        text = text.replace(delimiter, ",")
    parts = [segment.strip() for segment in text.split(",")]
    return [segment for segment in parts if segment]


def _normalize_steam_app_id_value(value: str | int | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    match = re.search(r"\d+", text)
    if not match:
        return None
    return match.group(0)


def _extract_steam_app_id_from_row(row: dict) -> tuple[str | None, str | None]:
    candidate_keys = (
        "Steam App ID",
        "steam_app_id",
        "AppID",
        "App Id",
        "App ID",
    )
    for key in candidate_keys:
        app_id = _normalize_steam_app_id_value(row.get(key))
        if app_id:
            return app_id, key
    return None, None


@bp.route("/api/import/backlog", methods=["POST"])
def import_backlog_from_csv():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "Upload a CSV file."}), 400

    try:
        raw_text = upload.read().decode("utf-8-sig")
    except UnicodeDecodeError:
        upload.stream.seek(0)
        try:
            raw_text = upload.read().decode("latin-1")
        except UnicodeDecodeError as exc:
            return jsonify({"error": "Could not decode CSV file."}), 400

    reader = csv.DictReader(io.StringIO(raw_text))
    if not reader.fieldnames:
        return jsonify({"error": "CSV file has no header."}), 400

    created_games: list[Game] = []
    skipped: list[dict] = []
    events: list[dict] = []

    logger.info(
        "Backlog CSV import started with columns: %s", ", ".join(reader.fieldnames)
    )

    for row_index, row in enumerate(reader, start=2):
        title = (row.get("Title") or row.get("title") or "").strip()
        if not title:
            reason = "Missing title."
            event = {"row": row_index, "title": None, "status": "skipped", "reason": reason}
            events.append(event)
            skipped.append({"row": row_index, "title": None, "reason": reason})
            logger.warning("Backlog row %s skipped: %s", row_index, reason)
            continue

        if Game.query.filter_by(title=title).first():
            reason = "Already in library."
            event = {"row": row_index, "title": title, "status": "skipped", "reason": reason}
            events.append(event)
            skipped.append({"row": row_index, "title": title, "reason": reason})
            logger.info("Backlog row %s skipped (duplicate): %s", row_index, title)
            continue

        try:
            purchase_date = _parse_csv_date(row.get("Date_Acquired") or row.get("Date Acquired"), "purchase date")
            start_date = _parse_csv_date(row.get("Date_Started") or row.get("Date Started"), "start date")
            finish_date = _parse_csv_date(row.get("Date_Completed") or row.get("Date Completed"), "completion date")
        except ValueError as exc:
            reason = str(exc)
            events.append({
                "row": row_index,
                "title": title,
                "status": "skipped",
                "reason": reason,
            })
            skipped.append({"row": row_index, "title": title, "reason": reason})
            logger.warning("Backlog row %s skipped (date error): %s", row_index, reason)
            continue

        steam_app_id, app_id_key = _extract_steam_app_id_from_row(row)
        app_id_source = f"csv:{app_id_key}" if app_id_key else "search"

        if not steam_app_id:
            try:
                steam_app_id = _search_steam_app_id(title)
            except SteamMetadataError as exc:
                reason = str(exc)
                events.append({
                    "row": row_index,
                    "title": title,
                    "status": "skipped",
                    "reason": reason,
                })
                skipped.append({"row": row_index, "title": title, "reason": reason})
                logger.error(
                    "Backlog row %s skipped (search error): %s", row_index, reason
                )
                continue

        if not steam_app_id:
            reason = "Steam app not found."
            events.append({
                "row": row_index,
                "title": title,
                "status": "skipped",
                "reason": reason,
            })
            skipped.append({"row": row_index, "title": title, "reason": reason})
            logger.warning("Backlog row %s skipped: %s", row_index, reason)
            continue

        try:
            metadata = _fetch_steam_metadata(steam_app_id)
        except SteamMetadataError as exc:
            reason = str(exc)
            events.append({
                "row": row_index,
                "title": title,
                "status": "skipped",
                "reason": reason,
            })
            skipped.append({"row": row_index, "title": title, "reason": reason})
            logger.error(
                "Backlog row %s skipped (metadata error): %s", row_index, reason
            )
            continue

        game = Game(
            title=title,
            status="backlog",
            steam_app_id=steam_app_id,
            purchase_date=purchase_date,
            start_date=start_date,
            finish_date=finish_date,
        )

        modes_value = row.get("Num. of Players") or row.get("Num of Players") or row.get("Players")
        game.modes = _parse_modes_field(modes_value)

        _apply_steam_metadata(game, steam_app_id, metadata)

        db.session.add(game)
        created_games.append(game)
        events.append(
            {
                "row": row_index,
                "title": title,
                "status": "imported",
                "steam_app_id": steam_app_id,
                "source": app_id_source,
            }
        )
        logger.info(
            "Backlog row %s imported: %s (app_id=%s via %s)",
            row_index,
            title,
            steam_app_id,
            app_id_source,
        )

    if created_games:
        try:
            db.session.commit()
        except SQLAlchemyError:  # pragma: no cover - safeguard
            db.session.rollback()
            return jsonify({"error": "Failed to save imported games."}), 500
    else:
        db.session.rollback()

    imported = [game.to_dict() for game in created_games]

    logger.info(
        "Backlog CSV import finished: %s imported, %s skipped",
        len(imported),
        len(skipped),
    )

    return jsonify(
        {
            "status": "completed",
            "imported_count": len(imported),
            "skipped_count": len(skipped),
            "imported": imported,
            "skipped": skipped,
            "events": events,
        }
    )


@bp.route("/api/import/wishlist", methods=["POST"])
def import_wishlist_from_csv():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "Upload a CSV file."}), 400

    try:
        raw_text = upload.read().decode("utf-8-sig")
    except UnicodeDecodeError:
        upload.stream.seek(0)
        try:
            raw_text = upload.read().decode("latin-1")
        except UnicodeDecodeError:
            return jsonify({"error": "Could not decode CSV file."}), 400

    reader = csv.DictReader(io.StringIO(raw_text))
    if not reader.fieldnames:
        return jsonify({"error": "CSV file has no header."}), 400

    created_games: list[Game] = []
    skipped: list[dict] = []
    events: list[dict] = []

    logger.info(
        "Wishlist CSV import started with columns: %s", ", ".join(reader.fieldnames)
    )

    for row_index, row in enumerate(reader, start=2):
        title = (row.get("Title") or row.get("title") or "").strip()
        if not title:
            reason = "Missing title."
            events.append({
                "row": row_index,
                "title": None,
                "status": "skipped",
                "reason": reason,
            })
            skipped.append({"row": row_index, "title": None, "reason": reason})
            logger.warning("Wishlist row %s skipped: %s", row_index, reason)
            continue

        if Game.query.filter_by(title=title).first():
            reason = "Already in library."
            events.append({
                "row": row_index,
                "title": title,
                "status": "skipped",
                "reason": reason,
            })
            skipped.append({"row": row_index, "title": title, "reason": reason})
            logger.info("Wishlist row %s skipped (duplicate): %s", row_index, title)
            continue

        steam_app_id, app_id_key = _extract_steam_app_id_from_row(row)
        app_id_source = f"csv:{app_id_key}" if app_id_key else "search"

        if not steam_app_id:
            try:
                steam_app_id = _search_steam_app_id(title)
            except SteamMetadataError as exc:
                reason = str(exc)
                events.append({
                    "row": row_index,
                    "title": title,
                    "status": "skipped",
                    "reason": reason,
                })
                skipped.append({"row": row_index, "title": title, "reason": reason})
                logger.error(
                    "Wishlist row %s skipped (search error): %s", row_index, reason
                )
                continue

        if not steam_app_id:
            reason = "Steam app not found."
            events.append({
                "row": row_index,
                "title": title,
                "status": "skipped",
                "reason": reason,
            })
            skipped.append({"row": row_index, "title": title, "reason": reason})
            logger.warning("Wishlist row %s skipped: %s", row_index, reason)
            continue

        try:
            metadata = _fetch_steam_metadata(steam_app_id)
        except SteamMetadataError as exc:
            reason = str(exc)
            events.append({
                "row": row_index,
                "title": title,
                "status": "skipped",
                "reason": reason,
            })
            skipped.append({"row": row_index, "title": title, "reason": reason})
            logger.error(
                "Wishlist row %s skipped (metadata error): %s", row_index, reason
            )
            continue

        game = Game(title=title, status="wishlist", steam_app_id=steam_app_id)

        modes_value = (
            row.get("Num. of Players")
            or row.get("Num of Players")
            or row.get("Players")
        )
        game.modes = _parse_modes_field(modes_value)

        thoughts_value = (row.get("Thoughts") or row.get("thoughts") or "").strip()
        if thoughts_value:
            game.thoughts = thoughts_value

        _apply_steam_metadata(game, steam_app_id, metadata)

        db.session.add(game)
        created_games.append(game)
        events.append(
            {
                "row": row_index,
                "title": title,
                "status": "imported",
                "steam_app_id": steam_app_id,
                "source": app_id_source,
            }
        )
        logger.info(
            "Wishlist row %s imported: %s (app_id=%s via %s)",
            row_index,
            title,
            steam_app_id,
            app_id_source,
        )

    if created_games:
        try:
            db.session.commit()
        except SQLAlchemyError:  # pragma: no cover - safeguard
            db.session.rollback()
            return jsonify({"error": "Failed to save imported games."}), 500
    else:
        db.session.rollback()

    imported = [game.to_dict() for game in created_games]

    logger.info(
        "Wishlist CSV import finished: %s imported, %s skipped",
        len(imported),
        len(skipped),
    )

    return jsonify(
        {
            "status": "completed",
            "imported_count": len(imported),
            "skipped_count": len(skipped),
            "imported": imported,
            "skipped": skipped,
            "events": events,
        }
    )


@bp.route("/api/games/<int:game_id>", methods=["PUT", "DELETE"])
def games_resource(game_id: int):
    game = Game.query.get_or_404(game_id)

    if request.method == "DELETE":
        SessionLog.query.filter_by(game_id=game.id).update({SessionLog.game_id: None})
        Comparison.query.filter(
            (Comparison.game_a_id == game.id) | (Comparison.game_b_id == game.id)
        ).delete(synchronize_session=False)
        db.session.delete(game)
        db.session.commit()
        return jsonify({"message": "Game deleted."})

    payload = request.get_json(force=True)
    title = (payload.get("title") or game.title).strip()
    status = normalize_status_value(payload.get("status") or game.status)
    if "steam_app_id" in payload:
        steam_app_id = (payload.get("steam_app_id") or "").strip() or None
    else:
        steam_app_id = game.steam_app_id
    modes = payload.get("modes") or game.modes
    if "thoughts" in payload:
        thoughts = (payload.get("thoughts") or "").strip() or None
    else:
        thoughts = game.thoughts

    if not title:
        return jsonify({"error": "Title is required."}), 400

    try:
        _validate_status(status)
    except ValueError as exc:  # pragma: no cover - defensive
        return jsonify({"error": str(exc)}), 400

    try:
        if "purchase_date" in payload:
            purchase_date = _parse_date_field(
                payload.get("purchase_date"),
                "Purchase date",
                required=requires_purchase_date(status),
                required_message="Purchase date is required once you've purchased the game.",
            )
        else:
            purchase_date = game.purchase_date
            if requires_purchase_date(status) and purchase_date is None:
                raise ValueError(
                    "Purchase date is required once you've purchased the game."
                )

        if "start_date" in payload:
            start_date = _parse_date_field(payload.get("start_date"), "Start date")
        else:
            start_date = game.start_date

        if "finish_date" in payload:
            finish_date = _parse_date_field(payload.get("finish_date"), "Finish date")
        else:
            finish_date = game.finish_date
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if title != game.title and Game.query.filter_by(title=title).first():
        return jsonify({"error": "Another game with this title already exists."}), 400

    previous_app_id = game.steam_app_id

    game.title = title
    game.status = status
    game.steam_app_id = steam_app_id
    game.modes = [m.strip() for m in modes if isinstance(m, str) and m.strip()]
    game.purchase_date = purchase_date
    game.start_date = start_date
    game.finish_date = finish_date
    game.thoughts = thoughts

    if steam_app_id:
        should_refresh = (
            steam_app_id != previous_app_id
            or not game.genres
            or not game.icon_url
            or not game.short_description
        )
        if should_refresh:
            try:
                _apply_steam_metadata(game, steam_app_id)
            except SteamMetadataError as exc:
                return jsonify({"error": str(exc)}), exc.status_code
    else:
        game.genres = []
        game.icon_url = None
        game.short_description = None

    db.session.commit()

    return jsonify(game.to_dict())


def _interpolate_color(color_a: tuple[int, int, int], color_b: tuple[int, int, int], factor: float) -> tuple[int, int, int]:
    factor = max(0.0, min(1.0, factor))
    return tuple(
        round(component_a + (component_b - component_a) * factor)
        for component_a, component_b in zip(color_a, color_b)
    )


def _score_to_color(score: float | None) -> str:
    if score is None:
        return "#7f9cbc"

    red = (217, 83, 79)
    yellow = (240, 173, 78)
    green = (92, 184, 92)

    if score <= 50:
        blend = _interpolate_color(red, yellow, score / 50 if score > 0 else 0)
    else:
        blend = _interpolate_color(yellow, green, (score - 50) / 50 if score < 100 else 1)

    return "#%02x%02x%02x" % blend


def _available_pairs(games: Iterable[Game], status: str) -> list[Tuple[Game, Game]]:
    existing_pairs = {
        tuple(sorted((comp.game_a_id, comp.game_b_id)))
        for comp in Comparison.query.filter_by(status=status).all()
    }

    candidates = []
    game_list = list(games)
    for game_a, game_b in combinations(game_list, 2):
        pair_key = tuple(sorted((game_a.id, game_b.id)))
        if pair_key not in existing_pairs:
            candidates.append((game_a, game_b))
    return candidates


def _elo_expected(rating_a: float, rating_b: float) -> float:
    return 1.0 / (1.0 + 10 ** ((rating_b - rating_a) / 400))


def _update_elo(game_a: Game, game_b: Game, winner_id: int, k_factor: float = 32.0) -> None:
    expected_a = _elo_expected(game_a.elo_rating, game_b.elo_rating)
    expected_b = _elo_expected(game_b.elo_rating, game_a.elo_rating)

    if winner_id == game_a.id:
        score_a, score_b = 1.0, 0.0
    else:
        score_a, score_b = 0.0, 1.0

    game_a.elo_rating += k_factor * (score_a - expected_a)
    game_b.elo_rating += k_factor * (score_b - expected_b)


@bp.route("/api/rankings/<status>/pair")
def ranking_pair(status: str):
    try:
        normalized_status = _validate_status(status)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    games = Game.query.filter_by(status=normalized_status).all()
    if len(games) < 2:
        return jsonify({"error": "Add more games to start comparisons."}), 400

    candidates = _available_pairs(games, normalized_status)
    if not candidates:
        return jsonify({"message": "All possible pairs have been compared."})

    game_a, game_b = random.choice(candidates)
    return jsonify({"game_a": game_a.to_dict(), "game_b": game_b.to_dict()})


@bp.route("/api/rankings/<status>/compare", methods=["POST"])
def submit_comparison(status: str):
    try:
        normalized_status = _validate_status(status)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    payload = request.get_json(force=True)
    try:
        game_a_id = int(payload.get("game_a_id"))
        game_b_id = int(payload.get("game_b_id"))
        winner_id = int(payload.get("winner_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid comparison payload."}), 400

    if winner_id not in {game_a_id, game_b_id}:
        return jsonify({"error": "Winner must be one of the compared games."}), 400

    game_a = Game.query.get_or_404(game_a_id)
    game_b = Game.query.get_or_404(game_b_id)

    pair_key = tuple(sorted((game_a.id, game_b.id)))

    existing = Comparison.query.filter_by(
        status=normalized_status, game_a_id=pair_key[0], game_b_id=pair_key[1]
    ).first()
    if existing and existing.winner_id is not None:
        return jsonify({"error": "This pair has already been compared."}), 400

    if existing is None:
        comparison = Comparison(
            status=normalized_status,
            game_a_id=pair_key[0],
            game_b_id=pair_key[1],
            winner_id=winner_id,
        )
        db.session.add(comparison)
    else:
        existing.winner_id = winner_id

    _update_elo(game_a, game_b, winner_id)
    db.session.commit()

    return jsonify({"message": "Comparison recorded."})


@bp.route("/api/rankings/<status>")
def ranking_table(status: str):
    try:
        normalized_status = _validate_status(status)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    games = (
        Game.query.filter_by(status=normalized_status)
        .order_by(Game.elo_rating.desc())
        .all()
    )
    return jsonify([game.to_dict() for game in games])


@bp.route("/api/sessions", methods=["GET", "POST"])
def sessions_collection():
    if request.method == "POST":
        payload = request.get_json(force=True)
        game_id_raw = payload.get("game_id")
        game_id = None
        if game_id_raw not in (None, ""):
            try:
                game_id = int(game_id_raw)
            except (TypeError, ValueError):
                return jsonify({"error": "Invalid game identifier."}), 400

        game_title = (payload.get("game_title") or "").strip()
        session_date_raw = payload.get("session_date")

        try:
            playtime_minutes = int(payload.get("playtime_minutes"))
        except (TypeError, ValueError):
            return jsonify({"error": "Playtime must be a positive number of minutes."}), 400

        sentiment = (payload.get("sentiment") or "").strip().lower()
        comment = (payload.get("comment") or "").strip() or None

        if sentiment not in {"good", "mediocre", "bad"}:
            return jsonify({"error": "Sentiment must be good, mediocre, or bad."}), 400

        try:
            session_date = datetime.fromisoformat(session_date_raw).date()
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid session date."}), 400

        if playtime_minutes <= 0:
            return jsonify({"error": "Playtime must be a positive number of minutes."}), 400

        if game_id is not None:
            game = Game.query.get(game_id)
            if game:
                game_title = game.title

        if not game_title:
            return jsonify({"error": "Game title is required."}), 400

        session = SessionLog(
            game_id=game_id,
            game_title=game_title,
            session_date=session_date,
            playtime_minutes=playtime_minutes,
            sentiment=sentiment,
            comment=comment,
        )

        db.session.add(session)
        db.session.commit()

        return jsonify(session.to_dict()), 201

    sessions = SessionLog.query.order_by(SessionLog.session_date.desc()).all()
    return jsonify([session.to_dict() for session in sessions])


@bp.route("/api/sessions/<int:session_id>", methods=["DELETE"])
def delete_session(session_id: int):
    session = SessionLog.query.get_or_404(session_id)
    db.session.delete(session)
    db.session.commit()
    return jsonify({"message": "Session deleted."})


@bp.route("/api/steam/<app_id>")
def steam_lookup(app_id: str):
    url = "https://store.steampowered.com/api/appdetails"
    try:
        response = requests.get(url, params={"appids": app_id}, timeout=10)
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as exc:
        return jsonify({"error": f"Steam API request failed: {exc}"}), 502

    return jsonify(payload.get(app_id) or payload)


def _resolve_steam_id(steam_id: str, api_key: str | None = None) -> str:
    steam_id = (steam_id or "").strip()
    if not steam_id:
        raise ValueError("Steam ID is required.")

    if steam_id.isdigit():
        return steam_id

    if not api_key:
        raise ValueError("Steam API key is required to resolve a vanity URL.")

    url = "https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/"
    response = requests.get(
        url,
        params={"key": api_key, "vanityurl": steam_id},
        timeout=10,
    )
    response.raise_for_status()
    try:
        payload = response.json().get("response", {})
    except ValueError as exc:
        raise ValueError("Unexpected response while resolving Steam ID.") from exc
    if payload.get("success") != 1 or not payload.get("steamid"):
        raise ValueError("Unable to resolve vanity Steam URL.")

    return str(payload["steamid"])


def _import_games(entries: list[dict], status: str) -> tuple[list[Game], int]:
    imported: list[Game] = []
    skipped = 0

    for entry in entries:
        name = (entry.get("name") or "").strip()
        app_id = entry.get("appid")
        if not name or not app_id:
            skipped += 1
            continue

        existing = Game.query.filter(
            or_(Game.steam_app_id == str(app_id), Game.title == name)
        ).first()
        if existing:
            skipped += 1
            continue

        game = Game(title=name, status=status, steam_app_id=str(app_id))
        try:
            _apply_steam_metadata(game, game.steam_app_id)
        except SteamMetadataError:
            game.genres = []
            game.icon_url = None
            game.short_description = None
        if requires_purchase_date(status) and game.purchase_date is None:
            game.purchase_date = datetime.utcnow().date()
        db.session.add(game)
        imported.append(game)

    if imported:
        db.session.flush()

    return imported, skipped


@bp.route("/api/steam/import/library", methods=["POST"])
def import_steam_library():
    payload = request.get_json(force=True)
    steam_id_input = (payload.get("steam_id") or "").strip()
    api_key = (payload.get("api_key") or "").strip()
    status = normalize_status_value(payload.get("status"))

    try:
        normalized_status = _validate_status(status)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if not api_key:
        return jsonify({"error": "Steam Web API key is required."}), 400

    try:
        steam_id = _resolve_steam_id(steam_id_input, api_key)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except requests.RequestException as exc:
        return jsonify({"error": f"Steam API request failed: {exc}"}), 502

    url = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/"
    try:
        response = requests.get(
            url,
            params={
                "key": api_key,
                "steamid": steam_id,
                "include_appinfo": 1,
                "include_played_free_games": 1,
            },
            timeout=15,
        )
        response.raise_for_status()
        data = response.json().get("response", {})
    except requests.RequestException as exc:
        return jsonify({"error": f"Steam API request failed: {exc}"}), 502

    games = data.get("games") or []
    imported, skipped = _import_games(games, normalized_status)

    if imported:
        db.session.commit()
    else:
        db.session.rollback()

    return (
        jsonify(
            {
                "resolved_steam_id": steam_id,
                "imported_count": len(imported),
                "skipped_count": skipped,
                "imported": [game.to_dict() for game in imported],
            }
        ),
        200,
    )


def _fetch_wishlist_entries(steam_id: str) -> list[dict]:
    url = f"https://store.steampowered.com/wishlist/profiles/{steam_id}/wishlistdata/"
    entries: list[dict] = []
    page = 0

    while True:
        response = requests.get(url, params={"p": page}, timeout=15)
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError as exc:
            raise ValueError("Unexpected response while fetching wishlist.") from exc

        if not data:
            break

        if isinstance(data, dict) and data.get("success") == 2:
            raise ValueError("Wishlist is private or unavailable.")

        page_entries = []
        for app_id, info in data.items():
            if not isinstance(info, dict):
                continue
            name = info.get("name")
            if not name:
                continue
            try:
                normalized_app_id = int(app_id)
            except (TypeError, ValueError):
                continue
            page_entries.append({"appid": normalized_app_id, "name": name})

        entries.extend(page_entries)

        if len(data) < 50:
            break
        page += 1

    return entries


@bp.route("/api/steam/import/wishlist", methods=["POST"])
def import_steam_wishlist():
    payload = request.get_json(force=True)
    steam_id_input = (payload.get("steam_id") or "").strip()
    api_key = (payload.get("api_key") or "").strip() or None
    status = normalize_status_value(payload.get("status") or "wishlist")

    try:
        normalized_status = _validate_status(status)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        steam_id = _resolve_steam_id(steam_id_input, api_key)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except requests.RequestException as exc:
        return jsonify({"error": f"Steam API request failed: {exc}"}), 502

    try:
        entries = _fetch_wishlist_entries(steam_id)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except requests.RequestException as exc:
        return jsonify({"error": f"Steam API request failed: {exc}"}), 502

    imported, skipped = _import_games(entries, normalized_status)

    if imported:
        db.session.commit()
    else:
        db.session.rollback()

    return (
        jsonify(
            {
                "resolved_steam_id": steam_id,
                "imported_count": len(imported),
                "skipped_count": skipped,
                "imported": [game.to_dict() for game in imported],
            }
        ),
        200,
    )

