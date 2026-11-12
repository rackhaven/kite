import { describe, expect, it } from 'vitest'
import { alignSeries, chartSpecs, isIdle, LiveBuffer, withGaps } from './series'

describe('chartSpecs', () => {
  it('groups known keys in order', () => {
    const keys = [
      'net.wlan0.tx_bps', 'net.wlan0.rx_bps', 'disk./.used', 'disk./.read_bps', 'disk./.write_bps',
      'battery.w', 'battery.pct', 'gpu.0.temp_c', 'gpu.0.vram_total', 'gpu.0.vram_used', 'gpu.0.util',
      'mem.total', 'mem.used', 'cpu.core.1', 'cpu.core.0', 'cpu.total',
    ]
    expect(chartSpecs(keys).map((c) => c.id)).toEqual([
      'cpu', 'cores', 'memory', 'gpu.0', 'gpu.0.vram', 'power', 'battery', 'temps', 'disk:/', 'net:wlan0',
    ])
    const net = chartSpecs(keys).find((c) => c.id === 'net:wlan0')!
    expect(net.unit).toBe('bps')
    expect(net.series.map((s) => s.key)).toEqual(['net.wlan0.rx_bps', 'net.wlan0.tx_bps'])
  })

  it('ignores docker and groups per-core', () => {
    const keys = ['cpu.total', 'cpu.core.10', 'cpu.core.2', 'docker.proxy.cpu_pct', 'docker.proxy.mem', 'cpu.freq_mhz', 'disk./.used']
    const specs = chartSpecs(keys)
    expect(specs.map((c) => c.id)).toEqual(['cpu', 'cores'])
    const cores = specs[1]
    expect(cores.collapsed).toBe(true)
    expect(cores.series.map((s) => s.key)).toEqual(['cpu.core.2', 'cpu.core.10'])
  })

  it('omits groups with no keys', () => {
    expect(chartSpecs(['cpu.total', 'mem.used', 'mem.total']).map((c) => c.id)).toEqual(['cpu', 'memory'])
  })

  it('scales swap against its total, not just what is used', () => {
    // Without the total, a swap-used line has nothing to be read against.
    const m = chartSpecs(['mem.used', 'mem.total', 'swap.used', 'swap.total']).find((c) => c.id === 'memory')!
    expect(m.series.map((s) => s.key)).toEqual(['mem.used', 'mem.total', 'swap.used', 'swap.total'])
  })

  it('collects every power source into one chart', () => {
    const p = chartSpecs(['power.cpu_w', 'power.platform_w', 'gpu.1.power_w', 'battery.w']).find((c) => c.id === 'power')!
    expect(p.unit).toBe('watts')
    expect(p.series.map((s) => s.key)).toEqual(['power.cpu_w', 'power.platform_w', 'battery.w', 'gpu.1.power_w'])
  })

  it('charts systemd counts', () => {
    const s = chartSpecs(['systemd.total', 'systemd.running', 'systemd.failed']).find((c) => c.id === 'services')!
    expect(s.unit).toBe('count')
    expect(s.series.map((x) => x.key)).toEqual(['systemd.running', 'systemd.failed', 'systemd.total'])
  })

  // Every key protocol.Flatten can emit must be either charted or listed here
  // as deliberately shown elsewhere (tables) or not at all. Without this, a
  // collector can emit keys that no part of the page ever reads.
  it('every flattenable key is charted or explicitly accounted for', () => {
    const keys = [
      'cpu.total', 'cpu.core.0', 'cpu.freq_mhz', 'cpu.temp_c', 'system.temp_c',
      'mem.total', 'mem.used', 'swap.total', 'swap.used',
      'gpu.0.util', 'gpu.0.vram_used', 'gpu.0.vram_total', 'gpu.0.temp_c', 'gpu.0.power_w',
      'power.cpu_w', 'power.platform_w', 'battery.pct', 'battery.w',
      'disk./.used', 'disk./.total', 'disk./.read_bps', 'disk./.write_bps',
      'net.eth0.rx_bps', 'net.eth0.tx_bps',
      'docker.web.running', 'docker.web.cpu_pct', 'docker.web.mem',
      'systemd.total', 'systemd.running', 'systemd.failed',
    ]
    // Shown in a table or the latest sample, never as a chart.
    const tableOnly = new Set([
      'cpu.freq_mhz', 'disk./.used', 'disk./.total',
      'docker.web.running', 'docker.web.cpu_pct', 'docker.web.mem',
    ])
    // Flattenable, but no part of the page reads it yet. swap.total is charted
    // in its own change; keep the gap visible here rather than excusing it.
    const knownGaps = new Set(['swap.total'])
    const charted = new Set(chartSpecs(keys).flatMap((c) => c.series.map((s) => s.key)))
    const unaccounted = keys.filter((k) => !charted.has(k) && !tableOnly.has(k) && !knownGaps.has(k))
    expect(unaccounted).toEqual([])
  })
})

