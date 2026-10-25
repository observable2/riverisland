#!/usr/bin/env python3
"""Make the small Chinese font that riverIsland bundles: only the characters the piece can ever show, from Noto Serif TC.

  pip install fonttools brotli
  python3 tools/subset_font.py PATH/TO/NotoSerifTC[wght].ttf

The source font is the variable font of Noto Serif Traditional Chinese (SIL Open Font License), for example
https://github.com/google/fonts/raw/main/ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf (about 17 MB; it is not kept in the
project, only the subset is).

Writes:
  nbks/data/fonts/noto-serif-tc-subset.woff2   the subset, at weight WEIGHT
  nbks/data/fonts/cjk-subset-chars.txt         the characters in it, with the reason for each group

Which characters? The Chinese text is stored as Big5 *bytes*, and the morph moves bytes around, so besides the 14 lines
of the poem the screen can show any character that two bytes can make during a morph. A morph that involves a Chinese
text uses the second 'alphabet' (46 bytes, in texts.json); every cell on screen is then one of those bytes or a space. So:
  1. the characters of the Chinese texts themselves;
  2. every character formed by a 'lead' byte (A1-F9) followed by a 'trail' byte (40-7E or A1-FE), both taken from that
     alphabet, decoded as the browser does (Big5, with the control pictures it makes of A3C0-A3E0);
  3. a few symbols that a single byte of the alphabet shows as Mac Roman and the Latin fonts (Courier Prime, Cousine) do not have.
"""
import json
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "nbks" / "data" / "fonts"
WEIGHT = 400  # Cousine is 400; the font's own default is 200 (extra light)
SYMBOLS = "∑∫≈≠≤"  # Mac Roman bytes of the alphabet that Courier Prime and Cousine both lack (U+F8FF, the Apple logo, is shown as a space)


def decodes(pair):
    """what the browser (Big5 with the HKSCS extensions) and the older Windows Big5 make of two bytes: a single character, or nothing"""
    out = set()
    if pair[0] == 0xA3 and 0xC0 <= pair[1] <= 0xE0:
        # the browsers' Big5 turns A3C0-A3E0 into the control pictures U+2400-U+2420 (Python's codecs do not)
        out.add(chr(0x2400 + pair[1] - 0xC0))
    for codec in ("big5hkscs", "cp950"):
        try:
            s = bytes(pair).decode(codec)
        except UnicodeDecodeError:
            continue
        if len(s) == 1 and s != "�" and not 0xE000 <= ord(s) <= 0xF8FF:
            out.add(s)
    return out


def main(src):
    texts = json.loads((ROOT / "nbks" / "data" / "texts.json").read_text())
    poem = set()
    for e in texts["v"]:
        if e["enc"] == "big5":
            data = bytes.fromhex(e["hex"])
            i = 0
            while i < len(data):
                if data[i] >= 0xA1 and i + 1 < len(data):
                    poem |= decodes(data[i:i + 2])
                    i += 2
                else:
                    i += 1
    alpha = bytes.fromhex(texts["alphabets"][1])
    leads = [b for b in alpha if 0xA1 <= b <= 0xF9]
    trails = [b for b in alpha if 0x40 <= b <= 0x7E or 0xA1 <= b <= 0xFE]
    morph = set()
    for a in leads:
        for b in trails:
            morph |= decodes((a, b))
    morph -= poem

    font = TTFont(src)
    font = instancer.instantiateVariableFont(font, {"wght": WEIGHT}, updateFontNames=True)  # a static font, named Regular
    have = set(font.getBestCmap())
    wanted = poem | morph | set(SYMBOLS)
    missing = sorted(c for c in wanted if ord(c) not in have)
    keep = sorted(c for c in wanted if ord(c) in have)

    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = []  # plain glyphs only
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]  # keep the copyright and licence
    opts.notdef_outline = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=[ord(c) for c in keep])
    sub.subset(font)
    OUT.mkdir(parents=True, exist_ok=True)
    dest = OUT / "noto-serif-tc-subset.woff2"
    font.flavor = "woff2"
    font.save(dest)

    lines = [
        "Characters in noto-serif-tc-subset.woff2 (Noto Serif TC, weight %d). Made by tools/subset_font.py." % WEIGHT,
        "",
        "1. the characters of the Chinese texts (%d):" % len(poem),
        "".join(sorted(poem)),
        "",
        "2. characters that the morph can form from the bytes of its second alphabet (%d more):" % len(morph - set(missing)),
        "".join(c for c in sorted(morph) if c in set(keep)),
        "",
        "3. symbols (Courier Prime and Cousine lack them): " + SYMBOLS,
    ]
    if missing:
        lines += ["", "wanted but not in Noto Serif TC (the browser uses another font for these): " + "".join(missing)]
    (OUT / "cjk-subset-chars.txt").write_text("\n".join(lines) + "\n")
    print(f"{len(poem)} characters in the texts, {len(morph)} more from the morph, {len(missing)} missing from the font")
    print(f"wrote {dest} ({dest.stat().st_size} bytes)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
