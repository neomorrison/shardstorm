"""Slice ChatGPT sprite sheets into game sprites.

Usage: python tools/art/slice.py            (processes everything listed in JOBS that exists in assets/raw)

- Grid sheets are split into equal cells. Each cell's background is removed (true alpha if present,
  otherwise a flood fill from the cell border that removes the flat or checkerboard backdrop),
  trimmed to content, padded, and resized so the longest side is `px`.
- Backgrounds (maps, key art) are resized and saved as high quality JPEG.
- Writes assets/manifest.art.json with sprite entries (merged into assets/manifest.json later).
"""
import json
import os
import sys
from collections import deque

from PIL import Image, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
RAW = os.path.join(ROOT, 'assets', 'raw')
OUT = os.path.join(ROOT, 'assets', 'img')

TOWERS = ['pulse', 'scatter', 'rail', 'missile', 'cryo', 'tesla', 'laser', 'drone', 'mortar', 'gravity', 'rig', 'beacon']
METEORS = ['rust', 'cobalt', 'jade', 'amber', 'rose', 'iron', 'magma', 'comet', 'prism', 'geode', 'aurora', 'obsidian']

# (raw file, kind, options)
JOBS = [
    ('ss_keyart.png', 'bg', {'key': 'keyart', 'out': 'ui/keyart.jpg', 'w': 1920}),
    ('ss_logo.png', 'single', {'key': 'logo', 'out': 'ui/logo.png', 'px': 900}),
    ('ss_map_crater.jpg', 'bg', {'key': 'map_crater', 'out': 'maps/crater.jpg', 'w': 1536}),
    ('ss_map_frost.jpg', 'bg', {'key': 'map_frost', 'out': 'maps/frost.jpg', 'w': 1536}),
    ('ss_map_dock.jpg', 'bg', {'key': 'map_dock', 'out': 'maps/dock.jpg', 'w': 1536}),
    ('ss_map_ember.jpg', 'bg', {'key': 'map_ember', 'out': 'maps/ember.jpg', 'w': 1536}),
    ('ss_map_prism.jpg', 'bg', {'key': 'map_prism', 'out': 'maps/prism.jpg', 'w': 1536}),
    ('ss_towers.png', 'grid', {'cols': 4, 'rows': 3, 'px': 192,
                                'names': [f'tower_{t}_0' for t in TOWERS], 'dir': 'towers',
                                'meta': {'size': 60, 'rotates': True, 'facing': 'up'}}),
    ('ss_meteors.png', 'grid', {'cols': 4, 'rows': 3, 'px': 128,
                                 'names': [f'enemy_{m}' for m in METEORS], 'dir': 'enemies',
                                 'meta': {'size': 30, 'rotates': False}}),
    ('ss_ships.png', 'grid', {'cols': 3, 'rows': 2, 'px': 320,
                               'names': ['ship_hauler', 'ship_warbarge', 'ship_dreadnought', 'ship_specter', 'ship_worldbreaker', 'portal'],
                               'dir': 'ships', 'meta': {'size': 90, 'rotates': True, 'facing': 'right'}}),
    ('ss_titans.png', 'grid', {'cols': 3, 'rows': 2, 'px': 384,
                                'names': ['titan_maw', 'titan_aegis', 'titan_rift', 'core', 'ui_shield', 'ui_integrity'],
                                'dir': 'titans', 'meta': {'size': 150, 'rotates': True, 'facing': 'right'}}),
    ('ss_heroes.png', 'grid', {'cols': 3, 'rows': 1, 'px': 256,
                                'names': ['hero_vega', 'hero_nova', 'hero_brick'], 'dir': 'heroes',
                                'meta': {'size': 64, 'rotates': False}}),
]

# Upgrade variant sheets (kie.ai nano-banana-edit + recraft bg removal): variants 1..3 = paths A..C at tier 3+
for _t in TOWERS:
    JOBS.append(('tv_%s.png' % _t, 'grid', {'cols': 3, 'rows': 1, 'px': 192,
                 'names': ['tower_%s_%d' % (_t, v) for v in (1, 2, 3)], 'dir': 'towers',
                 'meta': {'size': 66, 'rotates': True, 'facing': 'up'}, 'dil': 0}))

# Per-key size overrides (world units of drawn diameter)
SIZE = {
    'ship_hauler': 80, 'ship_warbarge': 104, 'ship_dreadnought': 132, 'ship_specter': 72, 'ship_worldbreaker': 170,
    'portal': 90, 'core': 110, 'ui_credit': 32, 'ui_shield': 32, 'ui_integrity': 32, 'titan_maw': 170, 'titan_aegis': 170, 'titan_rift': 170,
    'enemy_obsidian': 40, 'enemy_aurora': 36, 'enemy_geode': 34,
}
NOROTATE = {'portal', 'core', 'ui_credit', 'ui_shield', 'ui_integrity',
            'tower_scatter_0', 'tower_cryo_0', 'tower_tesla_0', 'tower_drone_0', 'tower_gravity_0', 'tower_rig_0', 'tower_beacon_0'}
