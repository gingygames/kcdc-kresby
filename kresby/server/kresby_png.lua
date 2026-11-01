-- kresby_png.lua - serverové vykreslení desek do PNG (obrázky mapy) a kodek kresby
--
-- Čistá Lua 5.4, bez knihoven:
-- * kodek kresby "k2" (nástroj, inkousty a jejich míchání, velikost, krytí, přítlak) + čtení starého "k1";
-- * barevný rastr: papír (pergamen se skvrnami, papír s žebrováním), pero s ubýváním inkoustu
--   a kaňkami, štětec s mokrým okrajem, uhel se zrnem papíru, seškrábání; průhledné inkousty se
--   násobí s podkladem, krycí a zlaté se kladou navrch;
-- * kvantizace median-cut do palety 256 barev a PNG s vlastní deflate (obrázek mapy je PNG).
--
-- Všechna těžká práce volá step(), které uvnitř korutiny po vyčerpání časového rozpočtu vrátí
-- řízení serveru (coroutine.yield). Spouštěč úloh je v kresby.lua.

local P = {}

-- ---------------------------------------------------------------------------
-- rozpočet času

local ops, deadline = 0, math.huge
function P.setDeadline(t) deadline = t; ops = 0 end
-- w = přibližná práce od posledního volání (≈ desítky jednoduchých operací na jednotku)
local function step(w)
  ops = ops + (w or 1)
  if ops >= 256 then
    ops = 0
    if os.clock() >= deadline and coroutine.isyieldable() then coroutine.yield() end
  end
end
P.step = step

local floor, max, min, sqrt, sin = math.floor, math.max, math.min, math.sqrt, math.sin
local SRC_W, SRC_H = 768, 512
local MAX_STROKES, MAX_POINTS = 3000, 4096
P.SRC_W, P.SRC_H = SRC_W, SRC_H

P.TOOL = { pen = 0, brush = 1, charcoal = 2, scrape = 3 }
P.FLAG = { opaque = 1, gold = 2 }
local PEN, BRUSH, CHARCOAL, SCRAPE = 0, 1, 2, 3

-- barvy desky (RGB)
local SHADOW = { 0x24, 0x18, 0x0e }
local WOOD_D = { 0x3e, 0x2b, 0x1a }
local WOOD = { 0x4a, 0x34, 0x21 }
local WOOD_L = { 0x55, 0x3d, 0x27 }
local PIN = { 0x7a, 0x1f, 0x14 }
local EDGE = { 0xc9, 0xb8, 0x96 }
local CHARCOAL_RGB = { 34, 31, 30 }
P.PAPERS = {
  [0] = { name = "pergamen", rgb = { 232, 218, 188 } },
  [1] = { name = "papír", rgb = { 241, 236, 222 } },
}

local function pack(r, g, b) return (floor(r + 0.5) << 16) | (floor(g + 0.5) << 8) | floor(b + 0.5) end

-- ---------------------------------------------------------------------------
-- šum (deterministický - stejný obraz při každém vykreslení)

local function hash(x, y, s)
  local h = (x * 374761393 + y * 668265263 + s * 1442695041) & 0xffffffff
  h = ((h ~ (h >> 13)) * 1274126177) & 0xffffffff
  return ((h ~ (h >> 16)) & 0xffffff) / 16777216
end
P.hash = hash

local function valueNoise(x, y, s)
  local ix, iy = floor(x), floor(y)
  local fx, fy = x - ix, y - iy
  fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
  local a, b = hash(ix, iy, s), hash(ix + 1, iy, s)
  local c, d = hash(ix, iy + 1, s), hash(ix + 1, iy + 1, s)
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy
end

-- ---------------------------------------------------------------------------
-- míchání barev: vážený geometrický průměr odrazivosti - chová se jako barvy, ne jako světlo
-- (modrá + žlutá = zelená, ne šedá). t = podíl druhé barvy 0..1.

function P.mixRGB(a, b, t)
  local out = {}
  for i = 1, 3 do
    local x, y = max(a[i], 1) / 255, max(b[i], 1) / 255
    out[i] = floor(255 * (x ^ (1 - t)) * (y ^ t) + 0.5)
  end
  return out
end

-- ---------------------------------------------------------------------------
-- base64

local B64 = {}
local B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
for i = 1, 64 do B64[B64C:byte(i)] = i - 1 end

local function b64bytes(s, from)
  local out, n, acc, bits = {}, 0, 0, 0
  for i = from, #s do
    local c = s:byte(i)
    if c == 61 then break end
    local v = B64[c]
    if not v then return nil end
    acc = ((acc << 6) | v) & 0xFFFFFF
    bits = bits + 6
    if bits >= 8 then
      bits = bits - 8
      n = n + 1
      out[n] = (acc >> bits) & 0xFF
    end
    if i % 1024 == 0 then step(32) end
  end
  return out, n
end

