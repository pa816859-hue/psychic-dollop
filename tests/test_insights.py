from datetime import date, datetime

import pytest

from app import db
from app.insights import (
    summarize_engagement_trend,
    summarize_genre_preferences,
    summarize_lifecycle_metrics,
    summarize_price_insights,
)
from app.models import Game, SessionLog


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

    bucket_summaries = summary["buckets"]
    backlog_genres = {
        entry["genre"]: entry for entry in bucket_summaries["backlog"]["genres"]
    }
    wishlist_genres = {
        entry["genre"]: entry for entry in bucket_summaries["wishlist"]["genres"]
    }
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
    assert (
        puzzle_combined["buckets"]["backlog"]["weight"] == pytest.approx(0.0)
    )
    assert puzzle_combined["buckets"]["wishlist"]["weight"] == pytest.approx(1.5)
    assert "playing" in summary["bucket_metadata"]


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


def test_summarize_price_insights(app_instance):
    with app_instance.app_context():
        backlog = Game(
            title="Chronicle Backlog",
            status="backlog",
            price_amount=150.0,
            price_currency="MYR",
            purchase_price_amount=120.0,
            purchase_price_currency="MYR",
            purchase_date=date(2023, 5, 1),
            elo_rating=1625,
        )
        value_game = Game(
            title="Triumph Saga",
            status="full_clear",
            price_amount=90.0,
            price_currency="MYR",
            purchase_price_amount=60.0,
            purchase_price_currency="MYR",
            purchase_date=date(2023, 4, 12),
            start_date=date(2023, 4, 15),
            finish_date=date(2023, 5, 10),
            elo_rating=1780,
        )
        underused = Game(
            title="Slow Burn",
            status="playing",
            price_amount=180.0,
            price_currency="MYR",
            purchase_date=date(2023, 4, 20),
            elo_rating=1505,
        )
        wishlist = Game(
            title="Stellar Wish",
            status="wishlist",
            price_amount=95.0,
            price_currency="MYR",
            elo_rating=1820,
        )
        wishlist_alt = Game(
            title="Budget Indie",
            status="wishlist",
            price_amount=45.0,
            price_currency="USD",
            elo_rating=1510,
        )

        db.session.add_all([
            backlog,
            value_game,
            underused,
            wishlist,
            wishlist_alt,
        ])
        db.session.commit()

        db.session.add_all(
            [
                SessionLog(
                    game_id=value_game.id,
                    game_title=value_game.title,
                    session_date=date(2023, 5, 20),
                    playtime_minutes=600,
                    sentiment="good",
                ),
                SessionLog(
                    game_id=underused.id,
                    game_title=underused.title,
                    session_date=date(2023, 5, 22),
                    playtime_minutes=45,
                    sentiment="mediocre",
                ),
            ]
        )
        db.session.commit()

        summary = summarize_price_insights(today=date(2023, 6, 1), top_limit=3)

    assert summary["primary_currency"] == "MYR"

    myr_totals = summary["currency_totals"]["MYR"]
    assert myr_totals["owned_amount"] == pytest.approx(360.0)
    assert myr_totals["backlog_amount"] == pytest.approx(120.0)
    assert myr_totals["wishlist_amount"] == pytest.approx(95.0)
    assert myr_totals["average_tracked_hours"] == pytest.approx(5.38, rel=1e-3)

    backlog_watch = summary["backlog"]["most_expensive"]
    assert backlog_watch and backlog_watch[0]["title"] == "Chronicle Backlog"
    assert backlog_watch[0]["days_owned"] == 31
    assert backlog_watch[0]["price"]["amount"] == pytest.approx(120.0)
    assert summary["backlog"]["total_priced"] == 1

    wishlist_high = summary["wishlist"]["highest_interest"]
    assert wishlist_high and wishlist_high[0]["title"] == "Stellar Wish"
    assert summary["wishlist"]["total_priced"] == 2

    best_value = summary["value_for_money"]["MYR"]["best"]
    assert best_value and best_value[0]["title"] == "Triumph Saga"
    expected_enjoyment = (600 / 60) / 60.0
    assert best_value[0]["enjoyment_per_cost"] == pytest.approx(expected_enjoyment, rel=1e-6)

    underutilized = summary["value_for_money"]["MYR"]["underutilized"]
    assert underutilized and underutilized[0]["title"] == "Slow Burn"
    assert underutilized[0]["cost_per_hour"] == pytest.approx(240.0)

    savings = summary["savings"].get("MYR")
    assert savings is not None
    assert savings["total_saved"] == pytest.approx(60.0)
    assert savings["discounted_count"] == 2
    assert savings["average_discount_percent"] == pytest.approx(26.7, rel=1e-3)
    top_deals = savings["top_deals"]
    assert top_deals and top_deals[0]["title"] == "Triumph Saga"
    assert top_deals[0]["saved_amount"] == pytest.approx(30.0)
    assert top_deals[0]["purchase_price"]["amount"] == pytest.approx(60.0)


