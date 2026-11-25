"""Standard-library client for Banana Gallery's local HTTP API."""

from .client import DEFAULT_API_BASE, GalleryClient, LegacyAdapter
from .runtime import EnsureResult, GalleryError, classify_failure
from .submission import BatchRunner

__all__ = [
    "BatchRunner", "DEFAULT_API_BASE", "EnsureResult", "GalleryClient", "GalleryError",
    "LegacyAdapter", "classify_failure",
]
