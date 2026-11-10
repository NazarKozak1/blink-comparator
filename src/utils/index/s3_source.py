"""Public SPHEREx bucket. Layout: {release}/level2/{week}/{processing}/{detector}/{file}.fits"""
from typing import Iterator

import boto3
from botocore import UNSIGNED
from botocore.config import Config

from .config import IndexConfig

Page = list[tuple[str, str]]  # (key, etag)


def make_client(cfg: IndexConfig):
    return boto3.client(
        "s3",
        region_name="us-east-1",
        config=Config(
            signature_version=UNSIGNED,
            max_pool_connections=cfg.workers + 8,  # workers + main thread listing pages
            retries={"max_attempts": 5, "mode": "adaptive"},
        ),
    )


def list_subfolders(s3, bucket: str, prefix: str) -> list[str]:
    folders = []
    for page in s3.get_paginator("list_objects_v2").paginate(
        Bucket=bucket, Prefix=prefix, Delimiter="/"
    ):
        folders += [p["Prefix"] for p in page.get("CommonPrefixes", [])]
    return folders


def detector_prefixes(s3, cfg: IndexConfig) -> list[str]:
    """Folders that directly contain FITS files, limited to the configured scope."""
    prefixes = []
    for release in cfg.releases:
        weeks = list_subfolders(s3, cfg.bucket, f"{release}/level2/")
        if cfg.last_weeks:
            weeks = weeks[-cfg.last_weeks:]
        for week in weeks:
            for processing in list_subfolders(s3, cfg.bucket, week):
                prefixes += [f"{processing}{det}/" for det in cfg.detectors]
    return prefixes


def iter_pages(s3, cfg: IndexConfig) -> Iterator[Page]:
    """Listing pages of up to 1000 FITS files; ETag changes whenever file content changes."""
    paginator = s3.get_paginator("list_objects_v2")
    for prefix in detector_prefixes(s3, cfg):
        for page in paginator.paginate(Bucket=cfg.bucket, Prefix=prefix):
            items = [
                (obj["Key"], obj["ETag"].strip('"'))
                for obj in page.get("Contents", [])
                if obj["Key"].endswith(".fits")
            ]
            if items:
                yield items


def parse_key(key: str) -> dict:
    release, _, week, processing, detector, _ = key.split("/")
    return {
        "release": release,
        "week": week,
        "processing": processing,
        "is_retry": "retry" in processing,
        "detector": int(detector),
    }


def fetch_header(s3, cfg: IndexConfig, key: str) -> str:
    resp = s3.get_object(Bucket=cfg.bucket, Key=key, Range=f"bytes=0-{cfg.header_bytes - 1}")
    return resp["Body"].read().decode("ascii", errors="ignore")