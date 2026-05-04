from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.services.offers import build_nbo_docx


router = APIRouter()


class ParagraphUpdate(BaseModel):
    index: int
    text: str = ""
    segments: list[dict[str, Any]] = Field(default_factory=list)


class TableUpdate(BaseModel):
    table: int
    row: int
    col: int
    text: str


class TableColumnRemoval(BaseModel):
    table: int
    col: int


class NboRequest(BaseModel):
    template_name: str = "NBO_PV_Template.docx"
    filename: str = "REVEAL_NBO.docx"
    replacements: dict[str, str] = Field(default_factory=dict)
    paragraph_updates: list[ParagraphUpdate] = Field(default_factory=list)
    table_updates: list[TableUpdate] = Field(default_factory=list)
    paragraph_deletions: list[int] = Field(default_factory=list)
    table_column_removals: list[TableColumnRemoval] = Field(default_factory=list)


@router.post("/offers/nbo")
async def generate_nbo(payload: NboRequest):
    try:
        content = build_nbo_docx(
            template_name=payload.template_name,
            replacements=payload.replacements,
            paragraph_updates=[item.model_dump() for item in payload.paragraph_updates],
            table_updates=[item.model_dump() for item in payload.table_updates],
            paragraph_deletions=payload.paragraph_deletions,
            table_column_removals=[item.model_dump() for item in payload.table_column_removals],
        )

        return StreamingResponse(
            iter([content]),
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f'attachment; filename="{payload.filename}"'},
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc
