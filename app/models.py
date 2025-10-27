from __future__ import annotations

from datetime import datetime
from typing import List

from . import db


class Game(db.Model):
    __tablename__ = "games"

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(255), nullable=False, unique=True)
    status = db.Column(db.String(32), nullable=False)  # backlog or wishlist
    modes_raw = db.Column(db.Text, default="[]")
    genres_raw = db.Column(db.Text, default="[]")
    steam_app_id = db.Column(db.String(32), nullable=True)
    icon_url = db.Column(db.String(512), nullable=True)
    elo_rating = db.Column(db.Float, nullable=False, default=1500.0)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "modes": self.modes,
            "genres": self.genres,
            "steam_app_id": self.steam_app_id,
            "icon_url": self.icon_url,
            "elo_rating": self.elo_rating,
            "created_at": self.created_at.isoformat(),
        }

    @property
    def modes(self) -> List[str]:
        from json import loads

        return loads(self.modes_raw or "[]")

    @modes.setter
    def modes(self, value: List[str]) -> None:
        from json import dumps

        self.modes_raw = dumps(value or [])

    @property
    def genres(self) -> List[str]:
        from json import loads

        return loads(self.genres_raw or "[]")

    @genres.setter
    def genres(self, value: List[str]) -> None:
        from json import dumps

        self.genres_raw = dumps(value or [])


class SessionLog(db.Model):
    __tablename__ = "session_logs"

    id = db.Column(db.Integer, primary_key=True)
    game_id = db.Column(db.Integer, db.ForeignKey("games.id"), nullable=True)
    game_title = db.Column(db.String(255), nullable=False)
    session_date = db.Column(db.Date, nullable=False)
    playtime_minutes = db.Column(db.Integer, nullable=False)
    sentiment = db.Column(db.String(16), nullable=False)
    comment = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    game = db.relationship("Game", backref="sessions")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "game_id": self.game_id,
            "game_title": self.game_title,
            "session_date": self.session_date.isoformat(),
            "playtime_minutes": self.playtime_minutes,
            "sentiment": self.sentiment,
            "comment": self.comment,
            "created_at": self.created_at.isoformat(),
        }


class Comparison(db.Model):
    __tablename__ = "comparisons"

    id = db.Column(db.Integer, primary_key=True)
    status = db.Column(db.String(32), nullable=False)
    game_a_id = db.Column(db.Integer, db.ForeignKey("games.id"), nullable=False)
    game_b_id = db.Column(db.Integer, db.ForeignKey("games.id"), nullable=False)
    winner_id = db.Column(db.Integer, db.ForeignKey("games.id"), nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    game_a = db.relationship("Game", foreign_keys=[game_a_id])
    game_b = db.relationship("Game", foreign_keys=[game_b_id])
    winner = db.relationship("Game", foreign_keys=[winner_id])

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "game_a_id": self.game_a_id,
            "game_b_id": self.game_b_id,
            "winner_id": self.winner_id,
            "created_at": self.created_at.isoformat(),
        }
