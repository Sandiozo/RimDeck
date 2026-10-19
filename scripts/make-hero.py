"""Builds docs/hero.jpg (the README product shot) from docs/screenshots. Run after `npm run screenshots`."""
from PIL import Image, ImageDraw, ImageFilter


def rounded(img, r):
    m = Image.new('L', img.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, img.width, img.height), radius=r, fill=255)
    return m


def gradient(w, h):
    bg = Image.new('RGB', (w, h), (10, 11, 14))
    glow = Image.new('RGB', (w, h), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse((0, int(-h * 0.4), int(w * 0.6), int(h * 0.7)), fill=(46, 84, 128))  # steel blue
    g.ellipse((int(w * 0.55), int(h * 0.05), int(w * 1.2), int(h * 1.2)), fill=(196, 96, 30))  # rust orange
    bg = Image.blend(bg, glow.filter(ImageFilter.GaussianBlur(w // 9)), 0.40)
    d = ImageDraw.Draw(bg)
    for x in range(0, w, 28):
        for y in range(0, h, 28):
            d.point((x, y), fill=(42, 44, 52))
    return bg


def shot(path, width):
    s = Image.open(path).convert('RGB')
    return s.resize((width, int(s.height * width / s.width)), Image.LANCZOS)


def place(bg, img, x, y, r=16, shadow=60, border=(70, 76, 90)):
    sh = Image.new('L', bg.size, 0)
    ImageDraw.Draw(sh).rounded_rectangle((x, y + 18, x + img.width, y + img.height + 18), radius=r, fill=170)
    bg.paste(Image.new('RGB', bg.size, (0, 0, 0)), (0, 0), sh.filter(ImageFilter.GaussianBlur(shadow)))
    frame = Image.new('RGB', (img.width + 2, img.height + 2), border)
    bg.paste(frame, (x - 1, y - 1), rounded(frame, r + 1))
    bg.paste(img, (x, y), rounded(img, r))


W, H = 1600, 860
bg = gradient(W, H)
back = shot('docs/screenshots/research.png', 1060)
place(bg, Image.blend(back, Image.new('RGB', back.size, (12, 13, 18)), 0.35), W - 1060 - 40, 40, shadow=40)
place(bg, shot('docs/screenshots/mods.png', 1240), 70, 130, shadow=70, border=(120, 110, 100))
# Fade the bottom edge into the background.
px = bg.load()
for y in range(H - 170, H):
    t = ((y - (H - 170)) / 170) ** 1.6
    for x in range(W):
        r, g, b = px[x, y]
        px[x, y] = (int(r + (11 - r) * t), int(g + (12 - g) * t), int(b + (17 - b) * t))
bg.save('docs/hero.jpg', quality=90, optimize=True, progressive=True)
print('docs/hero.jpg', bg.size)
