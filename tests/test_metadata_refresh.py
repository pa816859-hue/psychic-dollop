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

    response = client.post(f"/api/games/{game_id}/refresh")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["game"]["price_amount"] == 89.99
    assert payload["game"]["price_currency"] == "MYR"

    with app_instance.app_context():
        refreshed = Game.query.get(game_id)
        assert refreshed.icon_url == "https://example.com/icon.png"
        assert refreshed.short_description == "A thrilling escape room."
        assert refreshed.price_amount == 89.99
        assert refreshed.price_currency == "MYR"
        assert "Adventure" in refreshed.genres


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