describe('gaps', () => {
  it('withGaps inserts a null row in a gap', () => {
    expect(withGaps([[0, 1], [5, 2], [100, 3]], 5)).toEqual({ ts: [0, 5, 10, 100], cols: [[1, 2, null, 3]] })
  })

  it('withGaps keeps contiguous data', () => {
    expect(withGaps([[0, 1], [5, 2], [10, 3]], 5)).toEqual({ ts: [0, 5, 10], cols: [[1, 2, 3]] })
  })

  it('alignSeries merges keys, fills missing points and inserts gaps', () => {
    const data = { a: [[0, 1], [5, 2], [100, 3]], b: [[5, 9]] }
    expect(alignSeries(data, ['a', 'b'], 5, false)).toEqual([[0, 5, 10, 100], [1, 2, null, 3], [null, 9, null, null]])
  })

  it('alignSeries with bands emits avg and max per key', () => {
    expect(alignSeries({ a: [[0, 1, 4], [60, 2, 5]] }, ['a'], 60, true)).toEqual([[0, 60], [1, 2], [4, 5]])
  })
})

describe('LiveBuffer', () => {
  it('trims to the window and drops stale ts', () => {
    const b = new LiveBuffer(900)
    b.push(0, { x: 1 })
    b.push(500, { x: 2 })
    b.push(1000, { x: 3 })
    expect(b.series('x')).toEqual([[500, 2], [1000, 3]])
    b.push(1000, { x: 99 })
    expect(b.series('x')).toEqual([[500, 2], [1000, 3]])
  })

  it('seed then push', () => {
    const b = new LiveBuffer(900)
    b.seed({ resolution: 'raw', step: 5, series: { 'cpu.total': [[100, 1], [105, 2]] } })
    b.push(110, { 'cpu.total': 3, 'mem.used': 7 })
    expect(b.series('cpu.total')).toEqual([[100, 1], [105, 2], [110, 3]])
    expect(b.series('mem.used')).toEqual([[110, 7]])
    expect(b.keys().sort()).toEqual(['cpu.total', 'mem.used'])
    expect(b.latest).toBe(110)
  })
})

describe('isIdle', () => {
  const spec = chartSpecs(['net.wg0.rx_bps', 'net.wg0.tx_bps'])[0]
  it('is idle when every point is zero or missing', () => {
    expect(isIdle(spec, { 'net.wg0.rx_bps': [[0, 0], [5, 0]], 'net.wg0.tx_bps': [] })).toBe(true)
    expect(isIdle(spec, { 'net.wg0.rx_bps': [[0, 0, 0], [60, 0, 0]] })).toBe(true)
  })
  it('is not idle when any point or peak reaches 1 KB/s', () => {
    expect(isIdle(spec, { 'net.wg0.rx_bps': [[0, 0], [5, 4096]] })).toBe(false)
    expect(isIdle(spec, { 'net.wg0.tx_bps': [[0, 0, 2048]] })).toBe(false)
  })
})

describe('isIdle threshold', () => {
  const spec = chartSpecs(['net.wg0.rx_bps', 'net.wg0.tx_bps'])[0]
  it('treats keep-alive trickles below 1 KB/s as idle', () => {
    expect(isIdle(spec, { 'net.wg0.rx_bps': [[0, 40], [5, 300]], 'net.wg0.tx_bps': [[0, 1023]] })).toBe(true)
  })
  it('a single burst of 1 KB/s or more counts as traffic', () => {
    expect(isIdle(spec, { 'net.wg0.rx_bps': [[0, 40], [5, 1024]] })).toBe(false)
  })
})

describe('system temperature', () => {
  it('temps chart includes the system sensor', () => {
    const temps = chartSpecs(['system.temp_c', 'gpu.1.temp_c']).find((c) => c.id === 'temps')!
    expect(temps.series.map((s) => s.key)).toEqual(['system.temp_c', 'gpu.1.temp_c'])
    expect(temps.series[0].label).toBe('System')
  })
})
