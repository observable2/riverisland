#!/usr/bin/env python3
"""Extract the riverIsland QuickTime project (raw/riverislandQT) into web assets in nbks/data.

Reads only the QuickTime container structure (no QuickTime needed). Requires ffmpeg on the PATH.

  python3 tools/extract.py

Writes:
  nbks/data/texts.json          the 32 node texts (bytes), their word-key rectangles, the two morph alphabets
  nbks/data/nodes.json          node -> audio file, interliteral videos, panorama / object-movie metadata
  nbks/data/pano/periplus.jpg   the 360 degree panorama, upright
  nbks/data/obj/g00..g15.jpg    the 192 frames of the vertical object movie, 12 per sheet
  nbks/data/audio/*.mp3         the 16 + 13 distinct node readings (embedded sounds copied as they are), atmos.mp3
  nbks/data/icons/*.png         the arrow / dot images of the 'ri' sprite track, marker.jpg
  nbks/data/video/*.mp4         the three interliteral morph movies (remuxed, not re-encoded)
"""
import json, shutil, struct, subprocess, sys, zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "riverislandQT" / "riverisland"
OUT = ROOT / "nbks" / "data"
TMP = OUT / "_tmp"


# ---------- QuickTime atoms ----------

def atoms(d, off, end):
    while off + 8 <= end:
        size, typ = struct.unpack(">I4s", d[off:off + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", d[off + 8:off + 16])[0]
            hdr = 16
        if size == 0:
            size = end - off
        if size < 8:
            break
        yield typ, off + hdr, off + size
        off += size


def child(d, span, typ):
    for t, a, b in atoms(d, *span):
        if t == typ:
            return a, b


def qtatoms(d, off, end):
    """Parse a QTAtomContainer body into nested dicts {t, id, c|d}."""
    out = []
    while off + 20 <= end:
        size, typ, aid, _, nch, _ = struct.unpack(">I4sIHHI", d[off:off + 20])
        if size < 20 or off + size > end:
            break
        node = {"t": typ.decode("latin1"), "id": aid}
        if nch:
            node["c"] = qtatoms(d, off + 20, off + size)
        else:
            node["d"] = d[off + 20:off + size]
        out.append(node)
        off += size
    return out


def kids(n, t):
    return [c for c in n.get("c", []) if c["t"] == t]


def one(n, t):
    k = kids(n, t)
    return k[0] if k else None


class Movie:
    def __init__(self, path):
        self.d = Path(path).read_bytes()
        moov = child(self.d, (0, len(self.d)), b"moov")
        self.tracks = [self._track(a, b) for t, a, b in atoms(self.d, *moov) if t == b"trak"]

    def _track(self, a, b):
        d, span = self.d, (a, b)
        tid = struct.unpack(">I", d[slice(*child(d, span, b"tkhd"))][12:16])[0]
        mdia = child(d, span, b"mdia")
        hdlr = d[slice(*child(d, mdia, b"hdlr"))]
        stbl = child(d, child(d, mdia, b"minf"), b"stbl")
        sz = d[slice(*child(d, stbl, b"stsz"))]
        fixed, n = struct.unpack(">II", sz[4:12])
        sizes = list(struct.unpack(">%dI" % n, sz[12:12 + 4 * n])) if not fixed else [fixed] * n
        co = d[slice(*child(d, stbl, b"stco"))]
        k = struct.unpack(">I", co[4:8])[0]
        offs = struct.unpack(">%dI" % k, co[8:8 + 4 * k])
        sc = d[slice(*child(d, stbl, b"stsc"))]
        m = struct.unpack(">I", sc[4:8])[0]
        runs = [struct.unpack(">III", sc[8 + 12 * i:20 + 12 * i]) for i in range(m)]
        samples, i = [], 0
        for ci, o in enumerate(offs):
            per = [p for f, p, _ in runs if f <= ci + 1][-1]
            for _ in range(per):
                if i < n:
                    samples.append(d[o:o + sizes[i]])
                    o += sizes[i]
                    i += 1
        tref = {}
        tr = child(d, span, b"tref")
        if tr:
            for t, x, y in atoms(d, *tr):
                tref[t.decode()] = list(struct.unpack(">%dI" % ((y - x) // 4), d[x:y]))
        name = None
        ud = child(d, span, b"udta")
        if ud:
            for t, x, y in atoms(d, *ud):
                if t == b"name":
                    name = d[x:y].decode("latin1")
        return {"id": tid, "type": hdlr[8:12].decode("latin1"), "samples": samples, "tref": tref, "name": name}

    def track(self, key):
        return next(t for t in self.tracks if t["id"] == key or t["name"] == key)


def sh(*args):
    r = subprocess.run([str(a) for a in args], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"{args[0]} failed: {r.stderr}")


# ---------- the text, from the init handler of sprite 'ri' ----------

TYPE = {0x10: "rect", 0x15: "dict", 0x18: "list", 0x1d: "text"}


def objref(p):
    v = struct.unpack(">I", p["d"])[0]
    return v >> 24, v & 0xFFFF


def number(p):
    """a constant parameter: a literal 4-byte object ref with high byte 0, or a float expression"""
    if "d" in p:
        return struct.unpack(">I", p["d"])[0]
    c = one(one(one(p, "expr"), "oprn"), "")  # unused path
    raise ValueError


def cstring(b):
    return b[:-1] if b.endswith(b"\0") else b


def read_ri():
    m = Movie(RAW / "riverisland.mov")
    s = m.track("ri")["samples"][0]
    root = qtatoms(s, 12, len(s))
    sprite = next(c for c in root[0]["c"] if c["t"] == "sprt" and c["id"] == 1)
    ev = {e["id"]: e for e in kids(sprite, "evnt")}
    return ev


def actions(ev):
    for a in ev["c"]:
        if a["t"] == "actn":
            yield struct.unpack(">I", one(a, "whic")["d"])[0], kids(a, "parm")


def texts_and_keys(ev):
    """Replay the straight-line part of the init handler (event 0xb1ec): text objects, word rectangles, dictionaries, lists."""
    texts, dicts, lists = {}, {}, {}
    rect = None
    for w, ps in actions(ev):
        if w == 0x57453131 and "d" in ps[1] and len(ps[1]["d"]) != 4:       # WE11 text.setString
            texts[objref(ps[0])[1]] = cstring(ps[1]["d"])
        elif w == 0x57313131:                                                  # W111 rect.set(x1, y1, x2, y2)
            rect = [struct.unpack(">I", p["d"])[0] for p in ps[1:]]
        elif w == 0x57363132:                                                  # W612 dict.setObjectForKey(key, rect)
            dicts.setdefault(objref(ps[0])[1], {})[texts[objref(ps[1])[1]].decode("latin1")] = list(rect)
        elif w == 0x57393145:                                                  # W91E list.addObject
            lists.setdefault(objref(ps[0])[1], []).append(objref(ps[1])[1])
    return texts, dicts, lists


def alphabets(ev):
    """The two circular letter orderings used for the morph: setVarStr(6, ...) before the two Q[W00y] loops."""
    out = []
    for a in ev["c"]:
        if a["t"] == "actn" and struct.unpack(">I", one(a, "whic")["d"])[0] == 7171:
            ps = kids(a, "parm")
            if len(ps) == 2 and ps[0]["d"] == struct.pack(">i", 6) and "d" in ps[1]:
                out.append(cstring(ps[1]["d"]))
    return out


def fix_big5(data):
    """Two slips in the original Chinese text, corrected here:
    - 炙 (AA A5) where the poem has 返 (AA F0), in the line 'fan ying ru shen lin';
    - in the last line, 照 stands one column late (column 10; every other second character of the four lines, and the key
      rectangle of 照 itself, have column 9). The line has one space too many before 照 and one too few after it, so
      the characters after it are on their columns: the space is moved from before 照 to after it."""
    out, i = bytearray(), 0
    while i < len(data):
        if data[i] >= 0xA1 and i + 1 < len(data):
            pair = data[i:i + 2]
            out += b"\xaa\xf0" if pair == b"\xaa\xa5" else pair
            i += 2
        else:
            out.append(data[i])
            i += 1
    lines = bytes(out).split(b"\r")
    last = lines[7]
    assert len(lines) == 8 and last[2:10] == b" " * 8 and last[10] >= 0xA1, last
    assert last[12:18] == b" " * 6 and last[18] >= 0xA1, last
    lines[7] = last[:2] + b" " * 7 + last[10:12] + b" " * 7 + last[18:]
    return b"\r".join(lines)


def write_texts():
    ev = read_ri()
    texts, dicts, lists = texts_and_keys(ev[0xB1EC])
    # list ids: 402663220 = 0x18002734 -> 0x2734 horizontal texts; 0x2743 vertical texts; 0x2748 vertical dictionaries
    H, V, VD = lists[0x2734], lists[0x2743], lists[0x2748]
    assert len(H) == len(V) == len(VD) == 16, (len(H), len(V), len(VD))
    abc = alphabets(ev[0x6D34])
    assert len(abc) == 2, abc
    # the 炙 -> 返 correction (fix_big5) removes the last A5 from the text: F0 takes its place in the second ordering
    assert abc[1].count(b"\xa5") == 1 and b"\xf0" not in abc[1]
    abc[1] = abc[1].replace(b"\xa5", b"\xf0")

    def entry(tid, keys=None, enc="mac"):
        data = texts[tid]
        if enc == "big5":
            data = fix_big5(data)
        e = {"hex": data.hex(), "enc": enc}
        if keys is not None:
            e["keys"] = keys
        return e

    # vertical nodes 4 and 10 carry the Chinese text (Big5 bytes)
    big5 = {i for i in range(16) if sum(b >= 0xA1 for b in texts[V[i]]) > 20}
    out = {
        "alphabets": [a.hex() for a in abc],
        "loading": "Loading ...",
        "h": [entry(t) for t in H],
        "v": [entry(V[i], dicts.get(VD[i], {}), "big5" if i in big5 else "mac") for i in range(16)],
    }
    assert out["h"][4]["hex"] == out["v"][0]["hex"]  # the loops cross: horizontal node 5 is vertical node 1
    (OUT / "texts.json").write_text(json.dumps(out, indent=1))
    print("texts.json: h", len(H), "v", len(V), "big5 nodes", sorted(big5), "alphabets", [len(a) for a in abc])


# ---------- panorama and object movie ----------

def write_pano():
    m = Movie(RAW / "periplus.mov")
    pano = m.track("pano") if False else next(t for t in m.tracks if t["type"] == "pano")
    nodes = qtatoms(pano["samples"][0], 12, len(pano["samples"][0]))
    pd = next(c for c in nodes[0]["c"] if c["t"] == "pdat")["d"]
    f = struct.unpack(">9f", pd[12:48])
    sx, sy, nfx, nfy = struct.unpack(">IIHH", pd[48:60])
    tiles = m.track(pano["tref"]["imgt"][0])["samples"]
    assert len(tiles) == nfy
    TMP.mkdir(parents=True, exist_ok=True)
    ins, lab = [], ""
    for i, t in enumerate(tiles):
        p = TMP / f"t{i:02d}.jpg"
        p.write_bytes(t)
        ins += ["-i", p]
        lab += f"[{i}:v]"
    (OUT / "pano").mkdir(exist_ok=True)
    sh("ffmpeg", "-loglevel", "error", "-y", *ins, "-filter_complex", f"{lab}vstack=inputs={len(tiles)},transpose=1[v]",
       "-map", "[v]", "-frames:v", "1", "-q:v", "2", OUT / "pano" / "periplus.jpg")
    meta = {"pan": [f[0], f[1]], "tilt": [f[2], f[3]], "fov": [f[4], f[5]], "def": {"pan": f[6], "tilt": f[7], "fov": f[8]},
            "width": sy, "height": sx, "tiles": nfy}
    print("pano", meta)
    return meta


def write_object():
    """192 frames of 164x496 (one column of 192 tilt rows, 12 per node), packed as 16 sheets of 12 frames side by side."""
    m = Movie(RAW / "paths.mov")
    obj = next(t for t in m.tracks if t["type"] == "obje")
    frames = m.track(obj["tref"]["imgt"][0])["samples"]
    assert len(frames) == 192
    (OUT / "obj").mkdir(exist_ok=True)
    for g in range(16):
        ins = []
        for k in range(12):
            p = TMP / f"o{g * 12 + k:03d}.jpg"
            p.write_bytes(frames[g * 12 + k])
            ins += ["-i", p]
        sh("ffmpeg", "-loglevel", "error", "-y", *ins, "-filter_complex", "hstack=inputs=12", "-frames:v", "1", "-q:v", "3", OUT / "obj" / f"g{g:02d}.jpg")
    print("object sheets", 16)
    return {"frames": 192, "perSheet": 12, "frameWidth": 164, "frameHeight": 496}


# ---------- audio ----------

def write_audio():
    """The sixteen sounds embedded in periplus.mov (tracks s0..sf) and in paths.mov (p0..pf), as the original plays them."""
    (OUT / "audio").mkdir(exist_ok=True)
    seen, files = {}, {"h": [], "v": []}
    for mv, key, pre in (("periplus", "h", "s"), ("paths", "v", "p")):
        m = Movie(RAW / f"{mv}.mov")
        for k in range(16):
            tr = m.track(f"{pre}{k:x}")
            s = tr["samples"][0]
            i = s.find(b"ftypqt")
            emb = TMP / f"{key}{k}.mov"
            emb.write_bytes(s[i - 4:])
            mp3 = TMP / f"{key}{k}.mp3"
            sh("ffmpeg", "-loglevel", "error", "-y", "-i", emb, "-map", "0:a:0", "-c", "copy", mp3)
            digest = mp3.read_bytes()
            if digest in seen:
                files[key].append(seen[digest])
            else:
                name = f"{key}{k + 1:02d}.mp3"
                shutil.copy(mp3, OUT / "audio" / name)
                seen[digest] = name
                files[key].append(name)
    sh("ffmpeg", "-loglevel", "error", "-y", "-i", RAW / "riAtmos.mov", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "40k", OUT / "audio" / "atmos.mp3")
    print("audio", files)
    return files


# ---------- icons, marker, videos ----------

def write_icons():
    m = Movie(RAW / "riverisland.mov")
    s = m.track("ri")["samples"][0]
    root = qtatoms(s, 12, len(s))
    (OUT / "icons").mkdir(exist_ok=True)

    def find(ns, t):
        for n in ns:
            if n["t"] == t:
                yield n
            if "c" in n:
                yield from find(n["c"], t)

    names = {}
    for im in find(root, "imag"):
        if not one(im, "name"):
            continue
        nm = one(im, "name")["d"]
        nm = nm[1:1 + nm[0]].decode()
        d = one(im, "imda")["d"]
        i = d.find(b"\x89PNG")
        if i >= 0 and nm != "phldr":
            (OUT / "icons" / f"{nm}.png").write_bytes(d[i:])
            names[im["id"]] = nm
    (OUT / "icons" / "marker.jpg").write_bytes(m.track("centreMarker")["samples"][0])
    # sprite positions inside the 96x96 'ri' box (image matrices of sprites 4..8)
    print("icons", names)


def write_video():
    (OUT / "video").mkdir(exist_ok=True)
    for src, dst in (("riZiw5", "kong-zi"), ("riPyw5", "kong-py"), ("riLtw5", "kong-lt")):
        sh("ffmpeg", "-loglevel", "error", "-y", "-i", RAW / f"{src}.mov", "-c", "copy", "-an", "-movflags", "+faststart", OUT / "video" / f"{dst}.mp4")
    print("video done")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    write_texts()
    pano = write_pano()
    nobj = write_object()
    audio = write_audio()
    write_icons()
    write_video()
    nodes = {"pano": pano, "object": nobj, "audio": audio,
             "video": {"4": "video/kong-zi.mp4", "6": "video/kong-py.mp4", "11": "video/kong-lt.mp4"}}
    (OUT / "nodes.json").write_text(json.dumps(nodes, indent=1))
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    main()
