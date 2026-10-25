#!/usr/bin/env python3
"""Decompile the wired actions (sprite-track scripts) of the riverIsland QuickTime movies, for reading.

  python3 tools/decompile.py MOVIE TRACK [OUT]

  MOVIE   riverisland | periplus | paths   (from raw/riverislandQT/riverisland/)
  TRACK   track id: riverisland 3 = ri, 5 = stepper; periplus 5 = periRiCntrl, 22 = periGray; paths 4 = pathsRiCntrl, 22 = pathsGray

Prints each sprite and its events as pseudo-code. Compressed (zlib) samples are handled. This is the tool that the
notes in workingnotes.md were read from; it is for investigation, not part of the build (tools/extract.py is).

Naming is partly inferred: standard actions/operands are named where known (see ACT); the QSXE component's calls are
shown as Q[W...] with their four-character code, because the component has no name table (see workingnotes.md).
Sprite events with numeric ids are user subroutines, shown as EV0x...; sendEvtToSprite is shown as 'CALL sprite1 EV0x...'.
"""
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "riverislandQT" / "riverisland"

def atoms(d, off, end):
    while off + 8 <= end:
        size, typ = struct.unpack(">I4s", d[off:off + 8]); hdr = 8
        if size == 1: size = struct.unpack(">Q", d[off+8:off+16])[0]; hdr = 16
        if size == 0: size = end - off
        if size < 8: break
        yield typ, off + hdr, off + size
        off += size
def child(d, span, typ):
    for t, a, b in atoms(d, *span):
        if t == typ: return a, b
def qtatoms(d, off, end):
    out = []
    while off + 20 <= end:
        size, typ, aid, _, nch, _ = struct.unpack(">I4sIHHI", d[off:off + 20])
        if size < 20 or off + size > end: break
        node = {"t": typ.decode("latin1"), "id": aid}
        if nch: node["c"] = qtatoms(d, off + 20, off + size)
        else: node["d"] = d[off + 20:off + size]
        out.append(node); off += size
    return out
