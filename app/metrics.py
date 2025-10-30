from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping


@dataclass(frozen=True)
class WeightedSentimentResult:
    """Aggregated weighted sentiment values for a set of sessions."""

    weighted_score: float | None
    total_minutes: float
    weighted_minutes: float

    @property
    def has_score(self) -> bool:
        return self.weighted_score is not None


def compute_weighted_sentiment(
    session_rows: Iterable[object],
    *,
    sentiment_weights: Mapping[str, float] | None = None,
) -> WeightedSentimentResult:
    """Compute the weighted sentiment score for the provided sessions.

    Each ``session`` in ``session_rows`` is expected to expose ``sentiment`` and
    ``playtime_minutes`` attributes. Sentiments that are not present in the
    ``sentiment_weights`` mapping are ignored for the weighted average but still
    contribute to the total minutes tracked.
    """

    weights = {
        "good": 100.0,
        "mediocre": 50.0,
        "bad": 0.0,
    }
    if sentiment_weights:
        weights.update({k: float(v) for k, v in sentiment_weights.items()})

    total_minutes = 0.0
    weighted_sum = 0.0
    total_weight = 0.0

    for session in session_rows:
        try:
            minutes = float(getattr(session, "playtime_minutes", 0) or 0)
        except (TypeError, ValueError):
            minutes = 0.0
        sentiment = str(getattr(session, "sentiment", "")).lower()

        if minutes <= 0:
            continue

        total_minutes += minutes
        if sentiment in weights:
            weighted_sum += weights[sentiment] * minutes
            total_weight += minutes

    weighted_score = (weighted_sum / total_weight) if total_weight else None
    return WeightedSentimentResult(weighted_score, total_minutes, total_weight)
