from app import db
from app.models import Game
from app import routes as routes_module
from app.routes import SteamMetadataError


def _create_game(title="Test", status="backlog", steam_app_id=None):
    game = Game(title=title, status=status, steam_app_id=steam_app_id)
    db.session.add(game)
    db.session.commit()
    return game.id


def test_fetch_steam_metadata_extracts_user_tags(monkeypatch):
    captured = {}

    class DummyResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "789": {
                    "success": True,
                    "data": {
                        "name": "Sample Game",
                        "genres": [
                            {"description": "Action"},
                            {"description": "Adventure"},
                        ],
                        "user_defined_tags": ["Tag One", "Tag Two", "Tag Two"],
                        "steamspy_tags": {"Tag Three": 20, "Tag Four": 10},
                        "tags": {"Tag Five": 5},
                        "short_description": "Sample description.",
                        "price_overview": {"initial": 1234, "currency": "usd"},
                        "header_image": "https://example.com/header.jpg",
                    },
                }
            }

    def fake_get(url, params, timeout):
        captured["params"] = params.copy()
        return DummyResponse()

    monkeypatch.setattr("app.routes.requests.get", fake_get)
    monkeypatch.setattr("app.routes._fetch_steamspy_tags", lambda app_id: [])

    metadata = routes_module._fetch_steam_metadata("789")

    params = captured["params"]
    assert params["appids"] == "789"
    assert params["include_appinfo"] == 1
    assert params["include_played_free_games"] == 1
    assert metadata["genres"][:2] == ["Action", "Adventure"]
    assert metadata["genres"][2:] == [
        "Tag One",
        "Tag Two",
        "Tag Three",
        "Tag Four",
        "Tag Five",
    ]
    assert metadata["icon_url"] == "https://example.com/header.jpg"
    assert metadata["price"] == {"amount": 12.34, "currency": "USD"}


def test_fetch_steam_metadata_uses_steamspy_fallback(monkeypatch):
    class DummyResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "321": {
                    "success": True,
                    "data": {
                        "name": "Fallback Game",
                        "genres": [{"description": "Indie"}],
                        "short_description": "Fallback description.",
                        "header_image": "https://example.com/cover.jpg",
                    },
                }
            }

    def fake_get(url, params, timeout):
        return DummyResponse()

    monkeypatch.setattr("app.routes.requests.get", fake_get)

    fallback_called = {}

    def fake_fetch_tags(app_id):
        fallback_called["app_id"] = app_id
        return ["Tag Alpha", "Tag Beta", "Tag Gamma"]

    monkeypatch.setattr("app.routes._fetch_steamspy_tags", fake_fetch_tags)

    metadata = routes_module._fetch_steam_metadata("321")

    assert fallback_called["app_id"] == "321"
    assert metadata["genres"] == ["Indie", "Tag Alpha", "Tag Beta", "Tag Gamma"]


def test_refresh_game_metadata_updates_fields(monkeypatch, client, app_instance):
    with app_instance.app_context():
        game_id = _create_game(steam_app_id="12345")

    def fake_fetch(app_id):
        assert app_id == "12345"
        return {
            "genres": ["Adventure", "Puzzle"],
            "icon_url": "https://example.com/icon.png",
            "short_description": "A thrilling escape room.",
            "title": "Mystery Escape",
            "price": {"amount": 89.99, "currency": "MYR"},
        }

    monkeypatch.setattr("app.routes._fetch_steam_metadata", fake_fetch)
    monkeypatch.setattr(
        "app.routes._fetch_howlongtobeat_data",
        lambda title: {"main_hours": 12.0, "main_extra_hours": 18.5},
    )

    response = client.post(f"/api/games/{game_id}/refresh")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["game"]["price_amount"] == 89.99
    assert payload["game"]["price_currency"] == "MYR"
    assert payload["game"]["hltb_main_hours"] == 12.0
    assert payload["game"]["hltb_main_extra_hours"] == 18.5

    with app_instance.app_context():
        refreshed = Game.query.get(game_id)
        assert refreshed.icon_url == "https://example.com/icon.png"
        assert refreshed.short_description == "A thrilling escape room."
        assert refreshed.price_amount == 89.99
        assert refreshed.price_currency == "MYR"
        assert "Adventure" in refreshed.genres
        assert refreshed.hltb_main_hours == 12.0
        assert refreshed.hltb_main_extra_hours == 18.5


