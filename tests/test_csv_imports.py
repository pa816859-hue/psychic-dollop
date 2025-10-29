import io
import sys
from pathlib import Path

import pytest

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app import create_app, db
from app.models import Game


@pytest.fixture
def app_instance(tmp_path):
    database_file = tmp_path / "test.db"
    app = create_app(database_uri=f"sqlite:///{database_file}")
    app.config.update(TESTING=True)

    with app.app_context():
        db.drop_all()
        db.create_all()

    yield app

    with app.app_context():
        db.session.remove()
        db.drop_all()


@pytest.fixture
def client(app_instance):
    return app_instance.test_client()


def test_backlog_import_uses_csv_app_id(monkeypatch, app_instance, client):
    def fake_fetch(app_id):
        assert app_id == "428123"
        return {
            "genres": ["Visual Novel"],
            "icon_url": None,
            "short_description": "A dramatic mystery.",
            "title": "428: Shibuya Scramble",
        }

    def fail_search(title):  # pragma: no cover - defensive
        raise AssertionError("Search should not be called when CSV provides an App ID")

    monkeypatch.setattr("app.routes._fetch_steam_metadata", fake_fetch)
    monkeypatch.setattr("app.routes._search_steam_app_id", fail_search)

    csv_content = (
        "Game_ID,Title,Num. of Players,Date_Acquired,Date_Started,Date_Completed\n"
        "428123,428: Shibuya Scramble,Single,2024-01-01,,,\n"
    )

    response = client.post(
        "/api/import/backlog",
        data={"file": (io.BytesIO(csv_content.encode("utf-8")), "backlog.csv")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["imported_count"] == 1
    assert payload["skipped_count"] == 0
    assert payload["events"] and payload["events"][0]["source"].startswith("csv")
    assert payload["events"][0]["steam_app_id"] == "428123"

    with app_instance.app_context():
        game = Game.query.one()
        assert game.status == "backlog"
        assert game.steam_app_id == "428123"
        assert game.title == "428: Shibuya Scramble"


def test_wishlist_import_tracks_thoughts(monkeypatch, app_instance, client):
    def fake_fetch(app_id):
        assert app_id == "98765"
        return {
            "genres": ["Action"],
            "icon_url": "https://example.com/icon.jpg",
            "short_description": "Arcade fun.",
            "title": "Neon Rush",
        }

    def fail_search(title):  # pragma: no cover - defensive
        raise AssertionError("Search should not be called when CSV provides an App ID")

    monkeypatch.setattr("app.routes._fetch_steam_metadata", fake_fetch)
    monkeypatch.setattr("app.routes._search_steam_app_id", fail_search)

    csv_content = (
        "Game_ID,Title,Num. of Players,Thoughts\n"
        '98765,Neon Rush,Co-op,"Looks like a great couch game"\n'
    )

    response = client.post(
        "/api/import/wishlist",
        data={"file": (io.BytesIO(csv_content.encode("utf-8")), "wishlist.csv")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["imported_count"] == 1
    assert payload["skipped_count"] == 0
    assert payload["events"] and payload["events"][0]["source"].startswith("csv")
    assert payload["events"][0]["steam_app_id"] == "98765"

    with app_instance.app_context():
        game = Game.query.one()
        assert game.status == "wishlist"
        assert game.thoughts == "Looks like a great couch game"
        assert game.modes == ["Co-op"]


def test_backlog_import_reports_missing_app(monkeypatch, client, app_instance):
    def fake_search(title):
        return None

    def fail_fetch(app_id):  # pragma: no cover - defensive
        raise AssertionError("Should not fetch metadata when no App ID is available")

    monkeypatch.setattr("app.routes._search_steam_app_id", fake_search)
    monkeypatch.setattr("app.routes._fetch_steam_metadata", fail_fetch)

    csv_content = "Title,Num. of Players\nMystery Game,Single\n"

    response = client.post(
        "/api/import/backlog",
        data={"file": (io.BytesIO(csv_content.encode("utf-8")), "backlog.csv")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["imported_count"] == 0
    assert payload["skipped_count"] == 1
    assert payload["events"] and payload["events"][0]["status"] == "skipped"
    assert "Steam app not found" in payload["events"][0]["reason"]
    assert payload["skipped"][0]["reason"] == "Steam app not found."

    with app_instance.app_context():
        assert Game.query.count() == 0
