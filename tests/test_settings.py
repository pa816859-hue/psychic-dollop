from datetime import date

from app import db
from app.models import Comparison, Game, SessionLog


def _create_sample_records():
    game_one = Game(title="Game One", status="backlog")
    game_two = Game(title="Game Two", status="wishlist")
    db.session.add_all([game_one, game_two])
    db.session.flush()

    session_entry = SessionLog(
        game_id=game_one.id,
        game_title=game_one.title,
        session_date=date(2024, 1, 1),
        playtime_minutes=60,
        sentiment="positive",
    )
    comparison_entry = Comparison(
        status="backlog",
        game_a_id=game_one.id,
        game_b_id=game_two.id,
        winner_id=game_one.id,
    )
    db.session.add_all([session_entry, comparison_entry])
    db.session.commit()


def test_purge_data_requires_confirmation(client):
    response = client.post("/api/settings/purge-data", json={"confirm": "nope"})
    assert response.status_code == 400
    assert "DELETE" in response.get_json()["error"]


def test_purge_data_deletes_all_tables(client, app_instance):
    with app_instance.app_context():
        _create_sample_records()
        assert Game.query.count() == 2
        assert SessionLog.query.count() == 1
        assert Comparison.query.count() == 1

    response = client.post("/api/settings/purge-data", json={"confirm": "DELETE"})
    assert response.status_code == 200
    data = response.get_json()
    assert data["deleted"] == {"comparisons": 1, "sessions": 1, "games": 2}

    with app_instance.app_context():
        assert Game.query.count() == 0
        assert SessionLog.query.count() == 0
        assert Comparison.query.count() == 0