def test_refresh_game_metadata_requires_app_id(client, app_instance):
    with app_instance.app_context():
        game_id = _create_game(steam_app_id=None)

    response = client.post(f"/api/games/{game_id}/refresh")
    assert response.status_code == 400
    assert "Steam App ID" in response.get_json()["error"]


def test_refresh_library_status_metadata_handles_errors(monkeypatch, client, app_instance):
    with app_instance.app_context():
        success_id = _create_game(title="Success", steam_app_id="111", status="wishlist")
        failure_id = _create_game(title="Failure", steam_app_id="222", status="wishlist")

    def fake_fetch(app_id):
        if app_id == "222":
            raise SteamMetadataError("Metadata unavailable", status_code=503)
        return {
            "genres": ["Indie"],
            "icon_url": None,
            "short_description": "Indie vibes.",
            "price": {"amount": 12.5, "currency": "MYR"},
        }

    monkeypatch.setattr("app.routes._fetch_steam_metadata", fake_fetch)
    monkeypatch.setattr(
        "app.routes._fetch_howlongtobeat_data",
        lambda title: {"main_hours": 7.25, "main_extra_hours": 10.5},
    )

    response = client.post("/api/library/wishlist/refresh")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["updated"] == 1
    assert len(payload["errors"]) == 1

    with app_instance.app_context():
        success = Game.query.get(success_id)
        failure = Game.query.get(failure_id)
        assert success.price_amount == 12.5
        assert success.price_currency == "MYR"
        assert failure.price_amount is None
        assert failure.price_currency is None
        assert success.hltb_main_hours == 7.25
        assert success.hltb_main_extra_hours == 10.5
        assert failure.hltb_main_hours is None
        assert failure.hltb_main_extra_hours is None


def test_create_game_without_steam_fetches_hltb(monkeypatch, client, app_instance):
    captured = {}

    def fake_fetch(title):
        captured["title"] = title
        return {"main_hours": 5.5, "main_extra_hours": 8.75}

    monkeypatch.setattr("app.routes._fetch_howlongtobeat_data", fake_fetch)

    response = client.post(
        "/api/games",
        json={
            "title": "No Steam Game",
            "status": "wishlist",
            "steam_app_id": None,
        },
    )

    assert response.status_code == 201
    payload = response.get_json()
    assert captured["title"] == "No Steam Game"
    assert payload["hltb_main_hours"] == 5.5
    assert payload["hltb_main_extra_hours"] == 8.75

    with app_instance.app_context():
        stored = Game.query.filter_by(title="No Steam Game").first()
        assert stored is not None
        assert stored.hltb_main_hours == 5.5
        assert stored.hltb_main_extra_hours == 8.75


def test_update_game_without_refresh_updates_hltb(monkeypatch, client, app_instance):
    with app_instance.app_context():
        game_id = _create_game(title="Sample", status="wishlist", steam_app_id=None)

    calls: list[str] = []

    def fake_fetch(title):
        calls.append(title)
        return {"main_hours": 9.0, "main_extra_hours": 14.0}

    monkeypatch.setattr("app.routes._fetch_howlongtobeat_data", fake_fetch)

    response = client.put(
        f"/api/games/{game_id}",
        json={
            "title": "Sample Deluxe",
            "status": "wishlist",
        },
    )

    assert response.status_code == 200
    assert calls == ["Sample Deluxe"]

    with app_instance.app_context():
        refreshed = Game.query.get(game_id)
        assert refreshed.hltb_main_hours == 9.0
        assert refreshed.hltb_main_extra_hours == 14.0


