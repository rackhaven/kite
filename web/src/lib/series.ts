import type { SeriesResponse } from './types'

export type Unit = 'pct' | 'bytes' | 'bps' | 'watts' | 'celsius' | 'count'

export interface ChartSpec {
  id: string
  title: string
  unit: Unit
  series: { key: string; label: string }[]
  collapsed?: boolean
}

const num = (s: string) => Number(s)

/**
 * Turns a machine's metric keys into the charts the detail page draws, in a
 * fixed order. Docker keys, disk usage and CPU frequency are shown in
 * tables or not at all, so they never become charts.
 */
export function chartSpecs(keys: string[]): ChartSpec[] {
  const has = new Set(keys)
  const specs: ChartSpec[] = []
  const add = (spec: ChartSpec) => {
    if (spec.series.length) specs.push(spec)
  }
  const pick = (pairs: [string, string][]) => pairs.filter(([k]) => has.has(k)).map(([key, label]) => ({ key, label }))

  add({ id: 'cpu', title: 'CPU', unit: 'pct', series: pick([['cpu.total', 'total']]) })

  const cores = keys
    .filter((k) => /^cpu\.core\.\d+$/.test(k))
    .sort((a, b) => num(a.slice(9)) - num(b.slice(9)))
  add({ id: 'cores', title: 'CPU per core', unit: 'pct', collapsed: true, series: cores.map((k) => ({ key: k, label: `core ${k.slice(9)}` })) })

  add({ id: 'memory', title: 'Memory', unit: 'bytes', series: pick([['mem.used', 'used'], ['mem.total', 'total'], ['swap.used', 'swap used'], ['swap.total', 'swap total']]) })

  const gpus = [...new Set(keys.map((k) => /^gpu\.(\d+)\./.exec(k)?.[1]).filter((v): v is string => v !== undefined))].sort((a, b) => num(a) - num(b))
  for (const g of gpus) {
    add({ id: `gpu.${g}`, title: `GPU ${g}`, unit: 'pct', series: pick([[`gpu.${g}.util`, 'utilisation']]) })
    add({ id: `gpu.${g}.vram`, title: `GPU ${g} memory`, unit: 'bytes', series: pick([[`gpu.${g}.vram_used`, 'used'], [`gpu.${g}.vram_total`, 'total']]) })
  }

  add({
    id: 'power',
    title: 'Power',
    unit: 'watts',
    series: [
      ...pick([['power.cpu_w', 'CPU'], ['power.platform_w', 'platform'], ['battery.w', 'battery']]),
      ...pick(gpus.map((g) => [`gpu.${g}.power_w`, `GPU ${g}`] as [string, string])),
    ],
  })
  add({ id: 'battery', title: 'Battery', unit: 'pct', series: pick([['battery.pct', 'charge']]) })
  add({
    id: 'services',
    title: 'Systemd services',
    unit: 'count',
    series: pick([['systemd.running', 'running'], ['systemd.failed', 'failed'], ['systemd.total', 'total']]),
  })
  add({
    id: 'temps',
    title: 'Temperatures',
    unit: 'celsius',
    series: [...pick([['cpu.temp_c', 'CPU'], ['system.temp_c', 'System']]), ...pick(gpus.map((g) => [`gpu.${g}.temp_c`, `GPU ${g}`] as [string, string]))],
  })

  const groups = (prefix: string, suffixes: string[]) => {
    const names = new Set<string>()
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue
      for (const s of suffixes) if (k.endsWith('.' + s)) names.add(k.slice(prefix.length, -(s.length + 1)))
    }
    return [...names].sort()
  }
  for (const m of groups('disk.', ['read_bps', 'write_bps'])) {
    add({ id: `disk:${m}`, title: `Disk ${m}`, unit: 'bps', series: pick([[`disk.${m}.read_bps`, 'read'], [`disk.${m}.write_bps`, 'write']]) })
  }
  for (const n of groups('net.', ['rx_bps', 'tx_bps'])) {
    add({ id: `net:${n}`, title: `Network ${n}`, unit: 'bps', series: pick([[`net.${n}.rx_bps`, 'in'], [`net.${n}.tx_bps`, 'out']]) })
  }
  return specs
}

/** Inserts an all-null row wherever points are more than 3 steps apart. */
export function withGaps(rows: number[][], step: number): { ts: number[]; cols: (number | null)[][] } {
  const width = rows.length ? rows[0].length - 1 : 1
  const ts: number[] = []
  const cols: (number | null)[][] = Array.from({ length: width }, () => [])
  rows.forEach((r, i) => {
    if (i > 0 && r[0] - rows[i - 1][0] > 3 * step) {
      ts.push(rows[i - 1][0] + step)
      cols.forEach((c) => c.push(null))
    }
    ts.push(r[0])
    cols.forEach((c, j) => c.push(r[j + 1]))
  })
  return { ts, cols }
}

/**
 * Builds uPlot data for several keys: a shared, sorted time axis with nulls
 * where a key has no point and an all-null row in every gap. With bands,
 * each key contributes two columns: avg then max.
 */
export function alignSeries(data: Record<string, number[][]>, keys: string[], step: number, band: boolean): (number | null)[][] {
  const tsSet = new Set<number>()
  const maps = keys.map((k) => {
    const m = new Map<number, number[]>()
    for (const r of data[k] ?? []) {
      m.set(r[0], r)
      tsSet.add(r[0])
    }
    return m
  })
  const union = [...tsSet].sort((a, b) => a - b)
  const perKey = band ? 2 : 1
  const rows: (number | null)[][] = union.map((t) => {
    const row: (number | null)[] = [t]
    for (const m of maps) {
      const r = m.get(t)
      row.push(r ? r[1] : null)
      if (band) row.push(r ? (r[2] ?? r[1]) : null)
    }
    return row
  })
  const { ts, cols } = withGaps(rows as number[][], step)
  if (!rows.length) return [[], ...Array.from({ length: keys.length * perKey }, () => [])]
  return [ts, ...cols]
}

/** Rolling window of live points per key, in hub time. */
export class LiveBuffer {
  private data = new Map<string, number[][]>()
  latest = 0

  constructor(private windowSec: number) {}

  seed(resp: SeriesResponse) {
    for (const [k, rows] of Object.entries(resp.series)) {
      for (const r of rows) this.add(k, r[0], r[1])
    }
    this.trim()
  }

  push(ts: number, values: Record<string, number>) {
    for (const [k, v] of Object.entries(values)) this.add(k, ts, v)
    this.trim()
  }

  series(key: string): number[][] {
    return this.data.get(key) ?? []
  }

  keys(): string[] {
    return [...this.data.keys()]
  }

  private add(key: string, ts: number, v: number) {
    let rows = this.data.get(key)
    if (!rows) this.data.set(key, (rows = []))
    if (rows.length && ts <= rows[rows.length - 1][0]) return
    rows.push([ts, v])
    this.latest = Math.max(this.latest, ts)
  }

  private trim() {
    const cutoff = this.latest - this.windowSec
    for (const rows of this.data.values()) {
      let i = 0
      while (i < rows.length && rows[i][0] < cutoff) i++
      if (i) rows.splice(0, i)
    }
  }
}

/** Below this rate a link is idle: VPN keep-alives, stray broadcasts. */
export const IDLE_BPS = 1024

/** True when no value (and no peak, for averaged rows) of a chart reaches IDLE_BPS. */
export function isIdle(spec: ChartSpec, data: Record<string, number[][]>): boolean {
  return spec.series.every((s) => (data[s.key] ?? []).every((row) => row.slice(1).every((v) => !(v >= IDLE_BPS))))
}
