from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator

from app.models.item import ItemOwnership
from app.utils.signed_urls import sign_image_url


def validate_reference_price(value: Decimal | None) -> Decimal | None:
    """Checks shared by every schema that accepts a 待购 reference price.

    Three rules, all of them about not lying to the user about money:

    * **never negative** (also expressed as `Field(ge=0)`, repeated here so the rule
      holds for callers that build the model directly);
    * **at most two decimal places** — the column is `Numeric(10, 2)`, so silently
      rounding 199.999 would store a price nobody typed. It is refused instead;
    * **inside the column's range** (8 integer digits), so the value cannot fail at
      INSERT time with a database error after the photo was already stored.

    `Decimal` end to end and never a float: 199.99 stays 199.99 rather than
    199.990000000000009094947017729282379150390625.
    """
    if value is None:
        return None
    if not value.is_finite():
        raise ValueError("参考价格必须是有效数字")
    if value < 0:
        raise ValueError("参考价格不能为负数")
    try:
        quantized = value.quantize(Decimal("0.01"))
    except InvalidOperation:
        raise ValueError("参考价格超出可存储范围") from None
    if value != quantized:
        raise ValueError("参考价格最多保留两位小数")
    if value >= Decimal("100000000"):
        raise ValueError("参考价格超出可存储范围")
    return value


def validate_source_url(value: str | None) -> str | None:
    """Keeps `source_url` to an http/https address a browser can actually open.

    Round 4 only ever *shows* this link and hands it to the phone's browser on an
    explicit tap, so any other scheme (`javascript:`, `intent:`, `file:`) is
    refused here rather than becoming a one-tap way to run something else. An
    empty string means "not provided" and is stored as NULL.
    """
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if len(trimmed) > 500:
        raise ValueError("商品链接不能超过 500 个字符")
    parsed = urlparse(trimmed)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("商品链接只能填写 http:// 或 https:// 开头的网址")
    return trimmed

# Default wash intervals by clothing type (wears between washes)
DEFAULT_WASH_INTERVALS: dict[str, int] = {
    "t-shirt": 1,
    "shirt": 2,
    "blouse": 2,
    "pants": 4,
    "jeans": 6,
    "shorts": 3,
    "dress": 2,
    "skirt": 3,
    "sweater": 5,
    "hoodie": 4,
    "jacket": 8,
    "coat": 10,
    "blazer": 5,
    "suit": 5,
    "shoes": 15,
    "accessories": 20,
    "other": 3,
}


class ItemTags(BaseModel):
    colors: list[str] = Field(default_factory=list)
    primary_color: str | None = None
    pattern: str | None = None
    material: str | None = None
    style: list[str] = Field(default_factory=list)
    season: list[str] = Field(default_factory=list)
    formality: str | None = None
    fit: str | None = None


class ItemBase(BaseModel):
    type: str = Field(default="unknown", max_length=50)  # Default to unknown, AI will detect
    subtype: str | None = Field(None, max_length=50)
    name: str | None = Field(None, max_length=100)
    brand: str | None = Field(None, max_length=100)
    notes: str | None = None
    purchase_date: date | None = None
    purchase_price: Decimal | None = Field(None, ge=0)
    favorite: bool = False
    # 待购 fields (round 4). Both are optional and independent of the wardrobe:
    # `reference_price` is what the user expects to pay, `source_url` is the shop
    # page they typed. Neither is ever derived from a scrape.
    reference_price: Decimal | None = Field(None, ge=0)
    source_url: str | None = None
    # Ownership. Omitted means "owned", which keeps every pre-round-4 client that
    # posts to `/items` writing to the wardrobe exactly as before.
    ownership: ItemOwnership = ItemOwnership.owned

    @field_validator("reference_price")
    @classmethod
    def _check_reference_price(cls, value: Decimal | None) -> Decimal | None:
        return validate_reference_price(value)

    @field_validator("source_url")
    @classmethod
    def _check_source_url(cls, value: str | None) -> str | None:
        return validate_source_url(value)


class ItemCreate(ItemBase):
    tags: ItemTags | None = None
    colors: list[str] | None = None
    primary_color: str | None = None


class ItemUpdate(BaseModel):
    type: str | None = Field(None, min_length=1, max_length=50)
    subtype: str | None = Field(None, max_length=50)
    name: str | None = Field(None, max_length=100)
    brand: str | None = Field(None, max_length=100)
    notes: str | None = None
    purchase_date: date | None = None
    purchase_price: Decimal | None = Field(None, ge=0)
    favorite: bool | None = None
    tags: ItemTags | None = None
    colors: list[str] | None = None
    primary_color: str | None = None
    wash_interval: int | None = None
    # 待购 attributes are editable like any other user-maintained field.
    #
    # `ownership` is deliberately NOT here: flipping 待购 → 已拥有 is a state
    # transition with its own idempotency and concurrency rules (保留同一 ID、
    # 重复/并发调用结果稳定), so it lives in `POST /items/{id}/purchase` instead of
    # riding along with a generic attribute patch.
    reference_price: Decimal | None = Field(None, ge=0)
    source_url: str | None = None

    @field_validator("reference_price")
    @classmethod
    def _check_reference_price(cls, value: Decimal | None) -> Decimal | None:
        return validate_reference_price(value)

    @field_validator("source_url")
    @classmethod
    def _check_source_url(cls, value: str | None) -> str | None:
        return validate_source_url(value)