NOROT_TOWERS = ['scatter', 'cryo', 'tesla', 'drone', 'gravity', 'rig', 'beacon', 'mortar']
# meteor sprite diameter = collision radius x 2.7 (the art has jagged edges and sparkles)
from_radius = {'rust': 10, 'cobalt': 11, 'jade': 12, 'amber': 12, 'rose': 13, 'iron': 14, 'magma': 13, 'comet': 13,
               'prism': 13, 'geode': 15, 'aurora': 16, 'obsidian': 18}
for _k, _r in from_radius.items():
    SIZE['enemy_' + _k] = round(_r * 2.7)
# tower sprite diameters (world units); footprints are ~22 to 30
for _t in TOWERS:
    for _v in range(4):
        SIZE['tower_%s_%d' % (_t, _v)] = {'rail': 70, 'rig': 72, 'drone': 70}.get(_t, 66)


def has_real_alpha(im):
    if im.mode != 'RGBA':
        return False
    a = im.getchannel('A')
    lo, hi = a.getextrema()
    if lo == 255:
        return False
    # need a meaningful amount of transparent pixels
    hist = a.histogram()
    return sum(hist[:16]) > 0.05 * im.width * im.height


def remove_bg(cell, tol=38):
    """Flood fill from the border, removing pixels close to the border colors (handles flat or checkerboard)."""
    cell = cell.convert('RGBA')
    w, h = cell.size
    px = cell.load()
    # collect border palette (quantized)
    border = []
    for x in range(0, w, max(1, w // 64)):
        border.append(px[x, 0][:3]); border.append(px[x, h - 1][:3])
    for y in range(0, h, max(1, h // 64)):
        border.append(px[0, y][:3]); border.append(px[w - 1, y][:3])
    pal = []
    for c in border:
        if not any(sum(abs(c[i] - p[i]) for i in range(3)) < tol for p in pal):
            pal.append(c)
        if len(pal) > 6:
            break

    def is_bg(c):
        return any(sum(abs(c[i] - p[i]) for i in range(3)) < tol for p in pal)

    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        q.append((x, 0)); q.append((x, h - 1))
    for y in range(h):
        q.append((0, y)); q.append((w - 1, y))
    while q:
        x, y = q.popleft()
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        c = px[x, y]
        if not is_bg(c[:3]):
            continue
        px[x, y] = (c[0], c[1], c[2], 0)
        if x > 0: q.append((x - 1, y))
        if x < w - 1: q.append((x + 1, y))
        if y > 0: q.append((x, y - 1))
        if y < h - 1: q.append((x, y + 1))
    # soften the edge a touch
    a = cell.getchannel('A').filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.7))
    cell.putalpha(a)
    return cell


def trim(im, thresh=24, pad_frac=0.04, square=True):
    a = im.getchannel('A').point(lambda v: 255 if v > thresh else 0)
    box = a.getbbox()
    if not box:
        return None
    im = im.crop(box)
    w, h = im.size
    pad = int(max(w, h) * pad_frac) + 2
    cw, ch = (max(w, h) + pad * 2,) * 2 if square else (w + pad * 2, h + pad * 2)
    canvas = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    canvas.paste(im, ((cw - w) // 2, (ch - h) // 2))
    return canvas


def components_by_cell(im, cols, rows, ds=4, dil=2, thresh=40):
    """Label alpha blobs on a downsampled mask and assign each blob to the grid cell holding its
    centroid. Returns {cellIndex: RGBA image cropped to that cell's blobs, other blobs erased}."""
    W, H = im.size
    w, h = W // ds, H // ds
    a = im.getchannel('A').point(lambda v: 255 if v > thresh else 0)
    small = a.resize((w, h), Image.BOX).point(lambda v: 255 if v > 0 else 0)
    if dil:
        small = small.filter(ImageFilter.MaxFilter(dil * 2 + 1))
    sp = small.load()
    label = [0] * (w * h)
    comps = []
    for y in range(h):
        for x in range(w):
            if sp[x, y] == 0 or label[y * w + x]:
                continue
            cid = len(comps) + 1
            q = deque([(x, y)])
            label[y * w + x] = cid
            n = sx = sy = 0
            x0, y0, x1, y1 = x, y, x, y
            while q:
                cx, cy = q.popleft()
                n += 1; sx += cx; sy += cy
                x0 = min(x0, cx); y0 = min(y0, cy); x1 = max(x1, cx); y1 = max(y1, cy)
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h and sp[nx, ny] and not label[ny * w + nx]:
                        label[ny * w + nx] = cid
                        q.append((nx, ny))
            comps.append({'id': cid, 'n': n, 'cx': sx / n * ds, 'cy': sy / n * ds,
                          'box': (x0 * ds, y0 * ds, (x1 + 1) * ds, (y1 + 1) * ds)})
    cw, ch = W / cols, H / rows
    cells = {}
    for c in comps:
        idx = min(rows - 1, int(c['cy'] // ch)) * cols + min(cols - 1, int(c['cx'] // cw))
        cells.setdefault(idx, []).append(c)
    out = {}
    lab_img = Image.new('I', (w, h))
    lab_img.putdata(label)
    for idx, cs in cells.items():
        big = max(c['n'] for c in cs)
        keep = [c for c in cs if c['n'] >= max(6, 0.02 * big)]
        ids = {c['id'] for c in keep}
        x0 = min(c['box'][0] for c in keep); y0 = min(c['box'][1] for c in keep)
        x1 = max(c['box'][2] for c in keep); y1 = max(c['box'][3] for c in keep)
        crop = im.crop((x0, y0, x1, y1)).copy()
        # erase pixels whose (downsampled) label is not one of ours
        lab_crop = lab_img.crop((x0 // ds, y0 // ds, x1 // ds, y1 // ds)).resize(crop.size, Image.NEAREST)
        lp = lab_crop.load(); cp = crop.load()
        for yy in range(crop.height):
            for xx in range(crop.width):
                if lp[xx, yy] not in ids:
                    r, g, b, _ = cp[xx, yy]
                    cp[xx, yy] = (r, g, b, 0)
        out[idx] = crop
    return out


def save_sprite(im, path, px):
    im = im.copy()
    im.thumbnail((px, px), Image.LANCZOS)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, optimize=True)


def main():
    manifest = {}
    for raw, kind, o in JOBS:
        src = os.path.join(RAW, raw)
        if not os.path.exists(src):
            print('skip (missing)', raw)
            continue
        im = Image.open(src)
        print('processing', raw, im.size, im.mode)
        if kind == 'bg':
            im = im.convert('RGB')
            if im.width > o['w']:
                im = im.resize((o['w'], round(im.height * o['w'] / im.width)), Image.LANCZOS)
            dst = os.path.join(OUT, o['out'])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            im.save(dst, quality=86, optimize=True, progressive=True)
            manifest[o['key']] = {'src': 'img/' + o['out'], 'w': im.width, 'h': im.height}
        elif kind == 'single':
            im = im.convert('RGBA')
            if not has_real_alpha(im):
                im = remove_bg(im)
            t = trim(im, pad_frac=0.01, square=False)
            dst = os.path.join(OUT, o['out'])
            save_sprite(t, dst, o['px'])
            out = Image.open(dst)
            manifest[o['key']] = {'src': 'img/' + o['out'], 'w': out.width, 'h': out.height}
        elif kind == 'grid':
            im = im.convert('RGBA')
            alpha = has_real_alpha(im)
            if not alpha:
                im = remove_bg(im)
            blobs = components_by_cell(im, o['cols'], o['rows'], dil=o.get('dil', 2))
            for idx, name in enumerate(o['names']):
                if not name:
                    continue
                cell = blobs.get(idx)
                t = trim(cell) if cell is not None else None
                if t is None:
                    print('  empty cell', name)
                    continue
                rel = f"{o['dir']}/{name}.png"
                save_sprite(t, os.path.join(OUT, rel), o['px'])
                meta = dict(o.get('meta', {}))
                meta['size'] = SIZE.get(name, meta.get('size', 64))
                if name in NOROTATE or any(name.startswith('tower_%s_' % t) for t in NOROT_TOWERS):
                    meta['rotates'] = False
                manifest[name] = {'src': 'img/' + rel, **meta}
            print('  sliced', len(o['names']), 'cells; alpha' if alpha else 'cells; keyed')
    # Upgrade variants 1..3 reuse the base art until dedicated art exists (the renderer adds tier flourishes).
    for t in TOWERS:
        base = manifest.get('tower_%s_0' % t)
        if base:
            for v in (1, 2, 3):
                manifest.setdefault('tower_%s_%d' % (t, v), dict(base))
    with open(os.path.join(ROOT, 'assets', 'manifest.art.json'), 'w') as f:
        json.dump({'sprites': manifest}, f, indent=1)
    print('wrote manifest.art.json with', len(manifest), 'entries')


if __name__ == '__main__':
    main()
