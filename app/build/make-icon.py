"""生成 app/build/icon.ico —— 纯 Python，零依赖（不装 Pillow）。

设计：圆角方块底（应用主色 #1e4bbd）+ 白色微缩族谱树（祖在上、二子在下，血缘连线）。
用 4x4 / 6x6 超采样做抗锯齿，逐像素用「距离场」判定，输出多尺寸 ICO（PNG 内嵌）。

用法：python make-icon.py
产物：app/build/icon.ico
"""
import os
import struct
import zlib

BG = (0x1E, 0x4B, 0xBD)      # --primary-700
FG = (0xFF, 0xFF, 0xFF)

CORNER_R = 0.22               # 圆角半径（归一化）

NODES = [(0.50, 0.285), (0.27, 0.715), (0.73, 0.715)]
NODE_R = 0.098
BAR_Y = 0.545
HALF_W = 0.042                # 连线半宽

SEGMENTS = [
    ((0.50, 0.285), (0.50, BAR_Y)),
    ((0.27, BAR_Y), (0.73, BAR_Y)),
    ((0.27, BAR_Y), (0.27, 0.715)),
    ((0.73, BAR_Y), (0.73, 0.715)),
]


def inside_bg(u, v):
    r = CORNER_R
    lo, hi = r, 1.0 - r
    cu = lo if u < lo else (hi if u > hi else u)
    cv = lo if v < lo else (hi if v > hi else v)
    if cu == u and cv == v:
        return True
    dx, dy = u - cu, v - cv
    return dx * dx + dy * dy <= r * r


def _seg_dist2(u, v, a, b):
    ax, ay = a
    bx, by = b
    vx, vy = bx - ax, by - ay
    wx, wy = u - ax, v - ay
    L = vx * vx + vy * vy
    t = 0.0 if L == 0 else (wx * vx + wy * vy) / L
    if t < 0.0:
        t = 0.0
    elif t > 1.0:
        t = 1.0
    dx = wx - t * vx
    dy = wy - t * vy
    return dx * dx + dy * dy


def inside_glyph(u, v):
    r2 = NODE_R * NODE_R
    for cx, cy in NODES:
        dx, dy = u - cx, v - cy
        if dx * dx + dy * dy <= r2:
            return True
    hw2 = HALF_W * HALF_W
    for a, b in SEGMENTS:
        if _seg_dist2(u, v, a, b) <= hw2:
            return True
    return False


def render(n, ss):
    """返回 RGBA bytes（未预乘）。"""
    inv = 1.0 / (n * ss)
    total = ss * ss
    rows = []
    ib, ig = inside_bg, inside_glyph
    for py in range(n):
        row = bytearray()
        for px in range(n):
            ar = ag = ab = aa = 0.0
            for j in range(ss):
                v = (py * ss + j + 0.5) * inv
                for i in range(ss):
                    u = (px * ss + i + 0.5) * inv
                    if not ib(u, v):
                        continue
                    aa += 1.0
                    if ig(u, v):
                        ar += FG[0]; ag += FG[1]; ab += FG[2]
                    else:
                        ar += BG[0]; ag += BG[1]; ab += BG[2]
            if aa == 0.0:
                row += b"\x00\x00\x00\x00"
            else:
                row += bytes((
                    int(ar / aa + 0.5),
                    int(ag / aa + 0.5),
                    int(ab / aa + 0.5),
                    int(aa * 255.0 / total + 0.5),
                ))
        rows.append(bytes(row))
    return rows


def png_bytes(n, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def build_ico(sizes, out_path):
    images = []
    for n, ss in sizes:
        rows = render(n, ss)
        images.append((n, png_bytes(n, rows)))
        print(f"  rendered {n}x{n} (ss={ss})")

    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    payload = b""
    for n, data in images:
        dim = 0 if n >= 256 else n
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)

    with open(out_path, "wb") as f:
        f.write(header + entries + payload)
    return os.path.getsize(out_path)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "icon.ico")
    plan = [(16, 6), (24, 6), (32, 6), (48, 4), (64, 4), (128, 4), (256, 3)]
    print("generating icon.ico ...")
    size = build_ico(plan, out)
    print(f"OK -> {out}  ({size} bytes)")
