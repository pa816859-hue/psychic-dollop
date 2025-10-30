import io

from app.models import Game


def test_backlog_import_uses_search_when_csv_has_generic_id(monkeypatch, app_instance, client):
    search_called = False

    def fake_search(title):
        nonlocal search_called
        search_called = True
        assert title == "428: Shibuya Scramble"
        return "428123"

    def fake_fetch(app_id):
        assert app_id == "428123"
        return {
            "genres": ["Visual Novel"],
            "icon_url": None,
            "short_description": "A dramatic mystery.",
            "title": "428: Shibuya Scramble",
        }

    monkeypatch.setattr("app.routes._fetch_steam_metadata", fake_fetch)
    monkeypatch.setattr("app.routes._search_steam_app_id", fake_search)

    csv_content = (
        "Game_ID,Title,Num. of Players,Date_Acquired,Date_Started,Date_Completed\n"
        "1,428: Shibuya Scramble,Single,2024-01-01,,,\n"
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
    assert payload["events"] and payload["events"][0]["source"] == "search"
    assert payload["events"][0]["steam_app_id"] == "428123"
    assert search_called

    with app_instance.app_context():
        game = Game.query.one()
        assert game.status == "backlog"
        assert game.steam_app_id == "428123"
        assert game.title == "428: Shibuya Scramble"


def test_wishlist_import_tracks_thoughts_and_uses_search(monkeypatch, app_instance, client):
    search_called = False

    def fake_search(title):
        nonlocal search_called
        search_called = True
        assert title == "Neon Rush"
        return "98765"

    def fake_fetch(app_id):
        assert app_id == "98765"
        return {
            "genres": ["Action"],
            "icon_url": "https://example.com/icon.jpg",
            "short_description": "Arcade fun.",
            "title": "Neon Rush",
        }

    monkeypatch.setattr("app.routes._fetch_steam_metadata", fake_fetch)
    monkeypatch.setattr("app.routes._search_steam_app_id", fake_search)

    csv_content = (
        "Game_ID,Title,Num. of Players,Thoughts\n"
        '77,Neon Rush,Co-op,"Looks like a great couch game"\n'
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
    assert payload["events"] and payload["events"][0]["source"] == "search"
    assert payload["events"][0]["steam_app_id"] == "98765"
    assert search_called

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


def test_backlog_import_honors_explicit_steam_app_id(monkeypatch, app_instance, client):
    fetch_called = False

    def fake_fetch(app_id):
        nonlocal fetch_called
        fetch_called = True
        assert app_id == "654321"
        return {
            "genres": ["RPG"],
            "icon_url": None,
            "short_description": "Classic adventure.",
            "title": "Chrono Quest",
        }

    def fail_search(title):  # pragma: no cover - defensive
        raise AssertionError("Search should not be called when Steam App ID is provided")

    monkeypatch.setattr("app.routes._fetch_steam_metadata", fake_fetch)
    monkeypatch.setattr("app.routes._search_steam_app_id", fail_search)

    csv_content = (
        "Steam App ID,Title,Num. of Players\n"
        "654321,Chrono Quest,Single\n"
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
    assert payload["events"] and payload["events"][0]["source"] == "csv:Steam App ID"
    assert payload["events"][0]["steam_app_id"] == "654321"
    assert fetch_called

    with app_instance.app_context():
        game = Game.query.one()
        assert game.steam_app_id == "654321"
        assert game.title == "Chrono Quest"
