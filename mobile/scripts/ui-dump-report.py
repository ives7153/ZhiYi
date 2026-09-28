#!/usr/bin/env python3
"""Parse a `uiautomator dump` XML file into readable text and machine-readable facts.

    ui-dump-report.py <dump.xml> [<out_dir>]

With <out_dir> it also writes <out_dir>/<stem>.txt — the human-readable node list
that the acceptance run is read from.

On stdout it always prints these lines, which the shell harness asserts on:

    PKGS=com.zhiyi.wardrobe          packages that own the dumped nodes
    NODES=123                        total nodes
    TEXTS=45                         nodes carrying text or a content description
    ROTATION=0                       screen rotation as reported by the dump
    SIG=登录,衣橱                     known 知衣 copy found in the dump
    SCREEN=登录页                     which 知衣 screen is showing
    PARSE_ERROR ...                  the XML could not be parsed (exit 1)

SIG/SCREEN exist so a scenario can prove it is looking at the app and not at a system
dialog or the launcher. Text is matched against the strings the app itself renders, so
the check fails loudly if the dump is a blank React view.
"""

import sys
import xml.etree.ElementTree as ET

# Copy only this app renders. Extend it when a new screen needs an assertion.
SIGNATURES = [
    "登录",
    "衣橱",
    "单品详情",
    "添加单品",
    "搭配",
    "待购",
    "我的",
    "衣柜中有",
    # round-2 add-item flow
    "从相册选择",
    "拍照",
    "衣物信息",
    "还没有选择照片",
    # round-3 slot outfits
    "按席位各选一件，保存成一套搭配",
    "席位",
    "上衣",
    "下装",
    "外套",
    "鞋子",
    "配饰",
    "保存搭配",
    "已保存搭配",
    "搭配名称",
    "选择单品",
    "编辑搭配",
    "删除搭配",
]

# Distinguishing text for each screen, most specific first.
#
# Each entry is (label, needle) matched against the dump's text values.
# Order matters: the add screen also contains 添加单品 as its own header, so the more
# specific needle has to be tested first or every add screen would be reported as 衣橱页.
# The same applies to the outfits screens — the 搭配 screen carries the 保存搭配 button while
# 已保存搭配 is its own screen, and both live under the 搭配 tab.
SCREENS = [
    ("登录页", "登录以管理你的衣橱"),
    ("添加单品页", "拍照或从相册选择衣物图片"),
    ("添加单品页", "还没有选择照片"),
    ("单品详情", "单品详情"),
    # Round 3. The picker sheet is a Modal on top of the builder, so it is tested before it:
    # its title is unique (选择单品 is not part of the builder's copy).
    ("搭配选择面板", "取消后保持原来的选择"),
    ("搭配页", "按席位各选一件，保存成一套搭配"),
    ("已保存搭配", "还没有保存过搭配"),
    ("已保存搭配", "搜索搭配..."),
    # Matched exactly, like every other needle (the comparison is list membership, not a
    # substring search), so this uses the 单品 section title that sits directly under the title.
    # 编辑搭配 alone was not enough: with twenty garments it is pushed far below the fold and
    # never reaches the dump, which made the detail screen read as 未识别.
    ("搭配详情", "单品"),
    ("搭配详情", "编辑搭配"),
    ("衣橱页", "衣柜中有"),
    ("衣橱页", "衣橱"),
]


def find_bounds(root, label):
    """Bounds of the best node matching `label`.

    Preference order matters for tapping. On the 知衣 login screen the string 登录 appears
    twice: as the disabled title TextView at [477,705][602,798] and as the actual submit
    button at [503,1682][577,1736] (a child of a clickable Button). Returning document order
    would tap the title, i.e. do nothing. So clickable nodes win, and among those the most
    specific (deepest) one wins — the clickable Button rather than its ancestor FrameLayout.
    """
    exact = [
        node
        for node in root.iter("node")
        if (node.get("text") or "").strip() == label
        or (node.get("content-desc") or "").strip() == label
    ]
    if not exact:
        return None

    # Clickability is the property that matters; among clickable candidates prefer the one
    # with the smallest area, which is the innermost real control rather than its wrapper.
    clickable = [n for n in exact if n.get("clickable") == "true"]
    pool = clickable or exact

    def area(node):
        digits = node.get("bounds", "").replace("][", ",").strip("[]").split(",")
        try:
            x1, y1, x2, y2 = (int(v) for v in digits)
        except ValueError:
            return float("inf")
        return (x2 - x1) * (y2 - y1)

    return min(pool, key=area).get("bounds")


def main(argv):
    if len(argv) < 2:
        print("usage: ui-dump-report.py <dump.xml> [<out_dir>]", file=sys.stderr)
        print("       ui-dump-report.py --find <label> <dump.xml>", file=sys.stderr)
        return 2

    # --find is what `device-prep.sh tap-text` uses: resolve a label to bounds without
    # hardcoding screen coordinates that break at a different density or font scale.
    if argv[1] == "--find":
        if len(argv) < 4:
            print("usage: ui-dump-report.py --find <label> <dump.xml>", file=sys.stderr)
            return 2
        label, xml_path = argv[2], argv[3]
        try:
            root = ET.parse(xml_path).getroot()
        except (ET.ParseError, OSError) as exc:
            print(f"PARSE_ERROR {exc}", file=sys.stderr)
            return 1
        bounds = find_bounds(root, label)
        if bounds is None:
            return 1
        print(bounds)
        return 0

    xml_path = argv[1]
    out_dir = argv[2] if len(argv) > 2 else None

    try:
        root = ET.parse(xml_path).getroot()
    except (ET.ParseError, OSError) as exc:
        print(f"PARSE_ERROR {exc}")
        return 1

    nodes = list(root.iter("node"))

    def text_of(node):
        return (node.get("text") or "").strip()

    def desc_of(node):
        return (node.get("content-desc") or "").strip()

    packages = sorted({n.get("package") for n in nodes if n.get("package")})
    texts = [text_of(n) for n in nodes]
    descs = [desc_of(n) for n in nodes]

    hits = [s for s in SIGNATURES if s in texts or s in descs]

    screen = "未识别"
    for label, needle in SCREENS:
        if needle in texts:
            screen = label
            break

    if out_dir:
        import os

        os.makedirs(out_dir, exist_ok=True)
        stem = os.path.splitext(os.path.basename(xml_path))[0]
        with open(os.path.join(out_dir, f"{stem}.txt"), "w", encoding="utf-8") as fh:
            fh.write(f"packages: {packages}\n")
            fh.write(f"rotation: {root.get('rotation')}\n")
            fh.write(f"signatures: {hits}\n")
            fh.write(f"screen: {screen}\n\n")
            for n in nodes:
                t, d = text_of(n), desc_of(n)
                if not t and not d:
                    continue
                cls = n.get("class", "").split(".")[-1]
                fh.write(
                    f"{cls:<14} text={t[:38]!r:<40} desc={d[:28]!r:<30} "
                    f"bounds={n.get('bounds')} clickable={n.get('clickable')}\n"
                )

    print(f"PKGS={','.join(packages)}")
    print(f"NODES={len(nodes)}")
    print(f"TEXTS={sum(1 for t in texts if t)}")
    print(f"ROTATION={root.get('rotation')}")
    print(f"SIG={','.join(hits)}")
    print(f"SCREEN={screen}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
