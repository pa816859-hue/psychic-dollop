from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable


@dataclass(frozen=True)
class StatusDefinition:
    value: str
    label: str
    insight_bucket: str
    requires_purchase_date: bool


_STATUS_DEFINITIONS: tuple[StatusDefinition, ...] = (
    StatusDefinition(
        value="backlog",
        label="Backlog",
        insight_bucket="backlog",
        requires_purchase_date=True,
    ),
    StatusDefinition(
        value="playing",
        label="Playing",
        insight_bucket="backlog",
        requires_purchase_date=True,
    ),
    StatusDefinition(
        value="occasional",
        label="Occasional",
        insight_bucket="backlog",
        requires_purchase_date=True,
    ),
    StatusDefinition(
        value="story_clear",
        label="Story clear",
        insight_bucket="backlog",
        requires_purchase_date=True,
    ),
    StatusDefinition(
        value="full_clear",
        label="Full clear",
        insight_bucket="backlog",
        requires_purchase_date=True,
    ),
    StatusDefinition(
        value="dropped",
        label="Dropped",
        insight_bucket="backlog",
        requires_purchase_date=True,
    ),
    StatusDefinition(
        value="wishlist",
        label="Wishlist",
        insight_bucket="wishlist",
        requires_purchase_date=False,
    ),
)


STATUS_BY_VALUE: Dict[str, StatusDefinition] = {
    definition.value: definition for definition in _STATUS_DEFINITIONS
}

STATUS_VALUES: tuple[str, ...] = tuple(STATUS_BY_VALUE.keys())

OWNED_STATUSES: tuple[str, ...] = tuple(
    value
    for value, definition in STATUS_BY_VALUE.items()
    if definition.requires_purchase_date
)

DEFAULT_STATUS = "backlog"

INSIGHT_BUCKET_BY_STATUS: Dict[str, str] = {
    value: definition.insight_bucket for value, definition in STATUS_BY_VALUE.items()
}


def normalize_status_value(value: str | None) -> str:
    """Normalize a raw status string into a canonical value."""

    if value is None:
        return DEFAULT_STATUS
    normalized = value.strip().lower()
    return normalized or DEFAULT_STATUS


def validate_status(value: str | None) -> str:
    """Ensure the provided status maps to a supported value."""

    normalized = normalize_status_value(value)
    if normalized not in STATUS_BY_VALUE:
        allowed = ", ".join(sorted(STATUS_BY_VALUE))
        raise ValueError(f"Status must be one of {allowed}.")
    return normalized


def requires_purchase_date(status: str) -> bool:
    definition = STATUS_BY_VALUE.get(status)
    return bool(definition and definition.requires_purchase_date)


def iter_status_definitions() -> Iterable[StatusDefinition]:
    return tuple(_STATUS_DEFINITIONS)