def test_summarize_engagement_trend_detects_spikes(app_instance):
    with app_instance.app_context():
        game_a = Game(title="Aurora Trails", status="playing")
        game_a.genres = ["RPG", "Adventure"]
        game_b = Game(title="Nebula Forge", status="playing")
        game_b.genres = ["Strategy"]
        db.session.add_all([game_a, game_b])
        db.session.commit()

        sessions = [
            SessionLog(
                game_id=game_a.id,
                game_title=game_a.title,
                session_date=date(2023, 1, 5),
                playtime_minutes=120,
                sentiment="good",
            ),
            SessionLog(
                game_id=game_b.id,
                game_title=game_b.title,
                session_date=date(2023, 1, 18),
                playtime_minutes=60,
                sentiment="mediocre",
            ),
            SessionLog(
                game_id=game_a.id,
                game_title=game_a.title,
                session_date=date(2023, 2, 10),
                playtime_minutes=200,
                sentiment="good",
            ),
            SessionLog(
                game_id=game_b.id,
                game_title=game_b.title,
                session_date=date(2023, 2, 12),
                playtime_minutes=200,
                sentiment="bad",
            ),
            SessionLog(
                game_id=game_b.id,
                game_title=game_b.title,
                session_date=date(2023, 3, 3),
                playtime_minutes=60,
                sentiment="mediocre",
            ),
        ]
        db.session.add_all(sessions)
        db.session.commit()

        summary = summarize_engagement_trend()
        filtered = summarize_engagement_trend(start_date=date(2023, 2, 1))

    assert len(summary["timeline"]) == 3
    january, february, march = summary["timeline"]
    assert january["active_titles"] == 2
    assert january["total_minutes"] == pytest.approx(180.0)
    assert february["total_minutes"] == pytest.approx(400.0)
    assert february["average_sentiment"] == pytest.approx(50.0)
    assert march["total_minutes"] == pytest.approx(60.0)

    assert filtered["timeline"][0]["period_start"].startswith("2023-02")

    callout_types = {callout["type"] for callout in summary["callouts"]}
    assert "spike" in callout_types
    assert "dip" in callout_types

    spike_callout = next(callout for callout in summary["callouts"] if callout["type"] == "spike")
    spike_titles = {driver["title"] for driver in spike_callout["drivers"]["titles"]}
    assert {"Aurora Trails", "Nebula Forge"}.issubset(spike_titles)


def test_summarize_engagement_trend_daily_period(app_instance):
    with app_instance.app_context():
        game = Game(title="Signal Drift", status="playing")
        db.session.add(game)
        db.session.commit()

        sessions = [
            SessionLog(
                game_id=game.id,
                game_title=game.title,
                session_date=date(2023, 4, 1),
                playtime_minutes=90,
                sentiment="great",
            ),
            SessionLog(
                game_id=game.id,
                game_title=game.title,
                session_date=date(2023, 4, 1),
                playtime_minutes=60,
                sentiment="good",
            ),
            SessionLog(
                game_id=game.id,
                game_title=game.title,
                session_date=date(2023, 4, 3),
                playtime_minutes=45,
                sentiment="bad",
            ),
        ]
        db.session.add_all(sessions)
        db.session.commit()

        summary = summarize_engagement_trend(period="day")

    assert summary["period"] == "day"
    timeline = summary["timeline"]
    assert len(timeline) == 2
    first_day = timeline[0]
    assert first_day["period_start"] == "2023-04-01"
    assert first_day["total_minutes"] == pytest.approx(150.0)
    assert first_day["label"].startswith("Apr")
    second_day = timeline[1]
    assert second_day["period_start"] == "2023-04-03"
