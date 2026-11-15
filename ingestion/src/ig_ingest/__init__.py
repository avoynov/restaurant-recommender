"""Instagram ingestion prototype.

Turns public Instagram handles or post URLs into normalized post records that
follow the handoff contract (schema_version 1.0) consumed by the separate
Dataset Population module.
"""

SCHEMA_VERSION = "1.0"
__version__ = "0.1.0"