class ItemResponse(ItemBase):
    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode="before")
    @classmethod
    def _surface_failure_reason(cls, data: Any) -> Any:
        # ai_raw_response also carries successful raw model output, so only the
        # error key is lifted out. Without this the UI can only say "Analysis
        # Failed" with no way for the user to tell a bad model name from a
        # dead endpoint.
        raw = (
            data.get("ai_raw_response")
            if isinstance(data, dict)
            else getattr(data, "ai_raw_response", None)
        )
        if isinstance(raw, dict) and raw.get("error"):
            if isinstance(data, dict):
                data["ai_error"] = raw["error"]
            else:
                data.ai_error = raw["error"]
        return data

    id: UUID
    user_id: UUID
    image_path: str
    thumbnail_path: str | None = None
    medium_path: str | None = None
    original_image_path: str | None = None
    tags: dict = Field(default_factory=dict)
    colors: list[str] = Field(default_factory=list)
    primary_color: str | None = None
    pattern: str | None = None
    material: str | None = None
    style: list[str] = Field(default_factory=list)
    formality: str | None = None
    season: list[str] = Field(default_factory=list)
    status: str
    ai_processed: bool = False
    ai_confidence: Decimal | None = None
    ai_description: str | None = None
    ai_error: str | None = None
    ai_started_at: datetime | None = None
    processing_kind: str | None = None
    tagging_status: str = "pending"
    tagged_by: str | None = None
    tagged_at: datetime | None = None
    wear_count: int = 0
    last_worn_at: date | None = None
    last_suggested_at: date | None = None
    suggestion_count: int = 0
    acceptance_count: int = 0
    wears_since_wash: int = 0
    last_washed_at: date | None = None
    wash_interval: int | None = None
    needs_wash: bool = False
    additional_images: list["ItemImageResponse"] = Field(default_factory=list)
    is_archived: bool = False
    archived_at: datetime | None = None
    archive_reason: str | None = None
    # `owned` / `to_buy`. Returned on every item so a client never has to guess an
    # item's side of the wardrobe from the endpoint it came from (`reference_price`
    # and `source_url` are inherited from `ItemBase`).
    ownership: str = "owned"
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def image_url(self) -> str:
        return sign_image_url(self.image_path)

    @computed_field
    @property
    def thumbnail_url(self) -> str | None:
        if self.thumbnail_path:
            return sign_image_url(self.thumbnail_path)
        return None

    @computed_field
    @property
    def medium_url(self) -> str | None:
        if self.medium_path:
            return sign_image_url(self.medium_path)
        return None

    @computed_field
    @property
    def effective_wash_interval(self) -> int:
        if self.wash_interval is not None:
            return self.wash_interval
        return DEFAULT_WASH_INTERVALS.get(self.type, 3)


class AnalysisInProgress(BaseModel):
    item_id: UUID
    name: str | None = None
    type: str
    image_url: str | None = None
    started_at: datetime


class AnalysisCompletion(BaseModel):
    item_id: UUID
    name: str | None = None
    type: str
    duration_seconds: float | None = None
    completed_at: datetime


class AnalysisFailure(BaseModel):
    item_id: UUID
    name: str | None = None
    type: str
    error: str | None = None
    failed_at: datetime | None = None


class TaggingProgressResponse(BaseModel):
    processing: int
    queued: int
    analyzing: int
    failed: int
    completed: int
    total: int
    # Scoped to the run the user is watching rather than the whole wardrobe, so
    # an import into a populated wardrobe reads "1 of 90" instead of opening at
    # 69% and creeping. See get_tagging_progress for how the run is anchored.
    batch_total: int = 0
    batch_completed: int = 0
    batch_failed: int = 0
    current: list[AnalysisInProgress] = Field(default_factory=list)
    recent: list[AnalysisCompletion] = Field(default_factory=list)
    failures: list[AnalysisFailure] = Field(default_factory=list)
    avg_duration_seconds: float | None = None
    eta_seconds: float | None = None
    concurrency: int = 1


class ItemListResponse(BaseModel):
    items: list[ItemResponse]
    total: int
    page: int
    page_size: int
    has_more: bool


