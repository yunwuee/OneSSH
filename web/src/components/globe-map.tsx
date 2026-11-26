import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { geoContains, geoDistance, geoGraticule10, geoOrthographic, geoPath, geoInterpolate, type GeoSphere } from 'd3-geo'
import { feature, mesh } from 'topojson-client'
import type { GeometryCollection, Topology } from 'topojson-specification'
import type { Feature, Geometry, LineString } from 'geojson'
import { ArrowsIn, Minus, Pause, Play, Plus } from '@phosphor-icons/react'
// 静止时用 1:50m（香港、新加坡等小地区才有轮廓），拖动 / 动画时换 1:110m 保证帧率
import world50 from 'world-atlas/countries-50m.json'
import world110 from 'world-atlas/countries-110m.json'
import { cn } from '@/lib/cn'
import { countryNameByNumeric } from '@/lib/countries'
import type { CountryStat } from '@/lib/use-locations'
import { countryFill, type MapOrigin, type MapPoint } from './world-map'

type CountryProps = { name: string }
type World = { features: Array<Feature<Geometry, CountryProps>>; borders: ReturnType<typeof mesh> }

function load(raw: unknown): World {
  const topo = raw as Topology<{ countries: GeometryCollection<CountryProps> }>
  return {
    features: (feature(topo, topo.objects.countries) as unknown as { features: Array<Feature<Geometry, CountryProps>> }).features,
    borders: mesh(topo, topo.objects.countries, (a, b) => a !== b),
  }
}
const FINE = load(world50)
const COARSE = load(world110)
const GRATICULE = geoGraticule10()
const SPHERE: GeoSphere = { type: 'Sphere' }

const W = 960
const H = 600
const BASE_R = 268
const MIN_ZOOM = 0.8
const MAX_ZOOM = 6
const AUTO_SPEED = 4 // 度 / 秒
const DRAG_SENS = 0.28

type Rot = [number, number]
type Tip = { x: number; y: number; title: string; subtitle?: string; lines?: string[]; color?: string }

/** 把任意 CSS 颜色（含 var() 与 color-mix()）解析成 canvas 能用的 rgb 字符串 */
function resolveColors(host: HTMLElement, values: Record<string, string>) {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  host.appendChild(probe)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    probe.style.color = ''
    probe.style.color = value
    out[key] = getComputedStyle(probe).color
  }
  probe.remove()
  return out
}

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180
const clampLat = (lat: number) => Math.max(-75, Math.min(75, lat))
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** 地点们的大致中心：经度用单位向量平均，避免跨 180° 经线时平均到地球另一面 */
function centroid(items: Array<{ lat: number; lon: number }>): Rot {
  if (!items.length) return [-105, -22]
  let x = 0
  let y = 0
  let lat = 0
  for (const p of items) {
    x += Math.cos((p.lon * Math.PI) / 180)
    y += Math.sin((p.lon * Math.PI) / 180)
    lat += p.lat
  }
  const lon = (Math.atan2(y, x) * 180) / Math.PI
  return [-lon, -clampLat((lat / items.length) * 0.75)]
}

