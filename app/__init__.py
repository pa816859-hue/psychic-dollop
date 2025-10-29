from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import inspect, text


db = SQLAlchemy()


def create_app(database_uri: str | None = None):
    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = database_uri or "sqlite:///data.db"
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

    db.init_app(app)

    from .routes import bp as core_bp

    app.register_blueprint(core_bp)

    with app.app_context():
        db.create_all()
        _ensure_game_columns()

    return app


def _ensure_game_columns() -> None:
    inspector = inspect(db.engine)
    try:
        columns = {column["name"] for column in inspector.get_columns("games")}
    except Exception:  # pragma: no cover - fallback for first run
        return

    column_definitions = {
        "purchase_date": "DATE",
        "start_date": "DATE",
        "finish_date": "DATE",
        "thoughts": "TEXT",
    }

    added = False
    for column, column_type in column_definitions.items():
        if column not in columns:
            db.session.execute(
                text(f"ALTER TABLE games ADD COLUMN {column} {column_type}")
            )
            added = True

    if added:
        db.session.commit()