def test_hltb_fetch_uses_signed_endpoint(monkeypatch):
    routes_module._reset_hltb_search_cache()

    class DummyResponse:
        def __init__(self, status_code=200, text=None, json_data=None):
            self.status_code = status_code
            self.text = text
            self._json = json_data

        def raise_for_status(self):
            if self.status_code >= 400:
                raise routes_module.requests.HTTPError(
                    f"{self.status_code} error",
                    response=self,
                )

        def json(self):
            return self._json

    monkeypatch.setattr(routes_module.hltb_rate_limiter, "wait", lambda: None)

    script_url = "https://howlongtobeat.com/_next/static/chunks/app/_app-abc.js"

    def fake_get(url, headers=None, timeout=None):
        if url == routes_module._HLTB_BASE_URL:
            return DummyResponse(text='<script src="/_next/static/chunks/app/_app-abc.js"></script>')
        if url == script_url:
            return DummyResponse(
                text='fetch("/api/s/".concat("abc").concat("123"),{method:"POST"})users:{id:"abc123"}'
            )
        raise AssertionError(f"unexpected GET {url}")

    post_calls: list[tuple[str, dict]] = []

    def fake_post(url, json=None, headers=None, timeout=None):
        post_calls.append((url, json))
        return DummyResponse(
            json_data={
                "data": [
                    {
                        "game_name": "Example",
                        "gameplay_main": "5 Hours",
                        "gameplay_main_extra": "7 Hours",
                    }
                ]
            }
        )

    monkeypatch.setattr("app.routes.requests.get", fake_get)
    monkeypatch.setattr("app.routes.requests.post", fake_post)

    result = routes_module._fetch_howlongtobeat_data("Example Game")

    assert result == {
        "title": "Example",
        "main_hours": 5.0,
        "main_extra_hours": 7.0,
    }
    assert post_calls[0][0] == "https://howlongtobeat.com/api/s/abc123"
    assert "id" not in post_calls[0][1]["searchOptions"]["users"]


def test_hltb_fetch_refreshes_search_cache_after_404(monkeypatch):
    routes_module._reset_hltb_search_cache()

    class DummyResponse:
        def __init__(self, status_code=200, text=None, json_data=None):
            self.status_code = status_code
            self.text = text
            self._json = json_data

        def raise_for_status(self):
            if self.status_code >= 400:
                raise routes_module.requests.HTTPError(
                    f"{self.status_code} error",
                    response=self,
                )

        def json(self):
            return self._json

    monkeypatch.setattr(routes_module.hltb_rate_limiter, "wait", lambda: None)

    call_state = {"landing": 0}

    def fake_get(url, headers=None, timeout=None):
        if url == routes_module._HLTB_BASE_URL:
            call_state["landing"] += 1
            if call_state["landing"] == 1:
                return DummyResponse(text='<script src="/_next/static/chunks/app/_app-old.js"></script>')
            return DummyResponse(text='<script src="/_next/static/chunks/app/_app-new.js"></script>')
        if url == "https://howlongtobeat.com/_next/static/chunks/app/_app-old.js":
            return DummyResponse(text='fetch("/api/s/".concat("old"),{method:"POST"})users:{id:"old"}')
        if url == "https://howlongtobeat.com/_next/static/chunks/app/_app-new.js":
            return DummyResponse(text='fetch("/api/s/".concat("new"),{method:"POST"})users:{id:"new"}')
        raise AssertionError(f"unexpected GET {url}")

    post_calls: list[str] = []

    def fake_post(url, json=None, headers=None, timeout=None):
        post_calls.append(url)
        if "old" in url:
            return DummyResponse(status_code=404)
        return DummyResponse(
            json_data={
                "data": [
                    {
                        "game_name": "Refreshed",
                        "gameplay_main": "10 Hours",
                        "gameplay_main_extra": None,
                    }
                ]
            }
        )

    monkeypatch.setattr("app.routes.requests.get", fake_get)
    monkeypatch.setattr("app.routes.requests.post", fake_post)

    result = routes_module._fetch_howlongtobeat_data("Refreshed Game")

    assert result == {
        "title": "Refreshed",
        "main_hours": 10.0,
        "main_extra_hours": None,
    }
    assert post_calls[0] == "https://howlongtobeat.com/api/s/old"
    assert post_calls[1] == "https://howlongtobeat.com/api/s/new"
    assert call_state["landing"] == 2