export function GlobeMap({
  points,
  countries,
  origin,
  interactive = true,
  showArcs = true,
  selectedKey,
  onSelect,
  className,
  children,
}: {
  points: MapPoint[]
  countries: Map<string, CountryStat>
  origin?: MapOrigin
  interactive?: boolean
  showArcs?: boolean
  selectedKey?: string | null
  onSelect?: (key: string | null) => void
  className?: string
  children?: React.ReactNode
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const home = useMemo(() => centroid(origin ? [origin, ...points] : points), [origin, points])
  const [rot, setRot] = useState<Rot>(home)
  const [zoom, setZoom] = useState(1)
  const [moving, setMoving] = useState(false)
  const [auto, setAuto] = useState(() => localStorage.getItem('onessh-globe-auto') !== '0')
  const [tip, setTip] = useState<Tip | null>(null)
  const [dragging, setDragging] = useState(false)
  const [palette, setPalette] = useState<Record<string, string> | null>(null)
  const rotRef = useRef(rot)
  rotRef.current = rot
  const drag = useRef<{ x: number; y: number; rot: Rot; moved: boolean; t: number; vx: number; vy: number } | null>(null)
  const inertia = useRef<{ vx: number; vy: number } | null>(null)
  const tween = useRef<{ from: Rot; to: Rot; start: number; dur: number } | null>(null)
  const lastInteract = useRef(0)
  const idleTimer = useRef<number>()

  useEffect(() => localStorage.setItem('onessh-globe-auto', auto ? '1' : '0'), [auto])

  const projection = useMemo(
    () =>
      geoOrthographic()
        .scale(BASE_R * zoom)
        .translate([W / 2, H / 2])
        .rotate([rot[0], rot[1], 0])
        .clipAngle(90)
        .precision(0.6),
    [rot, zoom],
  )
  const svgPath = useMemo(() => geoPath(projection), [projection])
  const center: [number, number] = [-rot[0], -rot[1]]
  const visible = (lon: number, lat: number) => geoDistance([lon, lat], center) < Math.PI / 2 - 0.02

  // 主题切换（.dark 类变化）时重新解析配色
  useEffect(() => {
    const host = wrapRef.current
    if (!host) return
    const compute = () =>
      setPalette(
        resolveColors(host, {
          ocean1: 'var(--map-ocean-1)',
          ocean2: 'var(--map-ocean-2)',
          land: 'var(--map-land)',
          border: 'var(--map-border)',
          edge: 'var(--map-edge)',
          grid: 'var(--map-grid)',
          accent: 'var(--accent)',
          bg: 'var(--surface)',
          f1: countryFill(1),
          f2: countryFill(2),
          f3: countryFill(3),
          f4: countryFill(4),
          f5: countryFill(5),
        }),
      )
    compute()
    const observer = new MutationObserver(compute)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
    return () => observer.disconnect()
  }, [])

  // ── 画布：海洋、光照、经纬网、国家、国界、大气 ──
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !palette) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cw = Math.round(canvas.clientWidth * dpr)
    const ch = Math.round(canvas.clientHeight * dpr)
    if (!cw || !ch) return
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(cw / W, 0, 0, ch / H, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const path = geoPath(projection, ctx)
    const r = projection.scale()
    const [cx, cy] = projection.translate()
    const world = moving || dragging ? COARSE : FINE

    // 大气光晕
    const halo = ctx.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.16)
    halo.addColorStop(0, palette.accent.replace('rgb(', 'rgba(').replace(')', ', 0.28)'))
    halo.addColorStop(1, palette.accent.replace('rgb(', 'rgba(').replace(')', ', 0)'))
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(cx, cy, r * 1.16, 0, Math.PI * 2)
    ctx.fill()

    // 海洋：偏左上的径向渐变，形成球体立体感
    const ocean = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r)
    ocean.addColorStop(0, palette.ocean1)
    ocean.addColorStop(1, palette.ocean2)
    ctx.beginPath()
    path(SPHERE)
    ctx.fillStyle = ocean
    ctx.fill()

    ctx.beginPath()
    path(GRATICULE)
    ctx.strokeStyle = palette.grid
    ctx.lineWidth = 0.6
    ctx.stroke()

    // 先画所有空白国家，再画有服务器的国家（同色合批，路径数少一半）
    ctx.beginPath()
    const active: Array<[Feature<Geometry, CountryProps>, number]> = []
    for (const country of world.features) {
      const stat = countries.get(String(country.id ?? ''))
      if (stat?.count) active.push([country, stat.count])
      else path(country)
    }
    ctx.fillStyle = palette.land
    ctx.fill()
    for (const [country, count] of active) {
      ctx.beginPath()
      path(country)
      ctx.fillStyle = palette[`f${Math.min(count, 5)}`]
      ctx.fill()
    }
    ctx.beginPath()
    path(world.borders)
    ctx.strokeStyle = palette.border
    ctx.lineWidth = 0.6
    ctx.stroke()

    // 高光 + 边缘暗角：让平面投影看起来像一颗球
    const shade = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.45, r * 0.05, cx, cy, r * 1.02)
    shade.addColorStop(0, 'rgba(255,255,255,0.22)')
    shade.addColorStop(0.45, 'rgba(255,255,255,0)')
    shade.addColorStop(0.85, 'rgba(0,0,0,0.05)')
    shade.addColorStop(1, 'rgba(0,0,0,0.20)')
    ctx.beginPath()
    path(SPHERE)
    ctx.fillStyle = shade
    ctx.fill()
    ctx.strokeStyle = palette.edge
    ctx.lineWidth = 1
    ctx.stroke()
  }, [projection, palette, countries, moving, dragging])

  // 容器尺寸变化时重画（canvas 像素尺寸随 CSS 尺寸更新）
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => setRot((r) => [r[0] + 1e-9, r[1]]))
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  // ── 动画循环：惯性、补间、自转 ──
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      let next: Rot | null = null
      let animating = false
      if (tween.current) {
        const t = Math.min(1, (now - tween.current.start) / tween.current.dur)
        const k = ease(t)
        const { from, to } = tween.current
        let dl = to[0] - from[0]
        if (dl > 180) dl -= 360
        if (dl < -180) dl += 360
        next = [from[0] + dl * k, from[1] + (to[1] - from[1]) * k]
        animating = true
        if (t >= 1) tween.current = null
      } else if (inertia.current && !drag.current) {
        const v = inertia.current
        next = [rotRef.current[0] + v.vx * dt, clampLat(rotRef.current[1] + v.vy * dt)]
        const decay = Math.pow(0.04, dt)
        v.vx *= decay
        v.vy *= decay
        animating = true
        if (Math.abs(v.vx) < 0.6 && Math.abs(v.vy) < 0.6) inertia.current = null
      } else if (auto && !drag.current && now - lastInteract.current > 2500 && !selectedKey) {
        next = [rotRef.current[0] + AUTO_SPEED * dt, rotRef.current[1]]
        // 自转期间同样用 1:110m，停下来再换回精细轮廓
        animating = true
      }
      if (next) setRot([wrapLon(next[0]), next[1]])
      setMoving((m) => (m === animating ? m : animating))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [auto, selectedKey])

  const flyTo = useCallback((lon: number, lat: number, dur = 900) => {
    inertia.current = null
    tween.current = { from: rotRef.current, to: [-lon, -clampLat(lat)], start: performance.now(), dur }
    lastInteract.current = performance.now()
  }, [])

  // 外部选中某个落点（列表、URL ?host=）时把它转到正面
  useEffect(() => {
    if (!selectedKey) return
    const p = points.find((x) => x.key === selectedKey)
    if (p) flyTo(p.lon, p.lat)
  }, [selectedKey, points, flyTo])

  const toSvg = (clientX: number, clientY: number): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || !rect.width) return [W / 2, H / 2]
    return [((clientX - rect.left) / rect.width) * W, ((clientY - rect.top) / rect.height) * H]
  }

  const zoomBy = (factor: number) => {
    lastInteract.current = performance.now()
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)))
  }

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !interactive) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      lastInteract.current = performance.now()
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * Math.exp(-event.deltaY * 0.0015))))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [interactive])

  const showTip = (event: React.MouseEvent, content: Omit<Tip, 'x' | 'y'>) => {
    if (drag.current?.moved) return
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    setTip({ ...content, x: event.clientX - rect.left, y: event.clientY - rect.top })
  }

  // 悬停国家：反投影到经纬度再判断落在哪个国家（只有 SVG 覆盖层能收鼠标事件）
  const hoverFrame = useRef(0)
  const hoverCountry = (event: React.PointerEvent) => {
    if (drag.current || (event.target as Element).closest('[data-marker]')) return
    const { clientX, clientY } = event
    cancelAnimationFrame(hoverFrame.current)
    hoverFrame.current = requestAnimationFrame(() => {
      const [x, y] = toSvg(clientX, clientY)
      const ll = projection.invert?.([x, y])
      const r = projection.scale()
      if (!ll || Math.hypot(x - W / 2, y - H / 2) > r) return setTip(null)
      const hit = FINE.features.find((f) => geoContains(f, ll))
      if (!hit) return setTip(null)
      const id = String(hit.id ?? '')
      const stat = countries.get(id)
      const rect = wrapRef.current?.getBoundingClientRect()
      if (!rect) return
      setTip({
        x: clientX - rect.left,
        y: clientY - rect.top,
        title: countryNameByNumeric(id) ?? hit.properties?.name ?? '未知地区',
        subtitle: stat ? `${stat.count} 台服务器` : '暂无服务器',
        lines: stat?.hosts.slice(0, 6),
        color: stat ? 'var(--accent)' : undefined,
      })
    })
  }

  const scale = Math.max(1, zoom)
  const markerR = 5.5
  const showLabels = points.length <= 10 || zoom >= 2
  const ordered = [...points].sort((a, b) => Number(a.key === selectedKey) - Number(b.key === selectedKey))
  const originXY = origin && visible(origin.lon, origin.lat) ? projection([origin.lon, origin.lat]) : null

  return (
    <div ref={wrapRef} className={cn('globe-wrap relative w-full select-none', className)}>
      <div className="relative w-full" style={{ aspectRatio: `${W} / ${H}` }}>
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="服务器分布地球仪"
          className={cn('absolute inset-0 block h-full w-full touch-none', interactive && (dragging ? 'cursor-grabbing' : 'cursor-grab'))}
          onPointerDown={(event) => {
            if (!interactive || event.button !== 0) return
            ;(event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId)
            tween.current = null
            inertia.current = null
            drag.current = { x: event.clientX, y: event.clientY, rot: rotRef.current, moved: false, t: performance.now(), vx: 0, vy: 0 }
          }}
          onPointerMove={(event) => {
            const d = drag.current
            if (!d) return hoverCountry(event)
            const rect = svgRef.current?.getBoundingClientRect()
            if (!rect) return
            const dx = ((event.clientX - d.x) / rect.width) * W
            const dy = ((event.clientY - d.y) / rect.height) * H
            if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return
            if (!d.moved) {
              d.moved = true
              setDragging(true)
              setTip(null)
            }
            const k = DRAG_SENS / zoom
            const next: Rot = [wrapLon(d.rot[0] + dx * k), clampLat(d.rot[1] - dy * k)]
            const now = performance.now()
            const dt = Math.max(1, now - d.t) / 1000
            // 记录最近一段的角速度，松手后据此滑行
            d.vx = (next[0] - rotRef.current[0]) / dt
            d.vy = (next[1] - rotRef.current[1]) / dt
            if (Math.abs(d.vx) > 2000) d.vx = 0
            d.t = now
            lastInteract.current = now
            setRot(next)
          }}
          onPointerUp={() => {
            const d = drag.current
            if (d?.moved && performance.now() - d.t < 80) inertia.current = { vx: d.vx * 0.9, vy: d.vy * 0.9 }
            lastInteract.current = performance.now()
            setTimeout(() => (drag.current = null), 0)
            setDragging(false)
          }}
          onPointerLeave={() => {
            if (!drag.current) setTip(null)
          }}
          onDoubleClick={(event) => {
            if (!interactive) return
            const [x, y] = toSvg(event.clientX, event.clientY)
            const ll = projection.invert?.([x, y])
            if (ll && Math.hypot(x - W / 2, y - H / 2) <= projection.scale()) flyTo(ll[0], ll[1], 600)
            zoomBy(1.6)
          }}
          onClick={(event) => {
            if (!(event.target as Element).closest('[data-marker]') && !drag.current?.moved) onSelect?.(null)
          }}
        >
          <defs>
            <filter id="globe-glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="2.4" />
            </filter>
          </defs>

          {showArcs &&
            origin &&
            points.map((point) => {
              // 大圆航线：按球面插值采样，正交投影的 clipAngle 会自动裁掉背面那一段
              const interp = geoInterpolate([origin.lon, origin.lat], [point.lon, point.lat])
              const line: LineString = { type: 'LineString', coordinates: Array.from({ length: 33 }, (_, i) => interp(i / 32)) }
              const d = svgPath(line)
              if (!d) return null
              const active = !selectedKey || selectedKey === point.key
              return (
                <path
                  key={`arc-${point.key}`}
                  d={d}
                  fill="none"
                  stroke={point.color}
                  strokeOpacity={active ? 0.75 : 0.18}
                  strokeWidth={active ? 1.8 : 1}
                  strokeLinecap="round"
                  className="map-arc"
                  pointerEvents="none"
                />
              )
            })}

          {originXY && origin && (
            <g
              data-marker
              transform={`translate(${originXY[0]},${originXY[1]})`}
              onMouseMove={(event) => showTip(event, { title: origin.title, subtitle: origin.subtitle, color: 'var(--accent-2)' })}
              onMouseLeave={() => setTip(null)}
            >
              <circle r={markerR * 2.4} fill="var(--accent-2)" className="map-pulse" />
              <rect x={-markerR} y={-markerR} width={markerR * 2} height={markerR * 2} rx={markerR * 0.4} transform="rotate(45)" fill="var(--accent-2)" stroke="var(--surface)" strokeWidth={1.6} />
            </g>
          )}

          {ordered.map((point) => {
            if (!visible(point.lon, point.lat)) return null
            const xy = projection([point.lon, point.lat])
            if (!xy) return null
            // 越靠近球的边缘越小、越淡，增强纵深
            const depth = Math.cos(geoDistance([point.lon, point.lat], center))
            const selected = point.key === selectedKey
            const r = markerR * (selected ? 1.35 : 1) * (point.count && point.count > 1 ? 1.2 : 1) * (0.7 + depth * 0.3)
            return (
              <g
                key={point.key}
                data-marker
                transform={`translate(${xy[0]},${xy[1]})`}
                opacity={0.45 + depth * 0.55}
                className="cursor-pointer"
                onClick={(event) => {
                  event.stopPropagation()
                  if (drag.current?.moved) return
                  onSelect?.(selected ? null : point.key)
                  if (!selected) flyTo(point.lon, point.lat)
                }}
                onMouseMove={(event) => showTip(event, { title: point.title, subtitle: point.subtitle, lines: point.lines, color: point.color })}
                onMouseLeave={() => setTip(null)}
              >
                <circle r={r * 2.8} fill={point.color} className="map-pulse" />
                <circle r={r * 1.9} fill={point.color} opacity={0.35} filter="url(#globe-glow)" />
                {selected && <circle r={r * 2.1} fill="none" stroke={point.color} strokeWidth={2} />}
                <circle r={r} fill={point.color} stroke="var(--surface)" strokeWidth={2} />
                {point.count && point.count > 1 ? (
                  <text textAnchor="middle" dy="0.36em" fontSize={r * 1.25} fontWeight={700} fill="#fff" pointerEvents="none">
                    {point.count}
                  </text>
                ) : null}
                {(showLabels || selected) && depth > 0.25 && (
                  <text x={r + 5} dy="0.35em" fontSize={12.5} fontWeight={600} className="map-label" strokeWidth={3.4} pointerEvents="none">
                    {point.title}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {interactive && (
        <div className="absolute top-3 right-3 flex flex-col overflow-hidden rounded-[10px] border border-border bg-surface/85 shadow-card backdrop-blur">
          {[
            { label: '放大', icon: <Plus size={14} weight="bold" />, run: () => zoomBy(1.4) },
            { label: '缩小', icon: <Minus size={14} weight="bold" />, run: () => zoomBy(1 / 1.4) },
            {
              label: '复位',
              icon: <ArrowsIn size={14} weight="bold" />,
              run: () => {
                setZoom(1)
                onSelect?.(null)
                tween.current = { from: rotRef.current, to: home, start: performance.now(), dur: 900 }
              },
            },
            { label: auto ? '暂停自转' : '开始自转', icon: auto ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />, run: () => setAuto((a) => !a) },
          ].map((button) => (
            <button
              key={button.label}
              type="button"
              aria-label={button.label}
              title={button.label}
              onClick={button.run}
              className="grid size-8 place-items-center text-muted transition-colors hover:bg-surface-2 hover:text-text [&+button]:border-t [&+button]:border-border"
            >
              {button.icon}
            </button>
          ))}
        </div>
      )}

      {children}

      {tip && (
        <div
          className="pointer-events-none absolute z-20 max-w-[240px] min-w-[140px] rounded-[10px] border border-border bg-surface/95 px-3 py-2 text-[12px] shadow-pop backdrop-blur"
          style={{
            left: Math.min(Math.max(tip.x, 90), (wrapRef.current?.clientWidth ?? 9999) - 90),
            top: tip.y,
            transform: 'translate(-50%, calc(-100% - 14px))',
          }}
        >
          <p className="flex items-center gap-1.5 font-semibold text-text">
            {tip.color && <span className="size-2 shrink-0 rounded-full" style={{ background: tip.color }} />}
            <span className="truncate">{tip.title}</span>
          </p>
          {tip.subtitle && <p className="mt-0.5 text-muted">{tip.subtitle}</p>}
          {tip.lines && tip.lines.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 border-t border-border pt-1.5">
              {tip.lines.map((line) => (
                <li key={line} className="truncate font-mono text-[11px] text-text">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <span className="sr-only">缩放 {Math.round(scale * 100)}%</span>
    </div>
  )
}