class ItemFilter(BaseModel):
    # Which side of the owner's data this query is about. Defaults to `owned`, so
    # every wardrobe list, count and bulk selection written before round 4 keeps
    # returning exactly the garments it used to: 待购 rows are opt-in via an
    # explicit `ownership=to_buy`, and can never leak into 衣橱 by omission.
    ownership: ItemOwnership = ItemOwnership.owned
    type: str | None = None
    subtype: str | None = None
    colors: list[str] | None = None
    status: str | None = None
    tagging_status: str | None = None
    favorite: bool | None = None
    needs_wash: bool | None = None
    is_archived: bool = False
    search: str | None = None
    sort_by: str | None = None
    sort_order: str = "desc"


class LogWearRequest(BaseModel):
    worn_at: date | None = None  # If None, use user's timezone to determine today
    occasion: str | None = None
    notes: str | None = None


class ArchiveRequest(BaseModel):
    reason: str | None = Field(None, max_length=50)


class BulkUploadResult(BaseModel):
    filename: str
    success: bool
    item: ItemResponse | None = None
    error: str | None = None
    duplicate: bool = False
    existing_item_id: UUID | None = None


class BulkUploadResponse(BaseModel):
    total: int
    successful: int
    failed: int
    results: list[BulkUploadResult]


class BulkFilters(BaseModel):
    type: str | None = None
    search: str | None = None
    is_archived: bool | None = None


class BulkSelectionRequest(BaseModel):
    # Explicit selection
    item_ids: list[UUID] | None = None

    # Select all with exceptions
    select_all: bool = False
    excluded_ids: list[UUID] | None = None
    filters: BulkFilters | None = None

    # Cursor into a select_all walk: the id the previous batch stopped at. Bulk
    # actions are capped per request, so a wardrobe larger than the cap is
    # walked batch by batch rather than rejected outright, which is the only
    # option a client holding filters instead of ids has.
    after_id: UUID | None = None

    def model_post_init(self, __context):
        if not self.select_all and not self.item_ids:
            raise ValueError("Either item_ids or select_all=True must be provided")
        if self.select_all and self.item_ids:
            raise ValueError("Cannot use both item_ids and select_all")


class BulkBatchResponse(BaseModel):
    # Set when a select_all walk stopped at the per-request cap; the client
    # repeats the request with after_id=next_cursor until has_more is false.
    next_cursor: UUID | None = None
    has_more: bool = False


class BulkDeleteRequest(BulkSelectionRequest):
    pass


class BulkDeleteResponse(BulkBatchResponse):
    deleted: int
    failed: int
    errors: list[str] = Field(default_factory=list)


class BulkAnalyzeRequest(BulkSelectionRequest):
    pass


class BulkAnalyzeResponse(BulkBatchResponse):
    queued: int
    failed: int
    skipped: int = 0
    cooldown: int = 0
    retry_after_seconds: int | None = None
    errors: list[str] = Field(default_factory=list)


class BulkCancelAnalysisRequest(BulkSelectionRequest):
    pass


class BulkCancelAnalysisResponse(BulkBatchResponse):
    cancelled: int
    skipped: int = 0
    errors: list[str] = Field(default_factory=list)


class BulkRotateRequest(BulkSelectionRequest):
    direction: str = Field(
        "cw",
        pattern="^(cw|ccw)$",
        description="Rotation direction applied to every selected item",
    )


class BulkRotateResponse(BulkBatchResponse):
    queued: int
    failed: int
    skipped: int = 0
    errors: list[str] = Field(default_factory=list)


class BulkRemoveBackgroundRequest(BulkSelectionRequest):
    bg_color: str = Field(
        default="#FFFFFF",
        pattern=r"^#[0-9A-Fa-f]{6}$",
        description="Hex color for the replacement background",
    )


class BulkRemoveBackgroundResponse(BulkBatchResponse):
    queued: int
    failed: int
    skipped: int = 0
    already_done: int = 0
    errors: list[str] = Field(default_factory=list)


class ItemImageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    item_id: UUID
    image_path: str
    thumbnail_path: str | None = None
    medium_path: str | None = None
    position: int
    created_at: datetime

    @computed_field
    @property
    def image_url(self) -> str:
        return sign_image_url(self.image_path)

    @computed_field
    @property
    def thumbnail_url(self) -> str | None:
        if self.thumbnail_path:
            return sign_image_url(self.thumbnail_path)
        return None

    @computed_field
    @property
    def medium_url(self) -> str | None:
        if self.medium_path:
            return sign_image_url(self.medium_path)
        return None


class ReorderImagesRequest(BaseModel):
    image_ids: list[UUID]


class RemoveBackgroundRequest(BaseModel):
    bg_color: str = Field(
        default="#FFFFFF",
        pattern=r"^#[0-9A-Fa-f]{6}$",
        description="Hex color for the replacement background",
    )


class LogWashRequest(BaseModel):
    washed_at: date | None = None  # If None, use user's timezone to determine today
    method: str | None = Field(None, max_length=50)
    notes: str | None = None


class WashHistoryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    item_id: UUID
    washed_at: date
    method: str | None = None
    notes: str | None = None
    created_at: datetime
