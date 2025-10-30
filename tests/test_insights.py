import pytest

from app import db
from app.insights import summarize_genre_preferences
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