local function b64encode(b, n)
  local out = {}
  for i = 1, n, 3 do
    local a, c2, c3 = b[i], b[i + 1] or 0, b[i + 2] or 0
    local v = (a << 16) | (c2 << 8) | c3
    local q1, q2, q3, q4 = (v >> 18) & 63, (v >> 12) & 63, (v >> 6) & 63, v & 63
    local rest = n - i + 1
    out[#out + 1] = B64C:sub(q1 + 1, q1 + 1) .. B64C:sub(q2 + 1, q2 + 1)
      .. (rest > 1 and B64C:sub(q3 + 1, q3 + 1) or "=") .. (rest > 2 and B64C:sub(q4 + 1, q4 + 1) or "=")
    if i % 3072 == 1 then step(16) end
  end
  return table.concat(out)
end

-- ---------------------------------------------------------------------------
-- kodek
--
-- Kresba = { paper = 0|1, inks = { { rgb = {r,g,b}, flags, strength = 0..255 }, ... },
--            strokes = { { tool, a, b, mix, size, op, p = { x, y, pr, x, y, pr, ... } }, ... } }
--   a, b   = index inkoustu (1..), 0 = žádný; mix = podíl b 0..255
--   size   = průměr štětce ve čtvrtpixelech listu 768 × 512 (2..160 = 0,5..40 px)
--   op     = krytí 0..255; pr = přítlak 0..15
--
-- "k2." + base64( 2, paper, n, n × (r, g, b, flags, strength),
--                 tahy: tool, a, b, mix, size, op, varint počet, x, y, pr, pak zigzag rozdíly x, y, pr )

local OLD_K1 = { { 0x1d, 0x1a, 0x17 }, { 0x5b, 0x3a, 0x1e }, { 0x9b, 0x2d, 0x1f }, { 0xb8, 0x86, 0x2b },
  { 0x4f, 0x6b, 0x3a }, { 0x2f, 0x4f, 0x7f }, { 0xf1, 0xea, 0xd8 } }
local OLD_WIDTHS = { [0] = 2, 4, 8, 16 }

local function reader(b, n, pos)
  local r = {}
  function r.byte()
    if pos > n then error("eof", 0) end
    local v = b[pos]; pos = pos + 1
    return v
  end
  function r.varint()
    local v, mul = 0, 1
    repeat
      if pos > n or mul > (1 << 28) then error("varint", 0) end
      local x = b[pos]; pos = pos + 1
      v = v + (x & 0x7f) * mul
      mul = mul * 128
    until x < 0x80
    return v
  end
  function r.more() return pos <= n end
  return r
end

local function unzig(v) if v % 2 == 1 then return -(v + 1) // 2 end return v // 2 end
local function clamp(v, a, b) if v < a then return a elseif v > b then return b end return v end

local function decodeK1(b, n)
  local r = reader(b, n, 2)
  local d = { paper = 0, inks = {}, strokes = {} }
  for i, c in ipairs(OLD_K1) do d.inks[i] = { rgb = c, flags = (i == 7) and 1 or 0, strength = 255 } end
  while r.more() and #d.strokes < MAX_STROKES do
    local h = r.byte()
    local count = r.varint()
    if count < 1 or count > MAX_POINTS then error("points", 0) end
    local c, w = h & 7, (h >> 3) & 3
    local p = {}
    local x, y = r.varint(), r.varint()
    p[1], p[2], p[3] = x, y, 15
    for k = 2, count do
      x = x + unzig(r.varint()); y = y + unzig(r.varint())
      p[#p + 1], p[#p + 2], p[#p + 3] = x, y, 15
      step()
    end
    local tool = (c == 7) and SCRAPE or PEN
    d.strokes[#d.strokes + 1] = { tool = tool, a = (c == 7) and 0 or c + 1, b = 0, mix = 0,
      size = OLD_WIDTHS[w] * 4, op = 255, p = p }
  end
  return d
end

local function decodeK2(b, n)
  local r = reader(b, n, 2)
  local d = { paper = clamp(r.byte(), 0, 1), inks = {}, strokes = {} }
  local count = r.byte()
  if count > 16 then error("inks", 0) end
  for i = 1, count do
    d.inks[i] = { rgb = { r.byte(), r.byte(), r.byte() }, flags = r.byte(), strength = r.byte() }
  end
  while r.more() and #d.strokes < MAX_STROKES do
    local s = { tool = r.byte(), a = r.byte(), b = r.byte(), mix = r.byte(), size = r.byte(), op = r.byte() }
    if s.tool > 3 or s.a > count or s.b > count or s.size < 1 then error("stroke", 0) end
    local pts = r.varint()
    if pts < 1 or pts > MAX_POINTS then error("points", 0) end
    local p = {}
    local x, y, pr = r.varint(), r.varint(), r.varint()
    p[1], p[2], p[3] = x, y, clamp(pr, 0, 15)
    for _ = 2, pts do
      x = x + unzig(r.varint()); y = y + unzig(r.varint()); pr = pr + unzig(r.varint())
      p[#p + 1], p[#p + 2], p[#p + 3] = x, y, clamp(pr, 0, 15)
      step()
    end
    s.p = p
    d.strokes[#d.strokes + 1] = s
  end
  return d
end

-- druh papíru kresby (0 pergamen, 1 papír) bez dekódování celé kresby
function P.paperOf(data)
  if type(data) ~= "string" or data:sub(1, 3) ~= "k2." then return 0 end
  local b = b64bytes(data:sub(1, 7), 4)
  return (b and b[2] == 1) and 1 or 0
end

-- data od hráčů: při chybě nil
function P.decode(data)
  if type(data) ~= "string" then return nil end
  local prefix = data:sub(1, 3)
  if prefix ~= "k1." and prefix ~= "k2." then return nil end
  local b, n = b64bytes(data, 4)
  if not b or n < 1 then return nil end
  local ok, d = pcall(function()
    if b[1] == 1 and prefix == "k1." then return decodeK1(b, n) end
    if b[1] == 2 and prefix == "k2." then return decodeK2(b, n) end
    error("version", 0)
  end)
  return ok and d or nil
end

function P.encode(d)
  local b, n = { 2 }, 1
  local function put(v) n = n + 1; b[n] = v end
  local function varint(v)
    while v >= 0x80 do put((v & 0x7f) | 0x80); v = v >> 7 end
    put(v)
  end
  local function zig(v) if v >= 0 then return v * 2 end return -v * 2 - 1 end
  put(d.paper or 0)
  put(#d.inks)
  for _, ink in ipairs(d.inks) do
    put(ink.rgb[1]); put(ink.rgb[2]); put(ink.rgb[3]); put(ink.flags or 0); put(ink.strength or 255)
  end
  for _, s in ipairs(d.strokes) do
    local p = s.p
    local count = #p // 3
    put(s.tool); put(s.a); put(s.b); put(s.mix); put(s.size); put(s.op)
    varint(count)
    varint(p[1]); varint(p[2]); varint(p[3])
    for k = 2, count do
      local i = 3 * k - 2
      varint(zig(p[i] - p[i - 3])); varint(zig(p[i + 1] - p[i - 2])); varint(zig(p[i + 2] - p[i - 1]))
    end
    step()
  end
  return "k2." .. b64encode(b, n)
end

-- ---------------------------------------------------------------------------
-- spotřeba: plocha tahu (logické px²) vážená krytím a sytostí - stejný vzorec má klient

local PRESSURE = {
  [PEN] = function(pr) return 0.3 + 0.7 * pr end,
  [BRUSH] = function(pr) return 0.55 + 0.45 * pr end,
  [CHARCOAL] = function(pr) return 0.7 + 0.3 * pr end,
  [SCRAPE] = function() return 1 end,
}
P.PRESSURE = PRESSURE

function P.strokeArea(s)
  local p = s.p
  local w = s.size / 4
  local area = 0
  for i = 4, #p - 2, 3 do
    local dx, dy = p[i] - p[i - 3], p[i + 1] - p[i - 2]
    local pr = (p[i + 2] + p[i - 1]) / 30
    area = area + sqrt(dx * dx + dy * dy) * w * PRESSURE[s.tool](pr)
  end
  return area + w * w                      -- i tečka něco stojí
end

-- ---------------------------------------------------------------------------
-- rastr: plátno = pole celých čísel 0xRRGGBB

local function newCanvas(w, h, rgb)
  local pix, c = {}, pack(rgb[1], rgb[2], rgb[3])
  for i = 1, w * h do pix[i] = c; if i % 1024 == 0 then step(32) end end
  return { w = w, h = h, pix = pix }
end

local function rect(cv, x, y, w, h, rgb)
  local W, pix, c = cv.w, cv.pix, pack(rgb[1], rgb[2], rgb[3])
  local x0, y0 = max(0, floor(x)), max(0, floor(y))
  local x1, y1 = min(cv.w, floor(x + w)), min(cv.h, floor(y + h))
  for yy = y0, y1 - 1 do
    local row = yy * W + 1
    for xx = x0, x1 - 1 do pix[row + xx] = c end
    step((x1 - x0) // 32 + 1)
  end
end

local function disc(cv, cx, cy, r, rgb)
  local W, pix, c = cv.w, cv.pix, pack(rgb[1], rgb[2], rgb[3])
  local rr = r * r + 0.25
  for yy = max(0, floor(cy - r)), min(cv.h - 1, floor(cy + r)) do
    local dy = yy + 0.5 - cy
    for xx = max(0, floor(cx - r)), min(cv.w - 1, floor(cx + r)) do
      local dx = xx + 0.5 - cx
      if dx * dx + dy * dy <= rr then pix[yy * W + xx + 1] = c end
    end
  end
end

-- barva papíru v bodě listu (lx, ly = px uvnitř listu, w, h = rozměr listu v px)
local function paperAt(kind, lx, ly, w, h, k)
  local base = P.PAPERS[kind] and P.PAPERS[kind].rgb or P.PAPERS[0].rgb
  local shade
  if kind == 1 then
    -- papír: jemný šum a svislé žebrování (chain lines) po ~110 logických px
    local chain = (floor(lx / k) % 110 < 2) and -7 or 0
    shade = (valueNoise(lx / (6 * k), ly / (6 * k), 11) - 0.5) * 4 + chain
  else
    -- pergamen: velké měkké skvrny
    shade = (valueNoise(lx / (40 * k), ly / (40 * k), 7) - 0.5) * 16 + (valueNoise(lx / (9 * k), ly / (9 * k), 8) - 0.5) * 5
  end
  local ex = min(lx, w - 1 - lx) / max(1, w * 0.12)
  local ey = min(ly, h - 1 - ly) / max(1, h * 0.12)
  local edge = min(1, ex, ey)
  shade = shade - (1 - edge) * (1 - edge) * 22
  shade = floor(shade / 3 + 0.5) * 3            -- odstíny po krocích: skvrny zůstanou, PNG se dobře zabalí
  return base[1] + shade, base[2] + shade, base[3] + shade * 1.25
end

local function fillPaper(cv, kind, ox, oy, w, h, k)
  local W, pix = cv.w, cv.pix
  for y = 0, h - 1 do
    local row = (oy + y) * W + ox + 1
    for x = 0, w - 1 do
      local r, g, b = paperAt(kind, x, y, w, h, k)
      pix[row + x] = pack(clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255))
    end
    step(w // 8 + 1)
  end
end

-- barva a způsob skládání tahu
local function strokeInk(s, inks)
  if s.tool == CHARCOAL then return CHARCOAL_RGB, "normal", 1 end
  if s.tool == SCRAPE then return nil, "scrape", 1 end
  local A = inks[s.a]
  if not A then return CHARCOAL_RGB, "multiply", 1 end
  local B = inks[s.b]
  local t = B and (s.mix / 255) or 0
  local rgb = B and P.mixRGB(A.rgb, B.rgb, t) or A.rgb
  local flags = ((t < 0.5) or not B) and (A.flags or 0) or (B.flags or 0)
  local strength = ((A.strength or 255) * (1 - t) + (B and (B.strength or 255) or 0) * t) / 255
  local mode = (flags & 1 == 1 or flags & 2 == 2) and "normal" or "multiply"
  return rgb, mode, strength, flags & 2 == 2
end

-- Jeden tah do plátna. Maska pokrytí (max přes otisky) se složí jednou, aby se krytí v rámci
-- tahu nesčítalo. box = list (x, y, w, h v px plátna), kx/ky = px plátna na logický px.
local function drawStroke(cv, s, inks, box, kx, ky, seed, paperKind)
  local p = s.p
  if #p < 3 then return end
  local k = min(kx, ky)
  local W, pix = cv.w, cv.pix
  local x0, y0, x1, y1 = box.x, box.y, box.x + box.w - 1, box.y + box.h - 1
  local tool = s.tool
  local rgb, mode, strength, gold = strokeInk(s, inks)
  local hardness = (tool == PEN and 0.85) or (tool == BRUSH and 0.25) or (tool == CHARCOAL and 0.55) or 0.6
  local baseR = max(0.45, (s.size / 4) * k / 2)
  local press = PRESSURE[tool]
  local mask = {}

  local function stamp(cx, cy, r, mul, pr)
    local rr = r * r
    local inner = r * hardness
    local span = max(0.001, r - inner)
    local ya, yb = max(y0, floor(cy - r)), min(y1, floor(cy + r))
    local xa, xb = max(x0, floor(cx - r)), min(x1, floor(cx + r))
    for yy = ya, yb do
      local dy = yy + 0.5 - cy
      local row = yy * W + 1
      for xx = xa, xb do
        local dx = xx + 0.5 - cx
        local d2 = dx * dx + dy * dy
        if d2 <= rr + 0.25 then
          local d = sqrt(d2)
          local cov = (d <= inner) and 1 or max(0, 1 - (d - inner) / span)
          if r < 1 then cov = max(cov, 0.6) end
          if tool == CHARCOAL then
            -- zrno papíru: uhel se chytá jen na vyvýšená místa, víc při větším přítlaku
            local grain = valueNoise(xx / 1.4, yy / 1.4, 3) * 0.7 + valueNoise(xx / 3.5, yy / 3.5, 5) * 0.3
            cov = cov * clamp((grain - (0.78 - 0.55 * pr)) * 3.2, 0, 1)
          end
          local v = cov * mul
          local idx = row + xx
          if v > (mask[idx] or 0) then mask[idx] = v end
        end
      end
    end
    step(((yb - ya + 1) * (xb - xa + 1)) // 16 + 1)
  end

  -- délka tahu kvůli ubývání inkoustu (logické px)
  local total = 0
  for i = 4, #p - 2, 3 do total = total + sqrt((p[i] - p[i - 3]) ^ 2 + (p[i + 1] - p[i - 2]) ^ 2) end
  local function load(L)
    if tool == PEN then return max(0.42, 1 - L / 1600) end
    if tool == BRUSH then return max(0.35, 1 - L / 2600) end
    return 1
  end
  local function taper(L)
    if tool ~= PEN or total < 12 then return 1 end
    local a = min(1, L / 10)
    local b = min(1, (total - L) / 14)
    return 0.35 + 0.65 * min(a, b)
  end

  local L = 0
  local px, py, ppr = box.x + p[1] * kx, box.y + p[2] * ky, p[3] / 15
  stamp(px, py, baseR * press(ppr) * taper(0), load(0), ppr)
  for i = 4, #p - 2, 3 do
    local x, y, pr = box.x + p[i] * kx, box.y + p[i + 1] * ky, p[i + 2] / 15
    local seg = sqrt((x - px) ^ 2 + (y - py) ^ 2)
    local segL = seg / k
    local n = max(1, math.ceil(seg / max(0.35, baseR * 0.3)))
    for t = 1, n do
      local f = t / n
      local Ld = L + segL * f
      local prr = ppr + (pr - ppr) * f
      stamp(px + (x - px) * f, py + (y - py) * f, baseR * press(prr) * taper(Ld), load(Ld), prr)
    end
    L = L + segL
    px, py, ppr = x, y, pr
  end

  -- kaňka: pero občas ukápne na začátku tahu (stejně při každém vykreslení)
  if tool == PEN and hash(seed, #p, 17) < 0.14 then
    local bx, by = box.x + p[1] * kx, box.y + p[2] * ky
    local br = baseR * (1.8 + hash(seed, 1, 18) * 1.4)
    for yy = max(y0, floor(by - br * 1.4)), min(y1, floor(by + br * 1.4)) do
      for xx = max(x0, floor(bx - br * 1.4)), min(x1, floor(bx + br * 1.4)) do
        local d = sqrt((xx + 0.5 - bx) ^ 2 + (yy + 0.5 - by) ^ 2)
        local edgeR = br * (0.75 + 0.5 * valueNoise(xx / 1.7, yy / 1.7, seed))
        if d <= edgeR then mask[yy * W + xx + 1] = 1 end
      end
    end
  end

  local op = (s.op / 255) * strength
  local ir, ig, ib = 0, 0, 0
  if rgb then ir, ig, ib = rgb[1] / 255, rgb[2] / 255, rgb[3] / 255 end
  local n = 0
  for idx, cov in pairs(mask) do
    local a = cov * op
    if tool == BRUSH then a = min(1, a * (1 + 0.7 * sin(math.pi * cov))) end   -- mokrý okraj
    if a > 0.004 then
      local c = pix[idx]
      local r, g, b = (c >> 16) & 255, (c >> 8) & 255, c & 255
      if mode == "multiply" then
        r, g, b = r * (1 - a + a * ir), g * (1 - a + a * ig), b * (1 - a + a * ib)
      elseif mode == "normal" then
        local cr, cg, cb = rgb[1], rgb[2], rgb[3]
        if gold then
          local xx, yy = (idx - 1) % W, (idx - 1) // W
          local glint = 0.78 + 0.45 * hash(xx // 2, yy // 2, 21)
          cr, cg, cb = min(255, cr * glint), min(255, cg * glint), min(255, cb * glint)
        end
        r, g, b = r + (cr - r) * a, g + (cg - g) * a, b + (cb - b) * a
      else -- seškrábání: zpátky k papíru, jen o kousek matnější
        local xx, yy = (idx - 1) % W - box.x, (idx - 1) // W - box.y
        local pr_, pg, pb = paperAt(paperKind, xx, yy, box.w, box.h, k)
        r, g, b = r + (pr_ * 0.96 - r) * a, g + (pg * 0.96 - g) * a, b + (pb * 0.95 - b) * a
      end
      pix[idx] = pack(clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255))
    end
    n = n + 1
    if n % 64 == 0 then step(4) end
  end
end

-- celá kresba do obdélníku listu
function P.drawSheet(cv, d, box, paperKind)
  local kx, ky = box.w / SRC_W, box.h / SRC_H
  fillPaper(cv, paperKind or d.paper or 0, box.x, box.y, box.w, box.h, min(kx, ky))
  for i, s in ipairs(d.strokes) do drawStroke(cv, s, d.inks, box, kx, ky, i, paperKind or d.paper or 0) end
end

-- deterministický "náhodný" generátor, aby dřevo vypadalo pokaždé stejně
local function lcg(seed)
  local s = seed
  return function() s = (s * 1103515245 + 12345) & 0x7fffffff; return s end
end

local function wood(cv)
  local W, H = cv.w, cv.h
  local plank = 64
  for y = 0, H - 1, plank do
    rect(cv, 0, y, W, plank, ((y // plank) % 2 == 0) and WOOD or WOOD_L)
    rect(cv, 0, y, W, 2, WOOD_D)
  end
  local rnd = lcg(7)
  for _ = 1, W * H // 1500 do
    local x, y = rnd() % W, rnd() % H
    local len = 30 + rnd() % 120
    rect(cv, x, y, min(len, W - x), 1, WOOD_D)
  end
  local f = 6
  rect(cv, 0, 0, W, f, SHADOW); rect(cv, 0, H - f, W, f, SHADOW)
  rect(cv, 0, 0, f, H, SHADOW); rect(cv, W - f, 0, f, H, SHADOW)
end

-- Plocha listů v obrázku: { [slot] = { x, y, w, h } } v pixelech - jen papír, na který se kreslí.
-- Stejná čísla dostane klient (normalizovaná), aby živé tahy seděly přesně na zapečený obraz.
-- kind "board" = dřevěná vývěska s listy v mřížce, "easel" = stojan, celý obrázek je jeden list.
function P.layout(kind, W, H, cols, rows)
  if kind == "easel" then
    local m = max(4, floor(W * 0.025))
    return { { x = m, y = m, w = W - 2 * m, h = H - 2 * m } }
  end
  local border, top = 14, 18
  local cellW, cellH = (W - 2 * border) / cols, (H - top - border) / rows
  local pw = floor(min(cellW * 0.88, cellH * 0.88 * 3 / 2))
  local ph = floor(pw * 2 / 3)
  local slots = {}
  for r = 0, rows - 1 do
    for c = 0, cols - 1 do
      local cx = border + cellW * c + cellW / 2
      local cy = top + cellH * r + cellH / 2
      slots[#slots + 1] = { x = floor(cx - pw / 2), y = floor(cy - ph / 2), w = pw, h = ph }
    end
  end
  return slots
end

-- sheets: { [slot] = data } -> plátno
function P.renderBoard(kind, W, H, cols, rows, sheets)
  local boxes = P.layout(kind, W, H, cols, rows)
  local cv
  if kind == "easel" then
    cv = newCanvas(W, H, EDGE)
    local b = boxes[1]
    local d = sheets[1] and P.decode(sheets[1])
    if d then
      P.drawSheet(cv, d, b)
    else
      fillPaper(cv, 0, b.x, b.y, b.w, b.h, b.w / SRC_W)
    end
    return cv
  end
  cv = newCanvas(W, H, WOOD)
  wood(cv)
  for slot, box in ipairs(boxes) do
    local data = sheets[slot]
    if data then
      rect(cv, box.x + 2, box.y + 3, box.w + 2, box.h + 2, SHADOW)
      rect(cv, box.x - 1, box.y - 1, box.w + 2, box.h + 2, EDGE)
      P.drawSheet(cv, P.decode(data) or { paper = 0, inks = {}, strokes = {} }, box)
      disc(cv, box.x + box.w / 2, box.y + 5, 3.2, PIN)
    end
  end
  return cv
end

-- ---------------------------------------------------------------------------
-- kvantizace median-cut: z tisíců odstínů nejvýš 256 barev palety PNG (bez řazení s porovnávačem,
-- jen přihrádky podle kanálu - jde to přerušovat v rámci rozpočtu ticku)

local function quantize(cv, maxColors)
  local pix = cv.pix
  local count, sr, sg, sb = {}, {}, {}, {}
  for i = 1, #pix do
    local c = pix[i]
    local key = (((c >> 19) & 31) << 10) | (((c >> 11) & 31) << 5) | ((c >> 3) & 31)
    local n = count[key]
    if n then
      count[key] = n + 1
      sr[key], sg[key], sb[key] = sr[key] + ((c >> 16) & 255), sg[key] + ((c >> 8) & 255), sb[key] + (c & 255)
    else
      count[key] = 1
      sr[key], sg[key], sb[key] = (c >> 16) & 255, (c >> 8) & 255, c & 255
    end
    if i % 1024 == 0 then step(16) end
  end
  local keys = {}
  for key in pairs(count) do keys[#keys + 1] = key end
  local function chan(key, ch) return (key >> (10 - 5 * ch)) & 31 end
  local function measure(box)
    local lo, hi, pop = { 31, 31, 31 }, { 0, 0, 0 }, 0
    for _, key in ipairs(box.keys) do
      for ch = 0, 2 do
        local v = chan(key, ch)
        if v < lo[ch + 1] then lo[ch + 1] = v end
        if v > hi[ch + 1] then hi[ch + 1] = v end
      end
      pop = pop + count[key]
    end
    local best, range = 0, -1
    for ch = 0, 2 do
      if hi[ch + 1] - lo[ch + 1] > range then best, range = ch, hi[ch + 1] - lo[ch + 1] end
    end
    box.ch, box.range, box.pop, box.lo, box.hi = best, range, pop, lo[best + 1], hi[best + 1]
    -- rozsah má přednost před počtem: i pár pixelů inkoustu dostane vlastní barvu a nesplyne s papírem
    box.score = (range > 0 and #box.keys > 1) and range * range * (1 + math.log(pop)) or -1
    step(#box.keys // 64 + 1)
  end
  local boxes = { { keys = keys } }
  measure(boxes[1])
  while #boxes < maxColors do
    local bi, bs = nil, 0
    for i, b in ipairs(boxes) do
      if b.score > bs then bi, bs = i, b.score end
    end
    if not bi then break end
    local box = boxes[bi]
    local buckets = {}
    for v = 0, 31 do buckets[v] = {} end
    for _, key in ipairs(box.keys) do
      local list = buckets[chan(key, box.ch)]
      list[#list + 1] = key
    end
    -- dělí se v půlce rozsahu kanálu (ne v mediánu počtu), aby se vzácné barvy oddělily od papíru
    local mid, a, b = (box.lo + box.hi) / 2, {}, {}
    for v = 0, 31 do
      local into = (v <= mid) and a or b
      for _, key in ipairs(buckets[v]) do into[#into + 1] = key end
    end
    if #b == 0 then
      box.score = -1
    else
      boxes[bi] = { keys = a }
      boxes[#boxes + 1] = { keys = b }
      measure(boxes[bi])
      measure(boxes[#boxes])
    end
  end
  local palette, index = {}, {}
  for i, box in ipairs(boxes) do
    local n, r, g, b = 0, 0, 0, 0
    for _, key in ipairs(box.keys) do
      n = n + count[key]
      r, g, b = r + sr[key], g + sg[key], b + sb[key]
      index[key] = i - 1
    end
    palette[i - 1] = { floor(r / n + 0.5), floor(g / n + 0.5), floor(b / n + 0.5) }
  end
  local out = {}
  for i = 1, #pix do
    local c = pix[i]
    out[i] = index[(((c >> 19) & 31) << 10) | (((c >> 11) & 31) << 5) | ((c >> 3) & 31)]
    if i % 1024 == 0 then step(8) end
  end
  return out, palette, #boxes
end

-- ---------------------------------------------------------------------------
-- PNG: paleta, 8 bitů na pixel, deflate s pevnými kódy

local CRC = {}
for i = 0, 255 do
  local c = i
  for _ = 1, 8 do
    if c & 1 == 1 then c = 0xEDB88320 ~ (c >> 1) else c = c >> 1 end
  end
  CRC[i] = c
end
local function crc32(s)
  local c = 0xFFFFFFFF
  for i = 1, #s do
    c = CRC[(c ~ s:byte(i)) & 0xFF] ~ (c >> 8)
    if i % 1024 == 0 then step(32) end
  end
  return c ~ 0xFFFFFFFF
end

local function rev(code, len)
  local r = 0
  for _ = 1, len do r = (r << 1) | (code & 1); code = code >> 1 end
  return r
end

local LEN_BASE = { 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258 }
local LEN_EXTRA = { 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 }
local DIST_BASE = { 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577 }
local DIST_EXTRA = { 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 }

local LEN_SYM = {}   -- délka -> { symbol, extra bity, hodnota }; 258 má vlastní symbol 285
for L = 3, 258 do
  local i = #LEN_BASE
  if L < 258 then
    i = #LEN_BASE - 1
    while LEN_BASE[i] > L do i = i - 1 end
  end
  LEN_SYM[L] = { 256 + i, LEN_EXTRA[i], L - LEN_BASE[i] }
end

local function distSym(d)
  for i = #DIST_BASE, 1, -1 do
    if d >= DIST_BASE[i] then return i - 1, DIST_EXTRA[i], d - DIST_BASE[i] end
  end
end

-- Huffmanovy délky kódů z četností, nejvýš `limit` bitů (při překročení se četnosti zploští a staví znovu)
local function codeLengths(freq, count, limit)
  local lengths = {}
  for s = 0, count - 1 do lengths[s] = 0 end
  local f = {}
  for s = 0, count - 1 do f[s] = freq[s] or 0 end
  while true do
    local nodes = {}
    for s = 0, count - 1 do
      if f[s] > 0 then nodes[#nodes + 1] = { w = f[s], sym = s } end
    end
    if #nodes == 0 then return lengths end
    if #nodes == 1 then lengths[nodes[1].sym] = 1 return lengths end
    table.sort(nodes, function(a, b) return a.w < b.w end)
    -- dvě fronty (listy seřazené, vnitřní uzly vznikají seřazeně) - O(n)
    local q2, i1, i2 = {}, 1, 1
    local function pop()
      local a, b = nodes[i1], q2[i2]
      if a and (not b or a.w <= b.w) then i1 = i1 + 1 return a end
      i2 = i2 + 1
      return b
    end
    for _ = 1, #nodes - 1 do
      local a, b = pop(), pop()
      q2[#q2 + 1] = { w = a.w + b.w, l = a, r = b }
    end
    local root = q2[#q2]
    local maxDepth = 0
    local stack = { { root, 0 } }
    while #stack > 0 do
      local e = table.remove(stack)
      local node, depth = e[1], e[2]
      if node.sym then
        lengths[node.sym] = depth
        if depth > maxDepth then maxDepth = depth end
      else
        stack[#stack + 1] = { node.l, depth + 1 }
        stack[#stack + 1] = { node.r, depth + 1 }
      end
    end
    if maxDepth <= limit then return lengths end
    for s = 0, count - 1 do
      if f[s] > 0 then f[s] = (f[s] + 1) // 2 end
    end
  end
end

-- kanonické kódy, už otočené pro zápis od nejnižšího bitu
local function canonical(lengths, count)
  local blCount, nextCode, codes = {}, {}, {}
  local maxLen = 0
  for s = 0, count - 1 do
    local l = lengths[s]
    if l > 0 then
      blCount[l] = (blCount[l] or 0) + 1
      if l > maxLen then maxLen = l end
    end
  end
  local code = 0
  for bits = 1, maxLen do
    code = (code + (blCount[bits - 1] or 0)) << 1
    nextCode[bits] = code
  end
  for s = 0, count - 1 do
    local l = lengths[s]
    if l > 0 then
      codes[s] = rev(nextCode[l], l)
      nextCode[l] = nextCode[l] + 1
    end
  end
  return codes
end

local CL_ORDER = { 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 }

-- zlib proud: hledání shod (běh, řádek nad, haš trojic) a jeden blok s dynamickými Huffmanovými kódy
local function zlib(raw, n, stride)
  -- 1) symboly: lit[k] = literál/délka, ext[k] = extra bity délky, dsym[k] = symbol vzdálenosti nebo -1
  local lit, lbits, lval, dsym, dbits, dval = {}, {}, {}, {}, {}, {}
  local k = 0
  local litFreq, distFreq = {}, {}
  local head = {}
  local function remember(pos)
    if pos + 2 <= n then head[(raw[pos] << 16) | (raw[pos + 1] << 8) | raw[pos + 2]] = pos end
  end
  local i = 1
  while i <= n do
    local best, dist = 0, 0
    if i > 1 then
      local prev, L = raw[i - 1], 0
      while L < 258 and i + L <= n and raw[i + L] == prev do L = L + 1 end
      best, dist = L, 1
    end
    if i > stride and best < 258 then
      local L = 0
      while L < 258 and i + L <= n and raw[i + L] == raw[i + L - stride] do L = L + 1 end
      if L > best then best, dist = L, stride end
    end
    if best < 258 and i + 2 <= n then
      local j = head[(raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2]]
      if j and i - j <= 32768 and i - j ~= 1 and i - j ~= stride then
        local L = 0
        while L < 258 and i + L <= n and raw[i + L] == raw[j + L] do L = L + 1 end
        if L > best + 1 then best, dist = L, i - j end
      end
    end
    k = k + 1
    if best >= 3 then
      local ls = LEN_SYM[best]
      lit[k], lbits[k], lval[k] = ls[1], ls[2], ls[3]
      local ds, nb, v = distSym(dist)
      dsym[k], dbits[k], dval[k] = ds, nb, v
      litFreq[ls[1]] = (litFreq[ls[1]] or 0) + 1
      distFreq[ds] = (distFreq[ds] or 0) + 1
      remember(i)
      if best > 3 then remember(i + best - 3) end
      i = i + best
      step(best // 8 + 1)
    else
      remember(i)
      local v = raw[i]
      lit[k], dsym[k] = v, -1
      litFreq[v] = (litFreq[v] or 0) + 1
      i = i + 1
      step()
    end
  end
  litFreq[256] = 1
  -- každá tabulka aspoň dva symboly: dekodér zlib nepřijme neúplný kód
  local function atLeastTwo(freq, a, b)
    local used = 0
    for _ in pairs(freq) do used = used + 1 end
    if used < 2 then
      if not freq[a] then freq[a] = 1 else freq[b] = 1 end
    end
  end
  atLeastTwo(distFreq, 0, 1)

  -- 2) kódy
  local litLen = codeLengths(litFreq, 286, 15)
  local distLen = codeLengths(distFreq, 30, 15)
  local litCodes, distCodes = canonical(litLen, 286), canonical(distLen, 30)
  local hlit, hdist = 286, 30
  while hlit > 257 and litLen[hlit - 1] == 0 do hlit = hlit - 1 end
  while hdist > 1 and distLen[hdist - 1] == 0 do hdist = hdist - 1 end

  -- délky kódů za sebou, zkrácené opakováním (16 = opakuj předchozí, 17/18 = nuly)
  local seq = {}
  for s = 0, hlit - 1 do seq[#seq + 1] = litLen[s] end
  for s = 0, hdist - 1 do seq[#seq + 1] = distLen[s] end
  local cl, clExtra, clFreq = {}, {}, {}
  local p = 1
  while p <= #seq do
    local v, run = seq[p], 1
    while p + run <= #seq and seq[p + run] == v do run = run + 1 end
    if v == 0 and run >= 3 then
      local r = math.min(run, 138)
      if r >= 11 then cl[#cl + 1], clExtra[#cl + 1] = 18, r - 11 else cl[#cl + 1], clExtra[#cl + 1] = 17, r - 3 end
      p = p + r
    elseif v ~= 0 and run >= 4 then
      cl[#cl + 1] = v
      local r = math.min(run - 1, 6)
      cl[#cl + 1], clExtra[#cl + 1] = 16, r - 3
      p = p + 1 + r
    else
      cl[#cl + 1] = v
      p = p + 1
    end
  end
  for _, c in ipairs(cl) do clFreq[c] = (clFreq[c] or 0) + 1 end
  atLeastTwo(clFreq, 0, 18)
  local clLen = codeLengths(clFreq, 19, 7)
  local clCodes = canonical(clLen, 19)
  local hclen = 19
  while hclen > 4 and clLen[CL_ORDER[hclen]] == 0 do hclen = hclen - 1 end

  -- 3) zápis
  local out, on = {}, 0
  local buf, cnt = 0, 0
  local function put(v, len)
    buf = buf | (v << cnt)
    cnt = cnt + len
    while cnt >= 8 do
      on = on + 1; out[on] = buf & 0xFF
      buf = buf >> 8; cnt = cnt - 8
    end
  end
  out[1], out[2], on = 0x78, 0x01, 2
  put(1, 1); put(2, 2)                                  -- poslední blok, dynamické kódy
  put(hlit - 257, 5); put(hdist - 1, 5); put(hclen - 4, 4)
  for j = 1, hclen do put(clLen[CL_ORDER[j]], 3) end
  for j, c in ipairs(cl) do
    put(clCodes[c], clLen[c])
    if c == 16 then put(clExtra[j], 2) elseif c == 17 then put(clExtra[j], 3) elseif c == 18 then put(clExtra[j], 7) end
  end
  for t = 1, k do
    local s = lit[t]
    put(litCodes[s], litLen[s])
    local ds = dsym[t]
    if ds >= 0 then
      if lbits[t] > 0 then put(lval[t], lbits[t]) end
      put(distCodes[ds], distLen[ds])
      if dbits[t] > 0 then put(dval[t], dbits[t]) end
    end
    if t % 512 == 0 then step(16) end
  end
  put(litCodes[256], litLen[256])
  if cnt > 0 then on = on + 1; out[on] = buf & 0xFF end

  local a, b = 1, 0
  for j = 1, n do
    a = (a + raw[j]) % 65521
    b = (b + a) % 65521
    if j % 1024 == 0 then step(32) end
  end
  local adler = (b << 16) | a
  out[on + 1] = (adler >> 24) & 0xFF
  out[on + 2] = (adler >> 16) & 0xFF
  out[on + 3] = (adler >> 8) & 0xFF
  out[on + 4] = adler & 0xFF
  return out, on + 4
end

local function bytesToString(t, n)
  local parts = {}
  for i = 1, n, 4096 do
    parts[#parts + 1] = string.char(table.unpack(t, i, math.min(n, i + 4095)))
    step()
  end
  return table.concat(parts)
end

local function chunk(kind, data)
  return string.pack(">I4", #data) .. kind .. data .. string.pack(">I4", crc32(kind .. data))
end

function P.png(cv)
  local W, H = cv.w, cv.h
  local idx, palette, ncol = quantize(cv, 256)
  local stride = W + 1
  local raw, n = {}, 0
  for y = 0, H - 1 do
    n = n + 1; raw[n] = 0                               -- filtr řádku: žádný
    local row = y * W
    for x = 1, W do n = n + 1; raw[n] = idx[row + x] end
    step(W // 32 + 1)
  end
  local z, zn = zlib(raw, n, stride)
  local plte = {}
  for i = 0, ncol - 1 do
    local c = palette[i]
    plte[#plte + 1] = string.char(c[1], c[2], c[3])
  end
  return "\137PNG\r\n\26\n"
    .. chunk("IHDR", string.pack(">I4I4BBBBB", W, H, 8, 3, 0, 0, 0))
    .. chunk("PLTE", table.concat(plte))
    .. chunk("IDAT", bytesToString(z, zn))
    .. chunk("IEND", "")
end

-- zápis tak, aby server nikdy nečetl napůl zapsaný soubor
function P.writeFile(path, bytes)
  local tmp = path .. ".tmp"
  local f, err = io.open(tmp, "wb")
  if not f then return false, err end
  f:write(bytes)
  f:close()
  os.remove(path)
  local ok, err2 = os.rename(tmp, path)
  if not ok then return false, err2 end
  return true
end

return P
