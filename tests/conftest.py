import sys
from pathlib import Path

import pytest

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app import create_app, db  # noqa: E402


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
