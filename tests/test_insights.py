from datetime import date, datetime

import pytest

from app import db
from app.insights import summarize_genre_preferences, summarize_lifecycle_metrics
from app.models import Game


def test_summarize_genre_preferences_weights_multi_genre_games(app_instance):
    with app_instance.app_context():
        game_a = Game(
            title="Sky Duel",
            status="backlog",
            elo_rating=1600,
        )
        game_a.genres = ["Action", "Adventure"]

        game_b = Game(
            title="Dungeon Echo",
            status="backlog",
            elo_rating=1500,
        )
        game_b.genres = ["Action"]

        game_c = Game(
            title="Puzzle Star",
            status="wishlist",
            elo_rating=1700,
        )
        game_c.genres = ["Adventure", "Puzzle"]

        game_d = Game(
            title="Logic Drift",
            status="wishlist",
            elo_rating=1400,
        )
        game_d.genres = ["Puzzle"]

        db.session.add_all([game_a, game_b, game_c, game_d])
        db.session.commit()

        summary = summarize_genre_preferences()

    backlog_genres = {entry["genre"]: entry for entry in summary["backlog"]["genres"]}
    wishlist_genres = {entry["genre"]: entry for entry in summary["wishlist"]["genres"]}
    combined_genres = {entry["genre"]: entry for entry in summary["genres"]}

    action_backlog = backlog_genres["Action"]
    assert action_backlog["count"] == 2
    assert action_backlog["weight"] == pytest.approx(1.5)
    assert action_backlog["average_elo"] == pytest.approx(1533.33, rel=1e-3)

    adventure_backlog = backlog_genres["Adventure"]
    assert adventure_backlog["count"] == 1
    assert adventure_backlog["weight"] == pytest.approx(0.5)
    assert adventure_backlog["average_elo"] == pytest.approx(1600.0)

    puzzle_wishlist = wishlist_genres["Puzzle"]
    assert puzzle_wishlist["count"] == 2
    assert puzzle_wishlist["weight"] == pytest.approx(1.5)
    assert puzzle_wishlist["average_elo"] == pytest.approx(1500.0)

    adventure_combined = combined_genres["Adventure"]
    assert adventure_combined["dominant"] == "balanced"
    assert adventure_combined["total"]["weight"] == pytest.approx(1.0)
    assert adventure_combined["total"]["share"] == pytest.approx(0.25)
    assert adventure_combined["total"]["average_elo"] == pytest.approx(1650.0)

    puzzle_combined = combined_genres["Puzzle"]
    assert puzzle_combined["dominant"] == "wishlist"
    assert puzzle_combined["total"]["weight"] == pytest.approx(1.5)
    assert puzzle_combined["backlog"]["weight"] == pytest.approx(0.0)


def test_summarize_lifecycle_metrics(app_instance):
    with app_instance.app_context():
        game_a = Game(
            title="Nova Quest",
            status="backlog",
            purchase_date=date(2022, 12, 1),
            start_date=date(2022, 12, 5),
            finish_date=date(2022, 12, 20),
        )
        game_b = Game(
            title="Echo Runner",
            status="backlog",
            purchase_date=date(2022, 12, 10),
            start_date=date(2022, 12, 12),
            finish_date=date(2022, 12, 18),
        )
        game_c = Game(
            title="Lagoon Archive",
            status="backlog",
            purchase_date=date(2022, 11, 1),
            start_date=None,
            finish_date=None,
            created_at=datetime(2022, 11, 1, 0, 0, 0),
        )
        game_d = Game(title="Skyline", status="wishlist")

        db.session.add_all([game_a, game_b, game_c, game_d])
        db.session.commit()

        summary = summarize_lifecycle_metrics(today=date(2023, 1, 15), backlog_limit=5)

    purchase_stats = summary["purchase_to_start"]["statistics"]
    assert purchase_stats["count"] == 2
    assert purchase_stats["median"] == pytest.approx(3.0)
    assert purchase_stats["percentiles"]["p75"] == pytest.approx(3.5)

    start_stats = summary["start_to_finish"]["statistics"]
    assert start_stats["median"] == pytest.approx(10.5)

    purchase_finish_stats = summary["purchase_to_finish"]["statistics"]
    assert purchase_finish_stats["max"] == pytest.approx(19.0)

    longest_purchase = summary["purchase_to_start"]["longest_examples"][0]
    assert longest_purchase["title"] == "Nova Quest"
    assert longest_purchase["days"] == 4

    aging_backlog = summary["aging_backlog"]
    assert len(aging_backlog) == 1
    assert aging_backlog[0]["title"] == "Lagoon Archive"
    assert aging_backlog[0]["days_waiting"] == 75
    assert aging_backlog[0]["added_date"] == "2022-11-01"