class Movie:
    def __init__(self, path):
        self.d = Path(path).read_bytes()
        moov = child(self.d, (0, len(self.d)), b"moov")
        mvhd = self.d[slice(*child(self.d, moov, b"mvhd"))]
        self.timescale, self.duration = struct.unpack(">II", mvhd[12:20])
        self.tracks = [self._track((a, b)) for t, a, b in atoms(self.d, *moov) if t == b"trak"]
    def _track(self, span):
        d = self.d
        tkhd = d[slice(*child(d, span, b"tkhd"))]
        tid = struct.unpack(">I", tkhd[12:16])[0]
        w, h = struct.unpack(">II", tkhd[-8:]); w >>= 16; h >>= 16
        mat = struct.unpack(">9i", tkhd[40:76])
        layer = struct.unpack(">h", tkhd[32:34])[0]
        mdia = child(d, span, b"mdia")
        hdlr = d[slice(*child(d, mdia, b"hdlr"))]
        mdhd = d[slice(*child(d, mdia, b"mdhd"))]
        ts, dur = struct.unpack(">II", mdhd[12:20])
        minf = child(d, mdia, b"minf")
        stbl = child(d, minf, b"stbl")
        stsd = d[slice(*child(d, stbl, b"stsd"))]
        stsz = d[slice(*child(d, stbl, b"stsz"))]
        fixed, n = struct.unpack(">II", stsz[4:12])
        sizes = list(struct.unpack(">%dI" % n, stsz[12:12 + 4 * n])) if not fixed else [fixed] * n
        stco = d[slice(*child(d, stbl, b"stco"))] if child(d, stbl, b"stco") else None
        if stco is None:
            co = d[slice(*child(d, stbl, b"co64"))]; k = struct.unpack(">I", co[4:8])[0]; offs = struct.unpack(">%dQ" % k, co[8:8+8*k])
        else:
            k = struct.unpack(">I", stco[4:8])[0]; offs = struct.unpack(">%dI" % k, stco[8:8 + 4 * k])
        stsc = d[slice(*child(d, stbl, b"stsc"))]
        m = struct.unpack(">I", stsc[4:8])[0]
        runs = [struct.unpack(">III", stsc[8 + 12 * i:20 + 12 * i]) for i in range(m)]
        samples, i = [], 0
        for ci, co_ in enumerate(offs):
            per = [p for f, p, _ in runs if f <= ci + 1][-1]; o = co_
            for _ in range(per):
                if i < n: samples.append(d[o:o + sizes[i]]); o += sizes[i]; i += 1
        stts = d[slice(*child(d, stbl, b"stts"))]
        ne = struct.unpack(">I", stts[4:8])[0]
        durs = []
        for j in range(ne):
            c, dl = struct.unpack(">II", stts[8+8*j:16+8*j]); durs += [dl]*c
        tref = {}
        tr = child(d, span, b"tref")
        if tr:
            for t, a, b in atoms(d, *tr): tref[t.decode()] = list(struct.unpack(">%dI" % ((b - a) // 4), d[a:b]))
        udta = child(d, span, b"udta")
        name = None
        if udta:
            for t, a, b in atoms(d, *udta):
                if t == b"name": name = d[a:b].decode("latin1")
        return {"id": tid, "type": hdlr[8:12].decode("latin1"), "codec": stsd[12:16].decode("latin1"), "stsd": stsd,
                "samples": samples, "tref": tref, "w": w, "h": h, "ts": ts, "dur": dur, "durs": durs, "name": name, "layer": layer,
                "mat": mat, "tkhd": tkhd, "span": span}
    def track(self, tid): return next(t for t in self.tracks if t["id"] == tid)


def kids(n,t): return [c for c in n.get('c',[]) if c['t']==t]
def one(n,t):
    k=kids(n,t); return k[0] if k else None
def ps(b): return b[1:1+b[0]].decode('mac_roman')
def f32(b): return struct.unpack('>f',b)[0]
def i32(b): return struct.unpack('>i',b)[0] if len(b)==4 else b.hex()
def u32(s): return struct.unpack('>I',s.encode('latin1'))[0]
def cc(v):
    b=struct.pack('>I',v&0xffffffff)
    return b.decode('mac_roman') if all(32<=x<127 for x in b) else hex(v&0xffffffff)
ACT={1025:'setRate',2050:'trackEnable',2054:'trackCursor',2056:'trackIdleFreq',3073:'spriteImage',3074:'spriteVisible',4096:'pan',4097:'tilt',6144:'case',6145:'while',6147:'sendEvtToSprite',6148:'debugStr',6157:'openHandler',6163:'dontPassKey',7168:'setVar',7171:'setVarStr',11265:'loadChild',12288:'pasteText',12310:'act12310'}
OPS={'add ':'+','sub ':'-','mult':'*','div ':'/','=   ':'==','!=  ':'!=','<   ':'<','>   ':'>','<=  ':'<=','>=  ':'>=','and ':'&&','or  ':'||','neg ':'-','not ':'!','mod ':'%'}
def targ(a):
    t=one(a,'targ')
    if not t: return ''
    c=t['c'][0]
    if 'd' in c:
        d=c['d']
        if c['t']=='trid' : return f" @track#{i32(d)}"
        return f" @{c['t']}:{ps(d) if d else ''}"
    return f" @{c['t']}"+str([ (x['t'],i32(x['d']) if 'd' in x else '..') for x in c['c']])
def operand(o):
    c=o['c'][0]; ty=u32(c['t'])
    tg=one(c,'targ')
    suffix=targ(c) if tg else ''
    if ty==2: return f"{f32(c['d']):g}"
    if ty==1:
        if 'c' in c and c['c'] and c['c'][0]['t']=='expr': return expr(c['c'][0])
        return "?str"
    if ty==0xc07:
        p=one(c,'parm')
        if p is None: return f"var[?]{suffix}"
        if 'd' in p: return f"var[{i32(p['d'])}]{suffix}"
        return f"var[{expr(p['c'][0])}]{suffix}"
    p=one(c,'parm')
    if p is not None:
        if 'd' in p: return f"op{ty:#x}({i32(p['d'])}){suffix}"
        return f"op{ty:#x}({expr(p['c'][0])}){suffix}"
    if 'd' in c: return f"op{ty:#x}[{c['d'].hex()}]{suffix}"
    return f"op{ty:#x}{suffix}"
def expr(e):
    if 'c' in e:
        oper=one(e,'oper')
        if oper:
            sym=struct.pack('>I',oper['id']).decode('latin1')
            ops=[operand(o) for o in kids(oper,'oprn')]
            s=OPS.get(sym,sym.strip())
            if len(ops)==1: return f"({s}{ops[0]})"
            return '('+f' {s} '.join(ops)+')'
        o=one(e,'oprn')
        if o: return operand(o)
    return '?'
def parm(p):
    if 'd' in p:
        d=p['d']
        if len(d)==4: return str(i32(d))
        try:
            if d[0]+1<=len(d) and d[0]>0 and all(32<=x<256 for x in d[1:1+d[0]]): return repr(ps(d))
        except: pass
        if d and d[-1]==0 and all((32<=x<256 or x in (9,10,13)) for x in d[:-1]) and len(d)>1:
            return 'S'+repr(d[:-1].decode('mac_roman'))
        return d.hex()
    c=p['c']
    if c and c[0]['t']=='expr': return expr(c[0])
    if c and c[0]['t']=='test': return '<test>'
    return '?'
def act(a,ind):
    w=struct.unpack('>I',one(a,'whic')['d'])[0]
    name=ACT.get(w) or (f"Q[{cc(w)}]" if w>0x10000 else f'act{w}')
    pad='  '*ind
    if w==6144 or w==6145:
        out=[]
        tests=[c for c in (one(a,'parm') or {}).get('c',[]) if c['t']=='test']
        for i,t in enumerate(tests):
            cond=expr(one(t,'expr'))
            kw=('while' if w==6145 else 'if') if i==0 else 'else if'
            out.append(f"{pad}{kw} {cond} {{")
            for x in (one(t,'list') or {}).get('c',[]):
                if x['t']=='actn': out+=act(x,ind+1)
            out.append(pad+'}')
        return out
    ps_=[parm(p) for p in kids(a,'parm')]
    if w==6147:
        raw=[p for p in kids(a,'parm')]
        for p in raw:
            if 'd' in p and len(p['d'])==16:
                sp,ev=struct.unpack('>II',p['d'][:8]); ps_=[f"CALL sprite{sp} EV{ev:#x}"]
                tail=p['d'][8:]
                if any(tail): ps_.append(tail.hex())
        if len(raw)>1: ps_+= [parm(p) for p in raw if not('d' in p and len(p['d'])==16)]
        return [f"{pad}{' '.join(ps_)}{targ(a)}"]
    fl=one(a,'flag'); extra=f" flag={i32(fl['d'])}" if fl else ''
    return [f"{pad}{name}({', '.join(ps_)}){targ(a)}{extra}"]
def evname(i):
    return cc(i) if i>0xffff or i<0 else f"EV{i:#x}"
def dump(root,out):
    for sean in root:
        for ch in sean.get('c',[]):
            if ch['t']=='fram':
                out.append("== frame-loaded ==")
                for a in ch['c']:
                    if a['t']=='actn': out+=act(a,1)
            if ch['t']=='sprt':
                nm=one(ch,'name'); 
                out.append(f"== sprite {ch['id']} {ps(nm['d']) if nm else ''} ==")
                for ev in kids(ch,'evnt'):
                    out.append(f" on {evname(ev['id'])}:")
                    for a in ev['c']:
                        if a['t']=='actn': out+=act(a,2)
                for c2 in ch['c']:
                    if c2['t'] not in ('evnt','name'):
                        out.append(f"   [{c2['t']}#{c2['id']} {c2.get('d',b'').hex()[:80]}]")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    mv, tid = sys.argv[1], int(sys.argv[2])
    m = Movie(RAW / f"{mv}.mov")
    s = m.track(tid)["samples"][0]
    if s[4:6] == b"\x78\x9c":
        s = zlib.decompress(s[4:])
    out = []
    dump(qtatoms(s, 12, len(s)), out)
    text = "\n".join(out)
    if len(sys.argv) > 3:
        Path(sys.argv[3]).write_text(text)
    else:
        print(text)
