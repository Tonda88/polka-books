#!/usr/bin/env python3
"""
Сборщик настоящих книг для «Полки».

Источник: Викитека (ru.wikisource.org) — официальный свободный проект Wikimedia.
Полные тексты выгружаются через сервис Wikisource EPUB export (ws-export.wmcloud.org),
который собирает EPUB из страниц Викитеки, затем распаковываются, очищаются от
служебной разметки и сохраняются в content/books.json:

    { id, title, author, year, genres, tags, description, chapters[], source{} }

Приложение скачивает получившиеся public/library/<id>.json и кладёт в IndexedDB.

Запуск:  python scripts/sync-library.py [--force] [--keep-epub]
Требуется: lxml (есть в окружении DSH).
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from lxml import html as LH

BASE = Path(__file__).resolve().parent.parent
CONTENT = BASE / "content"
CACHE = CONTENT / ".cache" / "epub"
REPORT = CONTENT / "sync-report.txt"
UA = {
    "User-Agent": "PolkaBooksDemo/1.0 (offline public-domain reader; contact: demo@example.org)"
}
EXPORT_BASE = "https://ws-export.wmcloud.org/"
WIKI_BASE = "https://ru.wikisource.org/wiki/"

# --------------------------------------------------------------------------- #
# Каталог источников: какие страницы Викитеки брать и что это за издание.
# --------------------------------------------------------------------------- #
SOURCES = [
    {
        "id": "onegin",
        "page": "Евгений Онегин (Пушкин)/ПСС 1977 (СО)",
        "edition": "Полное собрание сочинений в 10 т., 1977",
        "fallback_pages": [],
        "skip_files": [r"Primecania", r"Glava_10"],
        "drop_patterns": [
            r"^Роман в стихах\.?$",
            r"^Евгений Онегин\.?$",
            r"^Последняя глава «Евгения Онегина»",
        ],
    },
    {
        "id": "pikovaya-dama",
        "page": "Пиковая дама (Пушкин)",
        "edition": "Полное собрание сочинений в 10 т., 1978",
        "fallback_pages": [],
    },
    {
        "id": "geroi-nashego-vremeni",
        "page": "Герой нашего времени (Лермонтов)/1969 (СО)",
        "edition": "Собрание сочинений, 1969",
        "fallback_pages": [
            "Герой нашего времени (Лермонтов)/1938 (СО)",
            "Герой нашего времени (Лермонтов)/СО",
        ],
        "title_overrides": {
            "Примечания к повести": "Предисловие",
            "Предисловие": "Предисловие к журналу Печорина",
        },
        "drop_patterns": [r"^Фаталист\s+[-—]", r"^Печорин\s+[-—]"],
    },
    {
        "id": "shinel",
        "page": "Шинель (Гоголь)/СС 1967 (СО)",
        "edition": "Собрание сочинений, 1967",
        "fallback_pages": ["Шинель (Гоголь)/ПСС 1938 (СО)"],
    },
    {
        "id": "otcy-i-deti",
        "page": "Отцы и дети (Тургенев)",
        "edition": "Викитека: текст по изданию 1960-х гг.",
        "fallback_pages": [],
    },
    {
        "id": "belye-nochi",
        "page": "Белые ночи (Достоевский)",
        "edition": "Викитека: текст по изданию 1970-х гг.",
        "fallback_pages": [],
    },
    {
        "id": "anna-karenina",
        "page": "Анна Каренина (Толстой)",
        "edition": "ФЭБ / Наука, 1970",
        "fallback_pages": [],
    },
    {
        "id": "chelovek-v-futlyare",
        "page": "Человек в футляре (Чехов)",
        "edition": "ПСС в 30 т., Наука, 1977",
        "fallback_pages": [],
    },
    {
        "id": "dama-s-sobachkoy",
        "page": "Дама с собачкой (Чехов)",
        "edition": "ПСС в 30 т., Наука, 1977",
        "fallback_pages": [],
    },
    {
        "id": "granatovyy-braslet",
        "page": "Гранатовый браслет (Куприн)",
        "edition": "Викитека: текст по изданию 1970-х гг.",
        "fallback_pages": [],
    },
    {
        "id": "tyomnye-allei",
        "page": "Тёмные аллеи (Бунин)",
        "edition": "Библиотека всемирной литературы, 1973",
        "fallback_pages": [],
    },
    {
        "id": "levsha",
        "page": "Левша (Лесков)/ПСС 1902—1903 (ВТ:Ё)",
        "edition": "Полное собрание сочинений, 1902—1903",
        "fallback_pages": ["Левша (Лесков)/ПСС 1902—1903 (ВТ)"],
        "drop_patterns": [r"^\(Сказ о тульском косом Левше и о стальной блохе\.?\)$", r"^ЛЕВША\.?$"],
    },
    {
        "id": "medny-vsadnik",
        "page": "Медный всадник (Пушкин)",
        "edition": "Викитека: текст по академическому изданию",
        "fallback_pages": [],
        "drop_patterns": [r"^Петербургская повесть\.?$"],
        "meta": {
            "title": "Медный всадник",
            "author": "Александр Пушкин",
            "year": 1833,
            "genres": ["поэма", "классика", "история", "философия"],
            "tags": ["Петербург", "наводнение", "памятник", "безумие", "любовь"],
            "description": (
                "Петербургская повесть о наводнении 1824 года, бедном чиновнике Евгении и бронзовом "
                "всаднике — памятнике, который оживает в его бреду. Одна из самых загадочных поэм Пушкина."
            ),
        },
    },
    {
        "id": "mcyri",
        "page": "Мцыри (Лермонтов)",
        "edition": "Викитека: текст по академическому изданию",
        "fallback_pages": [],
        "merge_all": True,
        "meta": {
            "title": "Мцыри",
            "author": "Михаил Лермонтов",
            "year": 1840,
            "genres": ["поэма", "классика", "романтика"],
            "tags": ["Кавказ", "монастырь", "свобода", "побег", "одиночество"],
            "description": (
                "Исповедь юного послушника, бежавшего из грузинского монастыря на волю. История о жажде "
                "жизни, родине и цене свободы — самая романтическая поэма Лермонтова."
            ),
        },
    },
]

SKIP_TAGS = {"script", "style", "sup", "figure", "img", "nav", "noscript", "audio", "video"}
SKIP_IDS = {"headertemplate", "sub_nav", "toc"}
NOTES_RE = re.compile(
    r"^\s*(примечания|комментарии|библиография|список литературы|источники|примечания редакторов)",
    re.I,
)
CREDIT_RE = re.compile(
    r"(https?://|публичная электронная библиотека|экспортировано из викитеки|об этом электронном издании|wikimedia|wsexport|источник:)",
    re.I,
)
ROMAN_RE = re.compile(r"^[IVXLC]+\.?$")
# Служебные хвосты изданий: даты, «Конец», библиографические справки.
SERVICE_TAIL_RE = re.compile(
    r"^\s*("
    r"Конец\.?|"
    r"\*+\s*старая\s+орфография|"
    r"\d{4}(\s*[—–-]\s*\d{4})?\.?|"
    r"Впервые\s+напечатано.*|"
    r"Версия\s+\d.*|"
    r"\d{1,2}\s+[а-яё]+\s+\d{4}\.?|"
    r".*Сверка\s+произведена.*|"
    r".*изд-?во\s.*|"
    r".*издательств\w*\s.*|"
    r"Источник:.*|"
    r"Примечания\s+к\s+.*"
    r")\s*$",
    re.I | re.S,
)
# Строки-маркеры вики-разметки внутри <pre>: '''Конец''', '''Примечания к повести'''.
WIKI_MARK_RE = re.compile(r"^\s*'{3,}\s*(.*?)\s*'{3,}\s*$")
# Блок сносок в конце повести: «1 серо-жемчужного цвета (франц.).», «5 Гурда - ...».
NOTE_ITEM_RE = re.compile(r"^\d{1,2}\s+(?=[а-яёА-ЯЁ«\"(])", re.I)
TRANSLATION_RE = re.compile(r"\((?:франц|итал|нем|англ|лат|греч|польск)\.\s?\)", re.I)


def is_note_block(paragraph: str) -> bool:
    """Похож ли абзац на издательские сноски/примечания, а не на текст."""
    text = paragraph.strip()
    if not text:
        return False
    if NOTE_ITEM_RE.match(text):
        return True
    if TRANSLATION_RE.search(text) and len(text) < 1200:
        return True
    return False


def is_notes_heading(text: str) -> bool:
    return bool(re.match(r"^\s*Примечания\b", text, re.I)) or bool(NOTES_RE.match(text.strip()))


def log(lines: list[str], text: str = "") -> None:
    lines.append(text)
    print(text, flush=True)


# --------------------------------------------------------------------------- #
# Загрузка EPUB
# --------------------------------------------------------------------------- #
def export_url(page: str) -> str:
    return EXPORT_BASE + "?" + urllib.parse.urlencode({"lang": "ru", "format": "epub", "page": page})


def page_url(page: str) -> str:
    return WIKI_BASE + urllib.parse.quote(page.replace(" ", "_"))


def download_epub(book_id: str, page: str, force: bool) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{book_id}.epub"
    if path.exists() and path.stat().st_size > 100_000 and not force:
        return path.read_bytes()
    url = export_url(page)
    last_error = "unknown"
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(request, timeout=240) as response:
                content_type = response.headers.get("content-type", "")
                data = response.read()
            if "epub" not in content_type or len(data) < 100_000:
                raise RuntimeError(f"сервис вернул {content_type}, {len(data)} байт")
            path.write_bytes(data)
            return data
        except Exception as error:  # noqa: BLE001 - нужен перебор кандидатов
            last_error = str(error)
            time.sleep(3 + attempt * 3)
    raise RuntimeError(f"не удалось скачать EPUB «{page}»: {last_error}")


# --------------------------------------------------------------------------- #
# Разбор HTML из EPUB
# --------------------------------------------------------------------------- #
def local_name(element) -> str:
    tag = element.tag if isinstance(element.tag, str) else ""
    return tag.rsplit("}", 1)[-1].lower() if tag else ""


def class_list(element) -> list[str]:
    return (element.get("class") or "").split()


def clean_line(text: str) -> str:
    text = (
        text.replace("\u00a0", " ")
        .replace("\u200e", "")
        .replace("\u200f", "")
        .replace("\u2028", " ")
        .replace("\u00ad", "")
    )
    text = re.sub(r"\[\s*(?:\*|\d+)\s*\]", "", text)
    text = re.sub(r"\[\d+\]", "", text)
    text = text.replace("↑", "")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    return text.strip()


def text_with_breaks(element) -> str:
    """Текст блока с сохранением переносов <br> (нужно для стихов)."""
    parts: list[str] = []

    def walk(node) -> None:
        tag = local_name(node)
        if tag in SKIP_TAGS:
            return
        if tag == "br":
            parts.append("\n")
            return
        if node.text:
            parts.append(node.text)
        for child in node.iterchildren():
            walk(child)
            if child.tail:
                parts.append(child.tail)

    walk(element)
    raw = "".join(parts).replace("\r\n", "\n").replace("\r", "\n")
    lines = [clean_line(line) for line in raw.split("\n")]
    lines = [line for line in lines if line]
    return "\n".join(lines)


def inline_text(element) -> str:
    return " ".join(part for part in text_with_breaks(element).split("\n") if part)


def pre_text(element) -> str:
    """Текст <pre> с сохранением пустых строк."""
    parts: list[str] = []

    def walk(node) -> None:
        tag = local_name(node)
        if tag in SKIP_TAGS:
            return
        if tag == "br":
            parts.append("\n")
            return
        if node.text:
            parts.append(node.text)
        for child in node.iterchildren():
            walk(child)
            if child.tail:
                parts.append(child.tail)

    walk(element)
    return "".join(parts).replace("\r\n", "\n").replace("\r", "\n")


def pre_paragraphs(element) -> tuple[list[str], bool]:
    """Wikisource иногда отдаёт прозу в <pre> с жёсткими переносами строк.

    Разделяем абзацы по пустым строкам, а если их нет — по коротким строкам
    (в жёстко свёрстанном тексте абзац заканчивается неполной строкой).
    Затем склеиваем строки абзаца обратно в сплошной текст.

    Возвращает (абзацы, встретились_ли_примечания): строки вида
    '''Примечания к повести''' означают конец художественного текста.
    """
    text = pre_text(element)
    result: list[str] = []
    stopped = False

    def flush(lines: list[str]) -> None:
        cleaned = [clean_line(line) for line in lines]
        cleaned = [line for line in cleaned if line]
        if cleaned:
            result.append(" ".join(cleaned))

    for block in re.split(r"\n\s*\n", text):
        if stopped:
            break
        lines = text.split("\n") if block is text else block.split("\n")
        lines = [clean_line(line) for line in lines]
        lines = [line for line in lines if line]
        if not lines:
            continue

        average = sum(len(line) for line in lines) / len(lines)
        if len(lines) > 1 and average > 45:
            paragraph: list[str] = []
            for line in lines:
                mark = WIKI_MARK_RE.match(line)
                if mark:
                    if is_notes_heading(mark.group(1).strip()):
                        stopped = True
                        break
                    # Служебный маркер («Конец», «Конец первой части») — пропускаем.
                    continue
                if is_notes_heading(line):
                    stopped = True
                    break
                paragraph.append(line)
                if len(line) < 58:
                    flush(paragraph)
                    paragraph = []
            if paragraph:
                flush(paragraph)
        else:
            keep: list[str] = []
            for line in lines:
                mark = WIKI_MARK_RE.match(line)
                if mark:
                    if is_notes_heading(mark.group(1).strip()):
                        stopped = True
                        break
                    continue
                if is_notes_heading(line):
                    stopped = True
                    break
                keep.append(line)
            if keep:
                result.append("\n".join(keep))
    return result, stopped


def parse_blocks(html_bytes: bytes) -> list[tuple[str, str]]:
    """Превращает XHTML страницы в последовательность блоков примечаний/абзацев."""
    try:
        document = LH.fromstring(html_bytes)
    except Exception:  # noqa: BLE001
        return []
    body = document.find("body")
    if body is None:
        return []
    for bad in body.xpath(
        "//script|//style|//sup|//figure|//img|//nav|//noscript"
        "|//*[contains(@class,'references')]|//*[contains(@class,'mw-references')]"
        "|//*[contains(@class,'linenum')]|//*[contains(@class,'mw-editsection')]"
    ):
        parent = bad.getparent()
        if parent is not None:
            parent.remove(bad)

    blocks: list[tuple[str, str]] = []
    stopped = False

    def stop() -> None:
        nonlocal stopped
        stopped = True

    def handle_heading(element) -> None:
        text = inline_text(element)
        text = text.rstrip(".").strip()
        if not text:
            return
        if NOTES_RE.match(text) and blocks:
            stop()
            return
        blocks.append(("heading", text))

    def walk(element) -> None:
        nonlocal stopped
        for child in element.iterchildren():
            if stopped:
                return
            tag = local_name(child)
            if tag in SKIP_TAGS:
                continue
            ident = child.get("id") or ""
            if ident in SKIP_IDS or ident.startswith(("headertemplate", "sub_nav", "toc")):
                continue
            classes = class_list(child)

            if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
                handle_heading(child)
                continue
            if "title" in classes and tag in ("div", "p"):
                handle_heading(child)
                continue
            if "poem-section" in classes:
                text = inline_text(child).strip()
                if text:
                    if NOTES_RE.match(text):
                        stop()
                    else:
                        blocks.append(("poem_section", text))
                continue
            if "poem" in classes and tag == "div":
                for inner in child.iterchildren():
                    inner_tag = local_name(inner)
                    inner_classes = class_list(inner)
                    if inner_tag == "p":
                        text = text_with_breaks(inner)
                        if text:
                            blocks.append(("verse", text))
                    elif "poem-section" in inner_classes:
                        text = inline_text(inner).strip()
                        if text:
                            blocks.append(("poem_section", text))
                    elif inner_tag == "div" and "poem" in inner_classes:
                        walk(inner)
                continue
            if tag == "p":
                style = (child.get("style") or "").replace(" ", "").lower()
                text = text_with_breaks(child)
                if text:
                    if ROMAN_RE.match(text) and "text-align:center" in style:
                        blocks.append(("heading", f"Глава {text.strip('.')}"))
                    else:
                        blocks.append(("para", text))
                continue
            if tag == "pre":
                paragraphs, has_notes = pre_paragraphs(child)
                for paragraph in paragraphs:
                    blocks.append(("para", paragraph))
                if has_notes:
                    stop()
                continue
            if tag in ("blockquote", "ul", "ol"):
                if tag in ("ul", "ol"):
                    for item in child.iterchildren():
                        text = text_with_breaks(item)
                        if text:
                            blocks.append(("para", text))
                else:
                    walk(child)
                continue

            has_block_children = any(
                local_name(descendant) in ("p", "div", "section", "h1", "h2", "h3", "blockquote", "ol", "ul")
                for descendant in child.iterdescendants()
            )
            if has_block_children:
                walk(child)
            else:
                text = text_with_breaks(child)
                if text:
                    style = (child.get("style") or "").replace(" ", "").lower()
                    if ROMAN_RE.match(text) and "text-align:center" in style:
                        blocks.append(("heading", f"Глава {text.strip('.')}"))
                    else:
                        blocks.append(("para", text))

    walk(body)
    return blocks


# --------------------------------------------------------------------------- #
# Сборка глав
# --------------------------------------------------------------------------- #
def is_notes_title(title: str) -> bool:
    return bool(NOTES_RE.match(title.strip()))


def clean_heading(title: str) -> str:
    title = clean_line(title)
    title = re.sub(r"\s+", " ", title).strip(" .")
    # «ГЛАВА ВОСЬМАЯ» → «Глава восьмая»
    if re.fullmatch(r"ГЛАВА\s+[А-ЯЁA-Z]+", title):
        title = "Глава " + title.split(None, 1)[1].lower()
    return title


def looks_like_chapter_number(title: str) -> bool:
    return bool(ROMAN_RE.match(title.strip(" ."))) or bool(re.fullmatch(r"(глава\s*)?\d+", title.strip(), re.I))


def title_from_filename(filename: str) -> str | None:
    name = filename.rsplit("/", 1)[-1]
    match = re.search(r"__Cast__([IVXLC]+)_Glava_([IVXLC]+)", name)
    if match:
        return f"Часть {match.group(1)}. Глава {match.group(2)}"
    match = re.search(r"Glava_([IVXLC]+|\d+)", name)
    if match:
        return f"Глава {match.group(1)}"
    return None


def build_chapters(blocks: list[tuple[str, str]], default_title: str, work_title: str) -> list[dict]:
    chapters: list[dict] = []
    current_title = default_title or work_title
    current_paragraphs: list[str] = []
    intro_paragraphs: list[str] = []
    seen_heading = False

    def flush() -> None:
        nonlocal current_paragraphs
        if current_paragraphs:
            chapters.append({"title": current_title, "paragraphs": current_paragraphs})
            current_paragraphs = []

    for kind, text in blocks:
        if kind in ("heading", "poem_section"):
            title = clean_heading(text)
            if not title:
                continue
            if is_notes_title(title):
                # Примечания/комментарии — это аппарат издания, но в начале
                # книги такой заголовок может быть авторским предисловием.
                if chapters or current_paragraphs or intro_paragraphs:
                    break
                seen_heading = True
                current_title = title
                continue
            if kind == "poem_section" and re.fullmatch(r"[\sIVXLC\d.*\-–—…]+", title):
                # Номер строфы, пометка пропущенной строфы или разделитель.
                continue
            if title.casefold() == work_title.casefold() or title.casefold() in (
                "содержание",
                "оглавление",
                "титульный лист",
            ):
                continue
            # Первый заголовок: если до него был короткий эпиграф — приклеиваем к главе.
            if not seen_heading:
                seen_heading = True
                if intro_paragraphs:
                    current_paragraphs.extend(intro_paragraphs)
                    intro_paragraphs = []
                flush()
            else:
                flush()
            current_title = title
        else:
            if not seen_heading:
                intro_paragraphs.append(text)
                # Слишком длинный текст до первого заголовка — это уже глава без названия.
                if sum(len(p) for p in intro_paragraphs) > 1200:
                    seen_heading = True
                    current_paragraphs = intro_paragraphs
                    intro_paragraphs = []
            else:
                current_paragraphs.append(text)

    flush()
    if not chapters:
        if intro_paragraphs:
            chapters.append({"title": default_title or work_title, "paragraphs": intro_paragraphs})
        elif current_paragraphs:
            chapters.append({"title": default_title or work_title, "paragraphs": current_paragraphs})
    return chapters


def split_long_prose(text: str, limit: int = 1400) -> list[str]:
    """Режет чрезмерно длинный абзац по границам предложений.

    Некоторые издания в Викитеке отдают целые страницы одним <p>; для читалки
    это неудобно, поэтому делим такой абзац на смысловые части.
    """
    if len(text) <= limit or "\n" in text:
        return [text]
    sentences = re.split(r"(?<=[.!?…])\s+", text)
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        candidate = f"{current} {sentence}".strip() if current else sentence
        if current and len(candidate) > limit:
            chunks.append(current)
            current = sentence
        else:
            current = candidate
    if current:
        chunks.append(current)
    return [chunk for chunk in chunks if chunk.strip()]


def section_paragraphs(paragraphs: list[str], work_title: str = "", drop_patterns: list[str] | None = None) -> list[str]:
    """Чистка абзацев от служебных вставок и мусора."""
    result: list[str] = []
    normalized_title = re.sub(r"[\s«»\"'.,:;!?—–-]+", " ", work_title).strip().casefold()
    patterns = [re.compile(pattern, re.I) for pattern in (drop_patterns or [])]
    for paragraph in paragraphs:
        paragraph = paragraph.strip("\n")
        if not paragraph:
            continue
        # Убираем случайно попавшую HTML-разметку и ссылки на примечания.
        paragraph = re.sub(r"<[^>]{0,200}>", " ", paragraph)
        lines = [clean_line(line) for line in paragraph.split("\n")]
        lines = [line for line in lines if line]
        if not lines:
            continue
        paragraph = "\n".join(lines)
        if CREDIT_RE.search(paragraph) and len(paragraph) < 400:
            continue
        if re.search(r"\(Прим\.\s*[А-ЯЁA-Z][а-яёa-z]+\.?\)", paragraph):
            # Издательские сноски вида «(Прим. Лермонтова.)».
            continue
        if re.search(
            r"Письменные работы могут быть включены|вы можете отредактировать|Источник текста не указан"
            r"|серьёзные ошибки|Внимание!|Викитека|Википеди",
            paragraph,
            re.I,
        ):
            continue
        if re.fullmatch(r"(глава\s+)?[IVXLC\d]+\.?", paragraph.strip(), re.I):
            continue
        if re.fullmatch(r"ГЛАВА\s+[А-ЯЁA-Z]+\.?", paragraph.strip()):
            # Заголовок главы, попавший в текст абзацем.
            continue
        if re.fullmatch(r"[.\s…·*]+", paragraph):
            # Пометки пропущенных строф вида «..................».
            continue
        normalized = re.sub(r"[\s«»\"'.,:;!?—–-]+", " ", paragraph).strip().casefold()
        if normalized_title and normalized == normalized_title:
            continue
        if any(pattern.match(paragraph.strip()) for pattern in patterns):
            continue
        if re.fullmatch(r"[\s\-—–•·*]+", paragraph):
            continue
        # Служебные строки издания: даты, «Конец», библиография, «* старая орфография».
        if SERVICE_TAIL_RE.match(paragraph.strip()):
            continue
        if re.fullmatch(r"\*{0,3}\s*старая\s+орфография\s*", paragraph.strip(), re.I):
            continue
        # Блоки сносок в конце глав («1 серо-жемчужного цвета (франц.).»).
        if is_note_block(paragraph):
            continue
        # Вики-разметка '''…''' могла остаться внутри абзаца.
        paragraph = re.sub(r"'{3,}", "", paragraph).strip()
        if not paragraph:
            continue
        result.extend(split_long_prose(paragraph))
    return result


def trim_service_tail(paragraphs: list[str]) -> list[str]:
    """Убирает служебный «хвост» в конце главы (даты, «Конец», справки об издании)."""
    while len(paragraphs) > 2:
        tail = paragraphs[-1].strip()
        if len(tail) < 400 and SERVICE_TAIL_RE.match(tail):
            paragraphs.pop()
            continue
        if is_note_block(tail):
            paragraphs.pop()
            continue
        break
    # Год выпуска, приклеенный к последней строке стихотворения: «...ради Бога. 1833»
    if paragraphs:
        cleaned = re.sub(r"\s+(1[6-9]\d{2}|20\d{2})\.?$", "", paragraphs[-1])
        if cleaned != paragraphs[-1]:
            paragraphs[-1] = cleaned
            if not cleaned.strip():
                paragraphs.pop()
    return paragraphs


def parse_epub(book_id: str, data: bytes, work_title: str, source: dict, nav_titles: dict[str, str]) -> list[dict]:
    archive = zipfile.ZipFile(io.BytesIO(data))
    names = archive.namelist()
    content_files: list[tuple[int, str]] = []
    for name in names:
        match = re.search(r"/c(\d+)_", name)
        if match and name.lower().endswith((".xhtml", ".html", ".htm")):
            content_files.append((int(match.group(1)), name))
    content_files.sort()

    skip_patterns = [re.compile(pattern) for pattern in source.get("skip_files", [])]
    chapters: list[dict] = []
    multi_file = len(content_files) > 1
    first_index = content_files[0][0] if content_files else -1

    for index, name in content_files:
        if any(pattern.search(name) for pattern in skip_patterns):
            continue
        try:
            html_bytes = archive.read(name)
        except KeyError:
            continue
        blocks = parse_blocks(html_bytes)
        if not blocks:
            continue

        nav_title = ""
        for href, title in nav_titles.items():
            if href.rsplit("#", 1)[0] == name.rsplit("/", 1)[-1] or href.endswith(name.rsplit("/", 1)[-1]):
                nav_title = title
                break
        # Первый файл многотомной выгрузки — титул/оглавление, а не глава.
        if multi_file and index == first_index and (
            not nav_title or nav_title.casefold() == work_title.casefold()
        ):
            continue
        default_title = nav_title if nav_title and not looks_like_chapter_number(nav_title) else ""
        derived = title_from_filename(name)
        file_chapters = build_chapters(blocks, default_title or derived or "", work_title)

        # Заголовок из nav/файла, если внутри файла не нашлось своего.
        for chapter in file_chapters:
            if not chapter["title"] and derived:
                chapter["title"] = derived
            if looks_like_chapter_number(chapter["title"]) or not chapter["title"]:
                chapter["title"] = derived or title_from_filename(name) or (
                    f"Глава {chapter['title']}" if chapter["title"] else f"Часть {index}"
                )
            chapter["paragraphs"] = trim_service_tail(
                section_paragraphs(chapter["paragraphs"], work_title, source.get("drop_patterns", []))
            )
            paragraphs = chapter["paragraphs"]
            title = chapter["title"]
            title_overrides = source.get("title_overrides", {})
            title = title_overrides.get(title, title)
            chapter["title"] = title
            # Иногда заголовок главы дублируется первым абзацем.
            while paragraphs and re.sub(r"\s+", " ", paragraphs[0]).strip().casefold() == title.casefold():
                paragraphs.pop(0)
            if len(paragraphs) == 0:
                continue
            # Склеиваем совсем короткие фрагменты с предыдущей главой.
            if len(chapters) and sum(len(p) for p in paragraphs) < 80:
                chapters[-1]["paragraphs"].extend(paragraphs)
                continue
            chapters.append({"title": title, "paragraphs": paragraphs})

    # У одной-страничных произведений nav может ссылаться на ту же страницу.
    if not chapters:
        raise RuntimeError(f"{book_id}: EPUB не дал текста")
    # Короткий титульный фрагмент в начале (подзаголовок, эпиграф) — в первую главу.
    if len(chapters) > 1 and sum(len(p) for p in chapters[0]["paragraphs"]) < 120:
        chapters[1]["paragraphs"] = chapters[0]["paragraphs"] + chapters[1]["paragraphs"]
        chapters.pop(0)
    if source.get("merge_all"):
        paragraphs = [paragraph for chapter in chapters for paragraph in chapter["paragraphs"]]
        chapters = [{"title": work_title, "paragraphs": paragraphs}]
    return chapters


def load_metadata() -> dict:
    meta: dict[str, dict] = {}
    books_path = CONTENT / "books.json"
    if books_path.exists():
        try:
            for book in json.loads(books_path.read_text(encoding="utf-8")):
                meta[book["id"]] = {
                    key: book[key]
                    for key in ("title", "author", "year", "genres", "tags", "description")
                    if key in book
                }
        except Exception:  # noqa: BLE001
            pass
    for source in SOURCES:
        if "meta" in source:
            meta[source["id"]] = dict(source["meta"])
    if meta:
        (CONTENT / "metadata.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return meta


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="заново скачать EPUB")
    parser.add_argument("--keep-epub", action="store_true", help="оставить EPUB в кэше")
    args = parser.parse_args()

    metadata = load_metadata()
    report: list[str] = []
    books: list[dict] = []
    provenance: list[dict] = []
    errors: list[str] = []

    for source in SOURCES:
        book_id = source["id"]
        meta = metadata.get(book_id)
        if not meta:
            errors.append(f"{book_id}: нет метаданных (title/author/description)")
            continue
        page = source["page"]
        candidates = [page] + source.get("fallback_pages", [])
        epub_data = None
        used_page = page
        for candidate in candidates:
            try:
                epub_data = download_epub(book_id, candidate, args.force)
                used_page = candidate
                break
            except Exception as error:  # noqa: BLE001
                report.append(f"  ! {book_id}: {candidate} — {error}")
        if not epub_data:
            errors.append(f"{book_id}: не удалось скачать ни один вариант страницы")
            continue

        archive = zipfile.ZipFile(io.BytesIO(epub_data))
        nav_titles: dict[str, str] = {}
        nav_name = next((name for name in archive.namelist() if name.endswith("nav.xhtml")), None)
        if nav_name:
            nav_doc = LH.fromstring(archive.read(nav_name))
            for link in nav_doc.xpath("//a[@href]"):
                nav_titles[link.get("href")] = " ".join(link.text_content().split())
        work_title = meta.get("title", book_id)
        try:
            chapters = parse_epub(book_id, epub_data, work_title, source, nav_titles)
        except Exception as error:  # noqa: BLE001
            errors.append(f"{book_id}: разбор EPUB — {error}")
            continue

        words = sum(
            len(paragraph.split()) for chapter in chapters for paragraph in chapter["paragraphs"]
        )
        if words < 300:
            errors.append(f"{book_id}: подозрительно мало текста ({words} слов)")
            continue

        is_verse = any(re.search(r"поэз|поэма", genre) for genre in meta.get("genres", []))
        pages = max(16, round(words / (75 if is_verse else 300)))
        minutes = max(8, round(words / (60 if is_verse else 100)))
        source_info = {
            "name": "Викитека",
            "site": "ru.wikisource.org",
            "page": used_page,
            "url": page_url(used_page),
            "edition": source.get("edition", ""),
            "license": "Текст — общественное достояние; оформление Викитеки — CC BY-SA",
            "retrievedAt": time.strftime("%Y-%m-%d"),
        }
        book = {
            "id": book_id,
            "title": meta["title"],
            "author": meta["author"],
            "year": meta.get("year", 1900),
            "genres": meta.get("genres", []),
            "tags": meta.get("tags", []),
            "description": meta.get("description", ""),
            "pages": pages,
            "minutes": minutes,
            "chapters": chapters,
            "source": source_info,
        }
        books.append(book)
        provenance.append({**source_info, "id": book_id, "title": meta["title"], "authors": meta["author"], "words": words})
        report.append(
            f"✓ {book_id:<22} глав: {len(chapters):<4} слов: {words:<7} "
            f"стр.: {pages:<5} мин: {minutes:<5} | {used_page}"
        )
        log(report)
        first = chapters[0]["paragraphs"][0].replace("\n", " ")[:110]
        log(report, f"    «{first}…»")

    if errors:
        log(report, "\nОШИБКИ:")
        for error in errors:
            log(report, "  ✗ " + error)
        (CONTENT / "sync-report.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
        return 1

    if len(books) != len(SOURCES):
        log(report, f"Собрано {len(books)} из {len(SOURCES)} книг")
        return 1

    (CONTENT / "books.json").write_text(
        json.dumps(books, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    (CONTENT / "sources.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    total_words = sum(item["words"] for item in provenance)
    log(report, f"\nИтого: {len(books)} книг, {total_words:,} слов, источники — content/sources.json".replace(",", " "))
    (CONTENT / "sync-report.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
    if not args.keep_epub and CACHE.exists():
        shutil.rmtree(CACHE, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
