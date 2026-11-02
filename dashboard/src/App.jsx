import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const DEFAULT_BUILDER_PATH = './cpp/include/builder'
const BACKTEST_SETTINGS_KEY = 'quantogral.simpleBacktest.settings'
const GRID_SEARCH_SETTINGS_KEY = 'quantogral.gridSearch.settings'
const TRADE_INDICATOR_STYLES_KEY = 'quantogral.tradeChart.indicatorStyles'
const EXPLORER_SETTINGS_KEY = 'quantogral.projectExplorer.settings'
const SITE_THEME_KEY = 'quantogral.siteTheme'
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420

const FALLBACK_TIMEZONES = ['UTC', 'America/Chicago', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Australia/Sydney']
const TIMEZONE_OPTIONS = [...new Set(['UTC', ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : FALLBACK_TIMEZONES)])]
  .map((value) => ({ value, label: value }))
  .sort((left, right) => left.value === 'UTC' ? -1 : right.value === 'UTC' ? 1 : left.label.localeCompare(right.label))
const CURRENCY_OPTIONS = (() => {
  const codes = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY']
  const names = new Intl.DisplayNames(undefined, { type: 'currency' })
  return codes.filter((code) => /^[A-Z]{3}$/.test(code)).map((value) => ({ value, label: `${value} · ${names.of(value) || value}` }))
    .sort((left, right) => left.value === 'USD' ? -1 : right.value === 'USD' ? 1 : left.value.localeCompare(right.value))
})()

function loadTradeIndicatorStyles() {
  try {
    return JSON.parse(window.localStorage.getItem(TRADE_INDICATOR_STYLES_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function SearchableSelect({ value, options, onChange, placeholder = 'Search…', ariaLabel }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef(null)
  const selected = options.find((option) => option.value === value)
  const filtered = options.filter((option) => `${option.value} ${option.label}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 100)
  useEffect(() => {
    if (!open) return undefined
    const closeOnOutsideClick = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false) }
    const closeOnEscape = (event) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', closeOnOutsideClick)
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('pointerdown', closeOnOutsideClick); window.removeEventListener('keydown', closeOnEscape) }
  }, [open])
  return (
    <div className={`searchable-select ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button aria-expanded={open} aria-label={ariaLabel} className="searchable-select-toggle" onClick={() => { setOpen((current) => !current); setQuery('') }} type="button">
        <span>{selected?.label || value || 'Choose…'}</span><span aria-hidden="true">⌄</span>
      </button>
      {open && <div className="searchable-select-menu">
        <input autoFocus aria-label={`Search ${ariaLabel || 'options'}`} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} value={query} />
        <div className="searchable-select-options" role="listbox">
          {filtered.length ? filtered.map((option) => <button aria-selected={option.value === value} key={option.value} onClick={() => { onChange(option.value); setOpen(false); setQuery('') }} role="option" type="button">{option.label}</button>) : <span className="searchable-select-empty">No matches</span>}
        </div>
      </div>}
    </div>
  )
}

function parseCsvPreview(content, edgeRows = 100) {
  let header = null
  let dataRowCount = 0
  const firstRows = []
  const lastRows = []
  let row = []
  let cell = ''
  let quoted = false
  const finishRow = () => {
    row.push(cell)
    const values = row
    row = []
    cell = ''
    if (header === null) {
      header = values
      return
    }
    dataRowCount += 1
    const record = { lineNumber: dataRowCount + 1, values }
    if (firstRows.length < edgeRows * 2) firstRows.push(record)
    lastRows.push(record)
    if (lastRows.length > edgeRows) lastRows.shift()
  }
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (character === '"') {
      if (quoted && content[index + 1] === '"') { cell += '"'; index += 1 }
      else quoted = !quoted
    } else if (character === ',' && !quoted) {
      row.push(cell); cell = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && content[index + 1] === '\n') index += 1
      finishRow()
    } else {
      cell += character
    }
  }
  if (cell.length || row.length || header === null && content.length > 0) finishRow()
  const visibleRows = dataRowCount <= edgeRows * 2 ? firstRows.slice(0, dataRowCount) : [...firstRows.slice(0, edgeRows), ...lastRows]
  return { header: header ?? [], rows: visibleRows, dataRowCount, omittedRowCount: Math.max(0, dataRowCount - visibleRows.length) }
}

function WorkspaceDataTable({ columns, rows, rowNumber = (row, index) => row.lineNumber || index + 1, omittedRowCount = 0, totalRows = rows.length, edgeRows = 100 }) {
  const visibleRows = omittedRowCount > 0
    ? [...rows.slice(0, edgeRows), ...rows.slice(-edgeRows)]
    : rows
  return (
    <div className="workspace-preview-table-wrap">
      <div aria-label="Data preview table" className="csv-table-viewport" role="region" tabIndex="0">
        <table className="csv-data-table">
          <thead><tr><th className="csv-row-number">#</th>{columns.map((column, index) => <th key={index}>{column || `Column ${index + 1}`}</th>)}</tr></thead>
          <tbody>
            {(omittedRowCount > 0 ? visibleRows.slice(0, edgeRows) : visibleRows).map((row, index) => <tr key={row.lineNumber || index}><td className="csv-row-number">{rowNumber(row, index)}</td>{Array.from({ length: Math.max(columns.length, row.values.length) }, (_, columnIndex) => <td key={columnIndex}>{row.values[columnIndex] ?? ''}</td>)}</tr>)}
            {rows.length === 0 && <tr><td colSpan={columns.length + 1}>No data rows in this file.</td></tr>}
            {omittedRowCount > 0 && <tr className="csv-omitted-rows"><td colSpan={columns.length + 1}>… {omittedRowCount.toLocaleString()} rows omitted …</td></tr>}
            {omittedRowCount > 0 && visibleRows.slice(edgeRows).map((row, index) => <tr key={row.lineNumber || index + edgeRows}><td className="csv-row-number">{rowNumber(row, index + edgeRows)}</td>{Array.from({ length: Math.max(columns.length, row.values.length) }, (_, columnIndex) => <td key={columnIndex}>{row.values[columnIndex] ?? ''}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
      <div className="csv-preview-note">{omittedRowCount > 0 ? `Showing first ${edgeRows} and last ${edgeRows} of ${totalRows.toLocaleString()} data rows.` : `Showing all ${totalRows.toLocaleString()} data rows.`}</div>
    </div>
  )
}

function loadExplorerSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(EXPLORER_SETTINGS_KEY) || '{}')
    return {
      sidebarExpanded: typeof saved.sidebarExpanded === 'boolean' ? saved.sidebarExpanded : true,
      sidebarWidth: Number.isFinite(saved.sidebarWidth) ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, saved.sidebarWidth)) : 256,
      builderExpanded: typeof saved.builderExpanded === 'boolean' ? saved.builderExpanded : true,
      expandedNodes: saved.expandedNodes && typeof saved.expandedNodes === 'object' ? saved.expandedNodes : {},
    }
  } catch {
    return { sidebarExpanded: true, sidebarWidth: 256, builderExpanded: true, expandedNodes: {} }
  }
}

function loadSiteTheme() {
  try {
    return window.localStorage.getItem(SITE_THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function loadBacktestSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(BACKTEST_SETTINGS_KEY) || '{}')
    return {
      initial_capital: Number.isFinite(Number(saved.initial_capital)) ? Number(saved.initial_capital) : 100000,
      cost_bps: Number.isFinite(Number(saved.cost_bps)) ? Number(saved.cost_bps) : 0,
      fill_latency_seconds: Number.isFinite(Number(saved.fill_latency_seconds)) ? Number(saved.fill_latency_seconds) : 0,
      capital_allocation: saved.capital_allocation === 'EQUAL_PER_STRATEGY' ? 'EQUAL_PER_STRATEGY' : 'SHARED',
      bucket_capital_mode: saved.bucket_capital_mode === 'INDEPENDENT' ? 'INDEPENDENT' : 'SHARED',
      run_mode: ['BOTH', 'LONG_ONLY', 'SHORT_ONLY', 'COMPARE_ALL'].includes(saved.run_mode) ? saved.run_mode : 'BOTH',
      base_currency: /^[A-Z]{3}$/.test(saved.base_currency) ? saved.base_currency : 'USD',
      ignore_currency: Boolean(saved.ignore_currency),
    }
  } catch {
    return { initial_capital: 100000, cost_bps: 0, fill_latency_seconds: 0, capital_allocation: 'SHARED', bucket_capital_mode: 'SHARED', run_mode: 'BOTH', base_currency: 'USD', ignore_currency: false }
  }
}

function loadGridSearchSettings() {
  try {
    const settings = JSON.parse(window.localStorage.getItem(GRID_SEARCH_SETTINGS_KEY) || '{}')
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}
  } catch {
    return {}
  }
}

function localDateString(date) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return offsetDate.toISOString().slice(0, 10)
}

function defaultStartDate() {
  const date = new Date()
  date.setFullYear(date.getFullYear() - 1)
  return localDateString(date)
}

async function readApiJson(response, feature) {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    throw new Error(`The local Quantogral API did not return JSON for ${feature}. Make sure ./start.sh is running both the website and its local API; if it is, stop other Quantogral servers and restart it.`)
  }
  return response.json()
}

function findStrategyFolderKeys(nodes, strategies, parentKey = 'Builder') {
  const folderKeys = []
  for (const node of nodes) {
    const nodeKey = `${parentKey}/${node.name}`
    if (node.type === 'directory') {
      const childKeys = findStrategyFolderKeys(node.children || [], strategies, nodeKey)
      if (childKeys.length) folderKeys.push(nodeKey, ...childKeys)
    } else if (node.type === 'script' && nodeKey.includes('/strategies/') && strategies.some((strategy) => strategy.file === node.name)) {
      folderKeys.push(parentKey)
    }
  }
  return [...new Set(folderKeys)]
}

function FolderIcon() {
  return (
    <svg aria-hidden="true" className="tree-icon folder-icon" viewBox="0 0 18 16">
      <path d="M1.5 3.5h5l1.6 1.8h8.4v8.9H1.5z" />
      <path d="M1.5 5.3h15" />
    </svg>
  )
}

function ScriptIcon() {
  return (
    <svg aria-hidden="true" className="tree-icon script-icon" viewBox="0 0 16 18">
      <path d="M3 1.5h6l4 4v11H3z" />
      <path d="M9 1.5v4h4M5.5 9h5M5.5 12h5" />
    </svg>
  )
}

function setExplorerDragPreview(event) {
  const source = event.currentTarget
  const rect = source.getBoundingClientRect()
  const preview = source.cloneNode(true)
  preview.classList.add('tree-item-drag-preview')
  preview.style.width = `${rect.width}px`
  document.body.appendChild(preview)
  event.dataTransfer.setDragImage(preview, Math.min(28, rect.width / 2), rect.height / 2)
  window.setTimeout(() => preview.remove(), 0)
}

function listReferenceDatasets(nodes, parent = '') {
  return nodes.flatMap((node) => {
    const relativePath = parent ? `${parent}/${node.name}` : node.name
    if (node.type === 'directory') return listReferenceDatasets(node.children || [], relativePath)
    return /\.(csv|parquet|pq)$/i.test(node.name) ? [{ path: relativePath, label: relativePath }] : []
  })
}

function TreeNode({ node, nodeKey, expandedNodes, onToggle, strategies, onSelectStrategy, onSelectData, onOpenItemSettings, selectingStrategies = false, compileSelection = {}, onToggleCompileSelection, selectingDownloadFolder = false, onSelectDownloadFolder, isCodeWorkspace = false, onOpenWorkspaceFile }) {
  const isExpanded = Boolean(expandedNodes[nodeKey])
  const scope = nodeKey.startsWith('data/') ? 'data' : 'builder'
  const relativePath = nodeKey.replace(scope === 'data' ? /^data\/?/ : /^Builder\/?/, '')

  if (node.type !== 'directory') {
    const isStrategy = node.type === 'script' && node.name.toLowerCase().endsWith('.hpp') && nodeKey.includes('/strategies/')
    const strategy = isStrategy ? strategies.find((item) => item.file === relativePath || item.file.split('/').pop() === node.name) : null
    const isDataFile = node.type === 'file' && nodeKey.startsWith('data/') && ['.csv', '.parquet', '.pq'].includes(node.name.split('.').pop()?.toLowerCase().replace(/^/, '.'))
    const suffix = `.${node.name.split('.').pop()?.toLowerCase()}`
    const isEditableFile = isDataFile || ['.hpp', '.h', '.cpp', '.cc', '.cxx', '.c', '.py', '.txt', '.md', '.json', '.yaml', '.yml', '.toml', '.ini', '.sh'].includes(suffix)
    const dataPath = isDataFile ? `./${nodeKey}` : ''
    if (selectingStrategies && strategy) {
      return (
        <label className="compile-tree-strategy" title={`${strategy.name} · ${strategy.id}`}>
          <input checked={Boolean(compileSelection[strategy.id])} onChange={() => onToggleCompileSelection(strategy.id)} type="checkbox" />
          <ScriptIcon />
          <span className="compile-tree-strategy-name">{strategy.name}</span>
          <span className="compile-tree-strategy-id">{strategy.id}</span>
        </label>
      )
    }
    return (
      <div className="tree-node-row">
        <button
          className={`tree-item script-item ${strategy ? 'draggable-strategy' : ''} ${isDataFile ? 'draggable-data' : ''}`}
          draggable={Boolean(strategy || isDataFile)}
          onClick={() => isCodeWorkspace && isEditableFile ? onOpenWorkspaceFile({ scope, path: relativePath, name: node.name }) : strategy ? onSelectStrategy(strategy) : isDataFile && onSelectData(dataPath, node.name)}
          onDragStart={(event) => {
            if (strategy) event.dataTransfer.setData('application/x-quantogral-strategy', strategy.id)
            else if (isDataFile) event.dataTransfer.setData('application/x-quantogral-data-file', dataPath)
            else return
            event.dataTransfer.effectAllowed = 'copy'
            setExplorerDragPreview(event)
          }}
          title={isCodeWorkspace && isEditableFile ? `Open ${node.name}` : strategy ? `Drag or click to add ${strategy.name}` : isDataFile ? `Drag or click to add ${dataPath}` : node.name}
          type="button"
        >
          <span className="tree-indent" />
          <ScriptIcon />
          <span>{node.name}</span>
        </button>
        {!selectingStrategies && <button aria-label={`Settings for ${node.name}`} className="item-settings" onClick={() => onOpenItemSettings({ scope, path: relativePath, name: node.name, type: 'file', strategyId: strategy?.id })} title={`Settings for ${node.name}`} type="button">⚙</button>}
      </div>
    )
  }

  return (
    <div className="tree-node">
      <div className="tree-node-row">
        <button aria-expanded={isExpanded} className="tree-item directory-item" onClick={() => onToggle(nodeKey)} type="button">
          <span className="tree-chevron">{isExpanded ? '⌄' : '›'}</span>
          <FolderIcon />
          <span>{node.name}</span>
        </button>
        {selectingDownloadFolder && scope === 'data' && <button className="destination-select-button" onClick={() => onSelectDownloadFolder(relativePath ? `./data/${relativePath}` : './data')} type="button">Select</button>}
        {!selectingStrategies && <button aria-label={`Settings for ${node.name}`} className="item-settings" onClick={() => onOpenItemSettings({ scope, path: relativePath, name: node.name, type: 'directory' })} title={`Settings for ${node.name}`} type="button">⚙</button>}
      </div>
      {isExpanded && node.children?.length > 0 && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNode key={`${nodeKey}/${child.name}`} node={child} nodeKey={`${nodeKey}/${child.name}`} expandedNodes={expandedNodes} onToggle={onToggle} strategies={strategies} onSelectStrategy={onSelectStrategy} onSelectData={onSelectData} onOpenItemSettings={onOpenItemSettings} selectingStrategies={selectingStrategies} compileSelection={compileSelection} onToggleCompileSelection={onToggleCompileSelection} selectingDownloadFolder={selectingDownloadFolder} onSelectDownloadFolder={onSelectDownloadFolder} isCodeWorkspace={isCodeWorkspace} onOpenWorkspaceFile={onOpenWorkspaceFile} />
          ))}
        </div>
      )}
    </div>
  )
}

function ConfigField({ field, value, onChange }) {
  if (field.type === 'boolean') {
    return (
      <label className="config-toggle">
        <input checked={Boolean(value)} onChange={(event) => onChange(field.key, event.target.checked)} type="checkbox" />
        <span>{field.label || field.key}</span>
      </label>
    )
  }

  return (
    <label className="config-field">
      <span>{field.label || field.key}</span>
      {field.type === 'select' ? (
        <select onChange={(event) => onChange(field.key, event.target.value)} value={value ?? field.default}>
          {field.options.map((option) => <option key={option} value={option}>{option.replaceAll('_', ' ')}</option>)}
        </select>
      ) : field.type === 'text' ? (
        <input onChange={(event) => onChange(field.key, event.target.value)} type="text" value={value ?? field.default} />
      ) : (
        <input
          max={field.max}
          min={field.min}
          onChange={(event) => onChange(field.key, event.target.value === '' ? '' : Number(event.target.value))}
          step={field.step ?? 'any'}
          type="number"
          value={value ?? field.default}
        />
      )}
    </label>
  )
}

function StrategyParameterFields({ fields, values, onChange }) {
  const groups = new Map()
  for (const field of fields) {
    if (field.visibleWhen) {
      const selected = values[field.visibleWhen.key]
      if (!field.visibleWhen.values.includes(selected)) continue
    }
    const group = field.group || ''
    groups.set(group, [...(groups.get(group) || []), field])
  }
  return <div className="strategy-parameter-groups">{[...groups.entries()].map(([group, groupFields]) => <section className="strategy-parameter-group" key={group || 'general'}>{group && <h4>{group}</h4>}<div className="config-grid">{groupFields.map((field) => <ConfigField key={field.key} field={field} value={values[field.key]} onChange={onChange} />)}</div></section>)}</div>
}

function strategyDefaults(strategy) {
  return Object.fromEntries(strategy.parameters.map((field) => [field.key, field.default]))
}

function presetFieldSchema(field) {
  return JSON.stringify({ type: field.type, options: field.options || [] })
}

function presetIsStale(preset, strategy) {
  const current = Object.fromEntries(strategy.parameters.map((field) => [field.key, presetFieldSchema(field)]))
  const saved = preset.fields || {}
  return Object.keys(current).length !== Object.keys(saved).length || Object.entries(current).some(([key, schema]) => saved[key] !== schema && saved[key] !== JSON.parse(schema).type)
}

function reconcilePresetConfig(preset, strategy) {
  const result = {}
  const legacyKeys = { 'sizing.mode': 'pos_sizing_mode', 'sizing.qty': 'qty', 'sizing.equity_pct': 'equity_pct' }
  for (const field of strategy.parameters) {
    const savedKey = Object.hasOwn(preset.config || {}, field.key) ? field.key : legacyKeys[field.key]
    const savedSchema = preset.fields?.[savedKey]
    result[field.key] = savedKey && (savedSchema === presetFieldSchema(field) || savedSchema === field.type) && Object.hasOwn(preset.config || {}, savedKey)
      ? preset.config[savedKey]
      : field.default
  }
  return result
}

function PresetManagerDialog({ strategy, initialData, onPersist, onClose }) {
  const [data, setData] = useState(initialData || { presets: [], lastPresetId: null })
  const firstPreset = initialData?.presets?.[0]
  const [selectedId, setSelectedId] = useState(firstPreset?.id || '')
  const [name, setName] = useState(firstPreset?.name || '')
  const [config, setConfig] = useState(firstPreset ? reconcilePresetConfig(firstPreset, strategy) : strategyDefaults(strategy))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [presetRowSettingsId, setPresetRowSettingsId] = useState(null)
  const presetRowSettingsRef = useRef(null)
  const [unsavedPresetIds, setUnsavedPresetIds] = useState(() => new Set())
  const selected = data.presets.find((preset) => preset.id === selectedId)
  useEffect(() => {
    if (!presetRowSettingsId) return undefined
    const closeOnOutsideClick = (event) => { if (!presetRowSettingsRef.current?.contains(event.target)) setPresetRowSettingsId(null) }
    const closeOnEscape = (event) => { if (event.key === 'Escape') setPresetRowSettingsId(null) }
    window.addEventListener('pointerdown', closeOnOutsideClick)
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('pointerdown', closeOnOutsideClick); window.removeEventListener('keydown', closeOnEscape) }
  }, [presetRowSettingsId])
  const serializeConfig = (value) => JSON.stringify(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right)))
  const presetNeedsSave = Boolean(selected && (
    unsavedPresetIds.has(selectedId) ||
    selected.name !== name.trim() ||
    serializeConfig(selected.config) !== serializeConfig(config) ||
    presetIsStale(selected, strategy)
  ))
  function createPreset() {
    setPresetRowSettingsId(null)
    const id = globalThis.crypto?.randomUUID?.() || `preset-${Date.now()}`
    const preset = { id, name: 'New preset', config: strategyDefaults(strategy), fields: Object.fromEntries(strategy.parameters.map((field) => [field.key, presetFieldSchema(field)])) }
    const next = { ...data, presets: [...data.presets, preset], lastPresetId: id }
    setData(next)
    setSelectedId(id)
    setName(preset.name)
    setConfig(preset.config)
    setUnsavedPresetIds((current) => new Set(current).add(id))
  }

  async function savePreset() {
    if (!selected || !name.trim()) { setError('Enter a preset name.'); return }
    const fields = Object.fromEntries(strategy.parameters.map((field) => [field.key, presetFieldSchema(field)]))
    const updated = { ...selected, name: name.trim(), config, fields }
    const next = { ...data, presets: data.presets.map((preset) => preset.id === selectedId ? updated : preset), lastPresetId: selectedId }
    setSaving(true)
    setError('')
    try {
      const result = await onPersist(strategy.id, next)
      setData(result)
      setUnsavedPresetIds((current) => {
        const updatedIds = new Set(current)
        updatedIds.delete(selectedId)
        return updatedIds
      })
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setSaving(false)
    }
  }

  async function removePreset(presetId = selectedId) {
    if (!data.presets.some((preset) => preset.id === presetId)) return
    setPresetRowSettingsId(null)
    const remaining = data.presets.filter((preset) => preset.id !== presetId)
    const next = { presets: remaining, lastPresetId: remaining[0]?.id || null }
    setSaving(true)
    try {
      const result = await onPersist(strategy.id, next)
      setData(result)
      if (presetId === selectedId) {
        const nextSelected = result.presets[0]
        setSelectedId(nextSelected?.id || '')
        setName(nextSelected?.name || '')
        setConfig(nextSelected ? reconcilePresetConfig(nextSelected, strategy) : strategyDefaults(strategy))
      }
      setUnsavedPresetIds((current) => {
        const updatedIds = new Set(current)
        updatedIds.delete(presetId)
        return updatedIds
      })
    } catch (saveError) { setError(saveError.message) } finally { setSaving(false) }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section aria-labelledby="preset-manager-title" aria-modal="true" className="path-dialog preset-manager-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <button aria-label="Close preset manager" className="dialog-close-button" onClick={onClose} type="button">×</button>
        <div className="eyebrow">CODE WORKSPACE · STRATEGY PRESETS</div>
        <h2 id="preset-manager-title">{strategy.name} presets</h2>
        <div className="preset-manager-layout">
          <div className="preset-list">{data.presets.map((preset) => <div className={`preset-list-row ${preset.id === selectedId ? 'is-selected' : ''}`} key={preset.id} ref={presetRowSettingsId === preset.id ? presetRowSettingsRef : null}><button className="preset-list-select" onClick={() => { setSelectedId(preset.id); setName(preset.name); setConfig(reconcilePresetConfig(preset, strategy)); setPresetRowSettingsId(null) }} type="button">{preset.name}{presetIsStale(preset, strategy) && <small>STALE</small>}</button><button aria-expanded={presetRowSettingsId === preset.id} aria-label={`${preset.name} settings`} className="item-settings preset-row-settings" onClick={() => setPresetRowSettingsId((current) => current === preset.id ? null : preset.id)} title={`${preset.name} settings`} type="button">⚙</button>{presetRowSettingsId === preset.id && <div className="preset-row-menu"><button className="danger-button" disabled={saving} onClick={() => removePreset(preset.id)} type="button">Delete preset</button></div>}</div>)}<button className="preset-create-button" onClick={createPreset} type="button">+ New preset</button></div>
          {selected ? <div className="preset-editor">
            <label className="config-field"><span>Preset name</span><input onChange={(event) => setName(event.target.value)} value={name} /></label>
            {presetIsStale(selected, strategy) && <p className="input-help">This preset has changed fields. Matching name and type values are preserved; new or changed fields use current defaults. Save to update it.</p>}
            <StrategyParameterFields fields={strategy.parameters} onChange={(key, value) => setConfig((current) => ({ ...current, [key]: value }))} values={config} />
            {error && <p className="form-error">{error}</p>}
            <div className="dialog-actions"><button className={`primary-button preset-save-button ${!presetNeedsSave && !saving ? 'is-saved' : ''}`} disabled={saving || !name.trim() || !presetNeedsSave} onClick={savePreset} type="button">{saving ? 'Saving…' : presetNeedsSave ? 'Save preset' : 'Saved'}</button></div>
          </div> : <p className="input-help">Create a preset to save a reusable configuration for this strategy.</p>}
        </div>
      </section>
    </div>
  )
}

function BacktestSettingsPanel({ open, draft, error, onToggle, onChange, onSave, onCancel }) {
  return (
    <section className={`backtest-settings-panel ${open ? 'is-expanded' : ''}`}>
      <button aria-expanded={open} className="backtest-settings-panel-toggle" onClick={onToggle} type="button">
        <span className="tree-chevron">{open ? '⌄' : '›'}</span><strong>Simple Backtesting settings</strong><span className="backtest-settings-summary">Capital, currency, costs, allocation, latency</span>
      </button>
      {open && <div className="backtest-settings-panel-content">
        <div className="backtest-settings-fields">
          <label className="config-field"><span>Total starting capital</span><input min="0.01" onChange={(event) => onChange('initial_capital', event.target.value)} step="1000" type="number" value={draft.initial_capital} /></label>
          <label className="config-field"><span>Transaction cost (bps)</span><input min="0" onChange={(event) => onChange('cost_bps', event.target.value)} step="0.1" type="number" value={draft.cost_bps} /></label>
          <label className="config-field"><span>Fill latency (seconds)</span><input min="0" onChange={(event) => onChange('fill_latency_seconds', event.target.value)} step="0.001" type="number" value={draft.fill_latency_seconds} /><small>Used for quote/tick data. OHLCV backtests fill at the next bar open.</small></label>
          <label className="config-field"><span>Bucket capital</span><select onChange={(event) => onChange('bucket_capital_mode', event.target.value)} value={draft.bucket_capital_mode || 'SHARED'}><option value="SHARED">Shared portfolio across buckets</option><option value="INDEPENDENT">Independent buckets · split capital evenly</option></select><small>Independent mode divides total starting capital equally between buckets; each bucket trades only its own allocation.</small></label>
          <label className="config-field"><span>Strategy capital allocation</span><select onChange={(event) => onChange('capital_allocation', event.target.value)} value={draft.capital_allocation}><option value="SHARED">Shared available capital</option><option value="EQUAL_PER_STRATEGY">Split evenly among strategies</option></select><small>In independent bucket mode, the split applies within each bucket; otherwise it applies across the whole portfolio.</small></label>
          <label className="config-field"><span>Trade directions</span><select onChange={(event) => onChange('run_mode', event.target.value)} value={draft.run_mode}><option value="BOTH">Long and short</option><option value="LONG_ONLY">Long only</option><option value="SHORT_ONLY">Short only</option><option value="COMPARE_ALL">Compare all three</option></select><small>Compare runs Long and short, Long only, and Short only independently.</small></label>
          <label className="config-field"><span>Portfolio currency</span><SearchableSelect ariaLabel="portfolio currency" onChange={(value) => onChange('base_currency', value)} options={CURRENCY_OPTIONS} placeholder="Search currencies…" value={draft.base_currency || 'USD'} /><small>Currency used for account cash and portfolio reporting.</small></label>
          <label className="config-toggle"><input checked={Boolean(draft.ignore_currency)} onChange={(event) => onChange('ignore_currency', event.target.checked)} type="checkbox" /><span>Ignore currency conversion</span></label>
        </div>
        {!draft.ignore_currency && <p className="input-help">Buckets with assets in another currency need matching FX history added to that bucket.</p>}
        {error && <p className="form-error">{error}</p>}
        <div className="backtest-settings-panel-actions">
          <button className="secondary-button" onClick={onCancel} type="button">Cancel</button>
          <button className="primary-button" disabled={Number(draft.initial_capital) <= 0 || Number(draft.cost_bps) < 0 || Number(draft.fill_latency_seconds) < 0 || !/^[A-Z]{3}$/.test(draft.base_currency || '')} onClick={onSave} type="button">Save settings</button>
        </div>
      </div>}
    </section>
  )
}

function GridSearchSettingsPanel({ open, onToggle, settings }) {
  return <section className={`backtest-settings-panel ${open ? 'is-expanded' : ''}`}>
    <button aria-expanded={open} className="backtest-settings-panel-toggle" onClick={onToggle} type="button">
      <span className="tree-chevron">{open ? '⌄' : '›'}</span><strong>GridSearch settings</strong><span className="backtest-settings-summary">Configured separately from Simple Backtesting</span>
    </button>
    {open && <div className="backtest-settings-panel-content"><p className="input-help">GridSearch has its own saved settings. {Object.keys(settings).length ? `${Object.keys(settings).length} GridSearch option(s) are saved.` : 'No GridSearch options are configured yet.'} Its search options will be defined with the parameter-search workflow; Simple Backtesting settings are not used here.</p></div>}
  </section>
}

function DatasetSettingsDialog({ file, draft, error, saving, onChange, onSave, onClose }) {
  if (!file) return null
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section aria-labelledby="dataset-settings-title" aria-modal="true" className="path-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <button aria-label="Close dataset settings" className="dialog-close-button" onClick={onClose} type="button">×</button>
        <div className="eyebrow">DATA · SETTINGS</div>
        <h2 id="dataset-settings-title">{file.name}</h2>
        <p className="workspace-preview-path">{file.path}</p>
        <label className="config-field"><span>Timezone</span><SearchableSelect ariaLabel="dataset timezone" onChange={(value) => onChange('timezone', value)} options={TIMEZONE_OPTIONS} placeholder="Search timezones…" value={draft.timezone || 'UTC'} /><small>{draft.timezoneSource === 'embedded' ? 'UTC was detected in timestamp values.' : draft.timezoneSource === 'default' ? 'Defaulted to UTC; choose the source timezone if timestamps have no offset.' : 'Timezone used for timestamps without an explicit offset. Explicit offsets are honored.'}</small></label>
        <label className="config-field"><span>Asset currency</span><SearchableSelect ariaLabel="asset currency" onChange={(value) => onChange('currency', value)} options={CURRENCY_OPTIONS} placeholder="Search currencies…" value={draft.currency || 'USD'} /><small>{draft.currencySource === 'default' ? 'Defaulted to USD; choose the currency the asset is priced in.' : 'Currency used to interpret this asset’s prices.'}</small></label>
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions"><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-button" disabled={saving} onClick={onSave} type="button">{saving ? 'Saving…' : 'Save dataset settings'}</button></div>
      </section>
    </div>
  )
}

function EquityCurveChart({ scenarios, currency = 'USD' }) {
  const colors = { both: '#dc3038', long_only: '#a8232b', short_only: '#f07178' }
  const [hoveredPoint, setHoveredPoint] = useState(null)
  const series = scenarios.map((scenario) => {
    const curve = scenario.equityCurve || []
    const timestamps = scenario.equityTimestamps || []
    const initial = scenario.metrics?.initialEquity || 1
    let peak = initial
    const values = curve.map((equity, index) => {
      peak = Math.max(peak, equity)
      return { timestamp: timestamps[index] ?? index, equity, drawdownDollars: equity - peak, drawdownPct: peak > 0 ? (equity / peak - 1) * 100 : 0 }
    })
    return { id: scenario.scenarioId || 'both', label: scenario.scenarioLabel || 'Backtest', initial, values, points: values }
  }).filter((item) => item.values.length)
  if (!series.length) return null

  const timestamps = series.flatMap((item) => item.values.map((point) => point.timestamp))
  const timeMinimum = timestamps.reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY)
  const timeMaximum = timestamps.reduce((maximum, value) => Math.max(maximum, value), Number.NEGATIVE_INFINITY)
  const width = 900
  const left = 88
  const right = 14
  const plotWidth = width - left - right
  const xFor = (timestamp) => left + (timeMaximum === timeMinimum ? plotWidth / 2 : ((timestamp - timeMinimum) / (timeMaximum - timeMinimum)) * plotWidth)
  const equityValues = series.flatMap((item) => item.values.map((point) => point.equity))
  const drawdownDollars = series.flatMap((item) => item.values.map((point) => point.drawdownDollars))
  const drawdownPercentages = series.flatMap((item) => item.values.map((point) => point.drawdownPct))
  const formatCurrencyAxis = (value) => `${value < 0 ? '−' : ''}${Math.abs(value).toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 0 })}`
  const formatPercentAxis = (value) => `${value.toFixed(2)}%`
  const formatDateAxis = (timestamp) => {
    const date = new Date(timestamp)
    const day = String(date.getUTCDate()).padStart(2, '0')
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    const year = String(date.getUTCFullYear() % 100).padStart(2, '0')
    return `${day}/${month}/${year}`
  }
  const formatTooltipDate = (timestamp) => {
    const date = new Date(timestamp)
    return `${formatDateAxis(timestamp)} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`
  }
  const maxDrawdownDollars = drawdownDollars.reduce((maximum, value) => Math.max(maximum, -value), 0)
  const maxDrawdownPercent = drawdownPercentages.reduce((maximum, value) => Math.max(maximum, -value), 0)

  function renderPanel({ title, height, top, bottom, min, max, valueKey, format, showDates = false, fillDrawdown = false }) {
    const range = max - min || 1
    const plotHeight = height - top - bottom
    const yFor = (value) => top + ((max - value) / range) * plotHeight
    const yTicks = [max, max - range / 3, max - (2 * range) / 3, min]
    const tickCount = timeMinimum === timeMaximum ? 1 : 6
    const xTicks = Array.from({ length: tickCount }, (_, index) => timeMinimum + (timeMaximum - timeMinimum) * index / Math.max(1, tickCount - 1))
    function handlePointerMove(event) {
      const rect = event.currentTarget.getBoundingClientRect()
      const svgX = (event.clientX - rect.left) * width / rect.width
      const svgY = (event.clientY - rect.top) * height / rect.height
      if (svgX < left || svgX > width - right || svgY < top || svgY > height - bottom) {
        setHoveredPoint(null)
        return
      }
      const targetTimestamp = timeMinimum + ((svgX - left) / plotWidth) * (timeMaximum - timeMinimum)
      let nearest = null
      for (const item of series) {
        let low = 0
        let high = item.points.length
        while (low < high) {
          const middle = (low + high) >> 1
          if (item.points[middle].timestamp < targetTimestamp) low = middle + 1
          else high = middle
        }
        const candidates = [item.points[Math.max(0, low - 1)], item.points[Math.min(item.points.length - 1, low)]]
        const point = candidates.reduce((best, candidate) => Math.abs(candidate.timestamp - targetTimestamp) < Math.abs(best.timestamp - targetTimestamp) ? candidate : best)
        const pointY = yFor(point[valueKey])
        const distance = Math.abs(pointY - svgY)
        if (!nearest || distance < nearest.distance) nearest = { item, point, x: xFor(point.timestamp), y: pointY, distance }
      }
      if (nearest) setHoveredPoint({ ...nearest, panel: title })
    }
    const panelHover = hoveredPoint?.panel === title ? hoveredPoint : null
    const tooltipWidth = 226
    const tooltipHeight = 70
    const tooltipX = panelHover ? Math.max(left + 4, Math.min(width - right - tooltipWidth, panelHover.x + (panelHover.x < width - tooltipWidth - right - 12 ? 12 : -tooltipWidth - 12))) : 0
    const tooltipY = panelHover ? Math.max(top + 3, Math.min(height - bottom - tooltipHeight, panelHover.y - tooltipHeight - 8)) : 0
    const hoverProfit = panelHover ? panelHover.point.equity - panelHover.item.initial : 0
    const hoverProfitPct = panelHover && panelHover.item.initial ? hoverProfit / panelHover.item.initial * 100 : 0
    const signedMoney = (value) => `${value >= 0 ? '+' : '−'}${reportMoney(Math.abs(value), currency)}`
    const signedPercent = (value) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`
    return <svg aria-label={title} className={`equity-chart ${height < 150 ? 'is-drawdown-chart' : 'is-equity-chart'}`} key={title} onPointerLeave={() => setHoveredPoint(null)} onPointerMove={handlePointerMove} role="img" viewBox={`0 0 ${width} ${height}`}>
      {xTicks.map((timestamp, index) => <line className="equity-x-gridline" key={`x-${index}`} x1={xFor(timestamp)} x2={xFor(timestamp)} y1={top} y2={height - bottom} />)}
      {yTicks.map((value, index) => <g key={index}><line className={Math.abs(value) < range * 0.000001 ? 'equity-zero-line' : ''} x1={left} x2={width - right} y1={yFor(value)} y2={yFor(value)} /><text x={left - 10} y={yFor(value) + 3} textAnchor="end">{format(value)}</text></g>)}
      {showDates && xTicks.map((timestamp, index) => <text key={index} x={xFor(timestamp)} y={height - 4} textAnchor={index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle'}>{formatDateAxis(timestamp)}</text>)}
      {series.map((item) => {
        const points = item.points.map((point) => `${xFor(point.timestamp)},${yFor(point[valueKey])}`).join(' ')
        const firstX = xFor(item.points[0].timestamp)
        const lastX = xFor(item.points[item.points.length - 1].timestamp)
        const drawdownArea = `${firstX},${yFor(0)} ${points} ${lastX},${yFor(0)}`
        return <g key={item.id} style={{ '--curve-color': colors[item.id] || '#dc3038' }}>
          {fillDrawdown && <polygon className="equity-drawdown-fill" points={drawdownArea} />}
          <polyline points={points} />
        </g>
      })}
      {panelHover && <g className="equity-chart-hover" pointerEvents="none">
        <line className="equity-hover-crosshair" x1={panelHover.x} x2={panelHover.x} y1={top} y2={height - bottom} />
        <circle className="equity-hover-marker" cx={panelHover.x} cy={panelHover.y} r="4" style={{ '--curve-color': colors[panelHover.item.id] || '#dc3038' }} />
        <rect className="equity-hover-tooltip" height={tooltipHeight} rx="5" width={tooltipWidth} x={tooltipX} y={tooltipY} />
        <text className="equity-hover-tooltip-title" x={tooltipX + 8} y={tooltipY + 14}>{panelHover.item.label} · {formatTooltipDate(panelHover.point.timestamp)}</text>
        <text className="equity-hover-tooltip-text" x={tooltipX + 8} y={tooltipY + 29}>Equity: {reportMoney(panelHover.point.equity, currency)}</text>
        <text className="equity-hover-tooltip-text" x={tooltipX + 8} y={tooltipY + 44}>P&amp;L vs start: {signedMoney(hoverProfit)} ({signedPercent(hoverProfitPct)})</text>
        <text className="equity-hover-tooltip-text" x={tooltipX + 8} y={tooltipY + 59}>DD from peak: {reportMoney(panelHover.point.drawdownDollars, currency)} ({formatPercentAxis(panelHover.point.drawdownPct)})</text>
      </g>}
    </svg>
  }

  const equityMin = equityValues.reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY)
  const equityMax = equityValues.reduce((maximum, value) => Math.max(maximum, value), Number.NEGATIVE_INFINITY)
  const equityPadding = Math.max((equityMax - equityMin) * 0.06, Math.abs(equityMax) * 0.0005, 1)
  const dollarFloor = Math.max(maxDrawdownDollars * 1.08, 1)
  const percentFloor = Math.max(maxDrawdownPercent * 1.08, 0.01)

  return (
    <section aria-label="Backtest equity and drawdown charts" className="equity-chart-card">
      <div className="config-section-heading"><h3>Equity and drawdown</h3><span>Equity shown in account currency · hover a line for exact values</span></div>
      <div className="equity-chart-panel"><div className="equity-chart-panel-label">Equity value</div>{renderPanel({ title: 'Equity value over time', height: 270, top: 14, bottom: 12, min: equityMin - equityPadding, max: equityMax + equityPadding, valueKey: 'equity', format: formatCurrencyAxis })}</div>
      <div className="equity-chart-panel drawdown-chart-panel"><div className="equity-chart-panel-label">Drawdown ({currency})</div>{renderPanel({ title: `Drawdown in ${currency}`, height: 90, top: 8, bottom: 8, min: -dollarFloor, max: 0, valueKey: 'drawdownDollars', format: formatCurrencyAxis, fillDrawdown: true })}</div>
      <div className="equity-chart-panel drawdown-chart-panel"><div className="equity-chart-panel-label">Drawdown (%)</div>{renderPanel({ title: 'Drawdown in percent', height: 90, top: 8, bottom: 23, min: -percentFloor, max: 0, valueKey: 'drawdownPct', format: formatPercentAxis, showDates: true, fillDrawdown: true })}</div>
      <div className="equity-chart-legend">{series.map((item) => <span key={item.id} style={{ '--curve-color': colors[item.id] || '#dc3038' }}><i />{item.label}</span>)}</div>
    </section>
  )
}

function reportMoney(value, currency = 'USD') {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }) : '—'
}

function reportNumber(value, suffix = '', maximumFractionDigits = 2) {
  return Number.isFinite(value) ? `${value.toLocaleString(undefined, { maximumFractionDigits })}${suffix}` : '—'
}

function reportTimestamp(timestamp) {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function TradeVisualizer({ seriesOptions, onClose, focusedTrade }) {
  const focusedSeriesKey = focusedTrade ? `${focusedTrade.bucketId}:${focusedTrade.feedId}` : ''
  const [selectedSeriesKey, setSelectedSeriesKey] = useState(focusedSeriesKey || seriesOptions[0]?.key || '')
  const [chart, setChart] = useState(null)
  const selectedSeries = seriesOptions.find((series) => series.key === selectedSeriesKey) || seriesOptions[0]
  const feed = selectedSeries?.feed
  const trades = useMemo(() => selectedSeries?.trades || [], [selectedSeries])
  const indicators = useMemo(() => selectedSeries?.indicators || [], [selectedSeries])
  const [hiddenIndicators, setHiddenIndicators] = useState({})
  const [savedIndicatorStyles, setSavedIndicatorStyles] = useState(loadTradeIndicatorStyles)
  const [indicatorStyles, setIndicatorStyles] = useState(loadTradeIndicatorStyles)
  const [indicatorSettingsKey, setIndicatorSettingsKey] = useState(null)
  const indicatorSettingsRef = useRef(null)
  const [savedIndicatorKey, setSavedIndicatorKey] = useState(null)
  const chartWrapRef = useRef(null)
  const [viewportStartIndex, setViewportStartIndex] = useState(0)
  const [viewportPointCount, setViewportPointCount] = useState(210)
  const [viewportWidth, setViewportWidth] = useState(1000)
  const [chartError, setChartError] = useState(feed?.path ? '' : 'The market-data file for this series is unavailable.')
  const [loading, setLoading] = useState(Boolean(feed?.path))
  const [chartHover, setChartHover] = useState(null)
  useEffect(() => {
    if (!indicatorSettingsKey) return undefined
    const closeOnOutsideClick = (event) => { if (!indicatorSettingsRef.current?.contains(event.target)) setIndicatorSettingsKey(null) }
    const closeOnEscape = (event) => { if (event.key === 'Escape') setIndicatorSettingsKey(null) }
    window.addEventListener('pointerdown', closeOnOutsideClick)
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('pointerdown', closeOnOutsideClick); window.removeEventListener('keydown', closeOnEscape) }
  }, [indicatorSettingsKey])
  useEffect(() => {
    if (!savedIndicatorKey) return undefined
    const timeout = window.setTimeout(() => setSavedIndicatorKey(null), 900)
    return () => window.clearTimeout(timeout)
  }, [savedIndicatorKey])
  const loadSeries = useCallback(async () => {
    if (!feed?.path) return
    try {
      const query = new URLSearchParams({ path: feed.path, timezone: feed.timezone || 'UTC', tsUnit: feed.tsUnit || 'MILLISECONDS', dateFormat: feed.dateFormat || 'DDMMYYYY' })
      const response = await fetch(`/api/backtests/trade-chart?${query}`)
      const result = await readApiJson(response, 'trade chart')
      if (!response.ok) throw new Error(result.error || 'Could not load trade chart.')
      setChart(result)
    } catch (error) {
      setChartError(error.message)
    } finally {
      setLoading(false)
    }
  }, [feed])
  useEffect(() => {
    const hasValues = trades.length > 0 || indicators.some((indicator) => indicator.points?.length)
    if (!hasValues) return undefined
    const timeoutId = window.setTimeout(() => loadSeries(), 0)
    return () => window.clearTimeout(timeoutId)
  }, [loadSeries, trades, indicators])
  const points = useMemo(() => chart?.points || [], [chart])
  const height = 430
  const plot = { left: 70, right: 18, top: 22, bottom: 42 }
  const width = Math.max(700, viewportWidth)
  const fullWidth = Math.max(width, points.length * 5 + plot.left + plot.right)
  const plotWidth = width - plot.left - plot.right
  const plotHeight = height - plot.top - plot.bottom
  const step = 5
  useEffect(() => {
    const element = chartWrapRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const contentWidth = entries[0]?.contentRect.width || element.clientWidth
      setViewportWidth(contentWidth)
      setViewportPointCount(Math.max(80, Math.ceil((contentWidth - plot.left - plot.right) / step) + 4))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [chart, plot.left, plot.right, step])

  const viewportEndIndex = Math.min(points.length, viewportStartIndex + viewportPointCount)
  const viewportPoints = points.slice(viewportStartIndex, viewportEndIndex)
  const viewportStartTimestamp = viewportPoints[0]?.timestamp ?? Infinity
  const viewportEndTimestamp = viewportPoints.at(-1)?.timestamp ?? -Infinity
  const visibleTrades = trades.filter((trade) => trade.exitTimestamp >= viewportStartTimestamp && trade.entryTimestamp <= viewportEndTimestamp)
  const visibleFillPrices = visibleTrades.flatMap((trade) => [
    trade.entryTimestamp >= viewportStartTimestamp && trade.entryTimestamp <= viewportEndTimestamp ? trade.entryPrice : null,
    trade.exitTimestamp >= viewportStartTimestamp && trade.exitTimestamp <= viewportEndTimestamp ? trade.exitPrice : null,
  ])
  const visibleTracePrices = visibleTrades.flatMap((trade) => {
    if (trade.exitTimestamp <= trade.entryTimestamp) return []
    const start = Math.max(trade.entryTimestamp, viewportStartTimestamp)
    const end = Math.min(trade.exitTimestamp, viewportEndTimestamp)
    const priceAt = (timestamp) => trade.entryPrice + (trade.exitPrice - trade.entryPrice) * ((timestamp - trade.entryTimestamp) / (trade.exitTimestamp - trade.entryTimestamp))
    return end >= start ? [priceAt(start), priceAt(end)] : []
  })
  const visibleIndicators = indicators.filter((indicator) => hiddenIndicators[indicator.key] === true)
  const prices = viewportPoints.flatMap((point) => [point.high, point.low]).concat(visibleFillPrices, visibleTracePrices).filter(Number.isFinite)
  const minimum = prices.length ? Math.min(...prices) : 0
  const maximum = prices.length ? Math.max(...prices) : 1
  const padding = (maximum - minimum || Math.abs(maximum) * 0.01 || 1) * 0.08
  const yFor = (price) => plot.top + ((maximum + padding - price) / (maximum - minimum + padding * 2 || 1)) * plotHeight
  const xForIndex = (index) => plot.left + (index - viewportStartIndex) * step
  const lowerBoundTimestamp = (timestamp) => {
    let low = 0
    let high = points.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (points[middle].timestamp < timestamp) low = middle + 1
      else high = middle
    }
    return low
  }
  const indexForTimestamp = (timestamp) => {
    const low = lowerBoundTimestamp(timestamp)
    if (low >= points.length) return points.length - 1
    if (low > 0 && timestamp - points[low - 1].timestamp < points[low].timestamp - timestamp) return low - 1
    return low
  }
  const fillIndex = (timestamp) => points.length && timestamp >= points[0].timestamp && timestamp <= points.at(-1).timestamp ? indexForTimestamp(timestamp) : -1
  const xForTimestamp = (timestamp) => {
    if (!points.length) return plot.left
    if (points.length === 1) return plot.left + plotWidth / 2
    const rightIndex = lowerBoundTimestamp(timestamp)
    if (rightIndex === 0) {
      const interval = points[1].timestamp - points[0].timestamp || 1
      return xForIndex((timestamp - points[0].timestamp) / interval)
    }
    if (rightIndex >= points.length) {
      const previousIndex = points.length - 2
      const interval = points.at(-1).timestamp - points[previousIndex].timestamp || 1
      return xForIndex(points.length - 1 + (timestamp - points.at(-1).timestamp) / interval)
    }
    const leftIndex = rightIndex - 1
    const leftPoint = points[leftIndex]
    const rightPoint = points[rightIndex]
    const ratio = rightPoint.timestamp === leftPoint.timestamp ? 0 : (timestamp - leftPoint.timestamp) / (rightPoint.timestamp - leftPoint.timestamp)
    return xForIndex(leftIndex + ratio)
  }
  const scrollToTimestamp = (timestamp) => {
    if (!chartWrapRef.current || !points.length) return
    const targetX = (indexForTimestamp(timestamp) * step) + plot.left
    chartWrapRef.current.scrollTo({ left: Math.max(0, targetX - chartWrapRef.current.clientWidth / 2), behavior: 'smooth' })
  }
  useEffect(() => {
    if (!chart || !focusedTrade || selectedSeriesKey !== focusedSeriesKey) return undefined
    let low = 0
    let high = points.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (points[middle].timestamp < focusedTrade.entryTimestamp) low = middle + 1
      else high = middle
    }
    const pointIndex = Math.max(0, Math.min(points.length - 1, low))
    const frame = window.requestAnimationFrame(() => chartWrapRef.current?.scrollTo({ left: Math.max(0, pointIndex * step + plot.left - chartWrapRef.current.clientWidth / 2), behavior: 'smooth' }))
    return () => window.cancelAnimationFrame(frame)
  }, [chart, focusedTrade, focusedSeriesKey, selectedSeriesKey, points, step, plot.left])
  const fillEvents = visibleTrades.flatMap((trade) => [
    { trade, timestamp: trade.entryTimestamp, price: trade.entryPrice, action: trade.side === 'LONG' ? 'BUY' : 'SELL', orderName: trade.side === 'LONG' ? 'BLONG' : 'BSHORT', label: 'Entry' },
    { trade, timestamp: trade.exitTimestamp, price: trade.exitPrice, action: trade.side === 'LONG' ? 'SELL' : 'BUY', orderName: trade.side === 'LONG' ? 'SELL' : 'COVER', label: 'Exit' },
  ]).map((event) => ({ ...event, candleIndex: fillIndex(event.timestamp) })).filter((event) => event.candleIndex >= 0 && event.timestamp >= viewportStartTimestamp && event.timestamp <= viewportEndTimestamp)
  const dateLabel = (timestamp) => new Date(timestamp).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' })
  const visibleStart = points[0]?.timestamp
  const visibleEnd = points.at(-1)?.timestamp

  return <section aria-label="Trade series visualizer" className="trade-visualizer">
    <div className="trade-visualizer-heading"><div><span className="eyebrow">TRADE SERIES</span><h3>{selectedSeries?.label || 'Trades'} · {trades.length} trades</h3><p>Every entry and exit on this data feed is marked on the same OHLC timeline.</p></div><button aria-label="Close trade visualizer" className="secondary-button" onClick={onClose} type="button">Back to trades</button></div>
      <div className="trade-visualizer-toolbar"><label>Data series <select aria-label="Data series" onChange={(event) => { setSelectedSeriesKey(event.target.value); setChart(null); setViewportStartIndex(0); setChartHover(null); setLoading(true); setChartError('') }} value={selectedSeries?.key || ''}>{seriesOptions.map((series) => <option key={series.key} value={series.key}>{series.label} · {series.trades.length} trades</option>)}</select></label><div><button className="secondary-button" disabled={loading || !trades.length} onClick={() => scrollToTimestamp(trades[0].entryTimestamp)} type="button">First trade</button><button className="secondary-button" disabled={loading || !trades.length} onClick={() => scrollToTimestamp(trades.at(-1).exitTimestamp)} type="button">Last trade</button></div><span>{loading ? 'Loading full series…' : chart ? `${chart.totalPoints.toLocaleString()} candles · ${dateLabel(visibleStart)} — ${dateLabel(visibleEnd)} UTC · scroll horizontally; price scale follows view` : ''}</span></div>
    {indicators.length > 0 && <div aria-label="Indicator visibility" className="trade-indicator-controls"><strong>Indicators</strong>{indicators.map((indicator) => {
      const styleKey = indicator.preferenceKey || indicator.key
      const defaultStyle = { width: 1, alpha: 0.8, dash: 'solid' }
      const lineStyle = indicatorStyles[styleKey] || defaultStyle
      const savedStyle = savedIndicatorStyles[styleKey] || defaultStyle
      const styleNeedsSave = JSON.stringify(lineStyle) !== JSON.stringify(savedStyle)
      const isVisible = hiddenIndicators[indicator.key] === true
      const updateLineStyle = (changes) => {
        setSavedIndicatorKey(null)
        setIndicatorStyles((current) => ({ ...current, [styleKey]: { ...(current[styleKey] || defaultStyle), ...changes } }))
      }
      const saveLineStyle = () => {
        const updated = { ...savedIndicatorStyles, [styleKey]: lineStyle }
        setSavedIndicatorStyles(updated)
        setIndicatorStyles(updated)
        setSavedIndicatorKey(indicator.key)
        try { window.localStorage.setItem(TRADE_INDICATOR_STYLES_KEY, JSON.stringify(updated)) } catch { /* Browser storage may be unavailable. */ }
      }
      return <div className={`trade-indicator-control ${isVisible ? '' : 'is-hidden'}`} key={indicator.key} ref={indicatorSettingsKey === indicator.key ? indicatorSettingsRef : null} style={{ '--indicator-color': indicator.color }}>
        <button aria-pressed={isVisible} className="trade-indicator-toggle" onClick={() => setHiddenIndicators((current) => ({ ...current, [indicator.key]: current[indicator.key] !== true }))} title={`${isVisible ? 'Hide' : 'Show'} ${indicator.label}`} type="button"><span aria-hidden="true">{isVisible ? '◉' : '○'}</span>{indicator.label}</button>
        <button aria-expanded={indicatorSettingsKey === indicator.key} aria-label={`${indicator.label} line settings`} className="trade-indicator-cog" onClick={() => setIndicatorSettingsKey((current) => current === indicator.key ? null : indicator.key)} title={`${indicator.label} line settings`} type="button">⚙</button>
        {indicatorSettingsKey === indicator.key && <div className="trade-indicator-settings" onClick={(event) => event.stopPropagation()}>
          <div className="trade-indicator-settings-heading"><strong>Line style</strong><button aria-label="Close indicator line settings" onClick={() => setIndicatorSettingsKey(null)} type="button">×</button></div>
          <label>Line width <span>{lineStyle.width}px</span><input max="5" min="0.5" onChange={(event) => updateLineStyle({ width: Number(event.target.value) })} step="0.25" type="range" value={lineStyle.width} /></label>
          <label>Opacity <span>{Math.round(lineStyle.alpha * 100)}%</span><input max="1" min="0.1" onChange={(event) => updateLineStyle({ alpha: Number(event.target.value) })} step="0.05" type="range" value={lineStyle.alpha} /></label>
          <label>Line style<select onChange={(event) => updateLineStyle({ dash: event.target.value })} value={lineStyle.dash}><option value="solid">Solid</option><option value="dashed">Dashed</option></select></label>
          {(styleNeedsSave || savedIndicatorKey === indicator.key) && <button className={`trade-indicator-save-style ${savedIndicatorKey === indicator.key ? 'is-saved' : ''}`} disabled={savedIndicatorKey === indicator.key} onClick={saveLineStyle} type="button">{savedIndicatorKey === indicator.key ? 'Saved' : 'Save style'}</button>}
        </div>}
      </div>
    })}</div>}
    {chartError && <p className="form-error">{chartError}</p>}
    {points.length > 0 && <div className="trade-chart-wrap" onScroll={(event) => {
      const rawIndex = Math.floor(Math.max(0, event.currentTarget.scrollLeft - plot.left) / Math.max(step, 1))
      const nextStart = Math.max(0, Math.min(points.length - 1, rawIndex))
      setViewportStartIndex((current) => current === nextStart ? current : nextStart)
    }} ref={chartWrapRef}><div className="trade-chart-spacer" style={{ width: `${fullWidth}px` }}><svg aria-label="OHLC candles with trade entry and exit" className="trade-chart" onPointerMove={(event) => {
      const rect = event.currentTarget.getBoundingClientRect()
      const svgX = (event.clientX - rect.left) * width / rect.width
      const svgY = (event.clientY - rect.top) * height / rect.height
      if (svgX < plot.left || svgX > width - plot.right || svgY < plot.top || svgY > height - plot.bottom) {
        setChartHover(null)
        return
      }
      const index = Math.max(0, Math.min(points.length - 1, viewportStartIndex + Math.round((svgX - plot.left) / (step || 1))))
      const price = maximum + padding - ((svgY - plot.top) / plotHeight) * (maximum - minimum + padding * 2 || 1)
      setChartHover({ index, x: svgX, y: svgY, price })
    }} role="img" style={{ width: `${width}px` }} viewBox={`0 0 ${width} ${height}`}>
      <defs><clipPath id="trade-series-plot-clip"><rect height={plotHeight} width={plotWidth} x={plot.left} y={plot.top} /></clipPath></defs>
      {[0, 1, 2, 3].map((index) => { const y = plot.top + plotHeight * index / 3; const price = maximum + padding - (maximum - minimum + padding * 2) * index / 3; return <g key={index}><line className="trade-chart-grid" x1={plot.left} x2={width - plot.right} y1={y} y2={y} /><text x={plot.left - 9} y={y + 4} textAnchor="end">{reportNumber(price)}</text></g> })}
      <text className="trade-chart-axis-title" transform={`translate(13 ${plot.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">Price</text>
      {viewportPoints.map((point, localIndex) => { const index = viewportStartIndex + localIndex; const x = xForIndex(index); const candleWidth = Math.max(1, Math.min(6, step * 0.68)); const rising = point.close >= point.open; const color = rising ? '#56c596' : '#e36f76'; const bodyTop = Math.min(yFor(point.open), yFor(point.close)); const bodyHeight = Math.max(1, Math.abs(yFor(point.open) - yFor(point.close))); return <g key={point.timestamp}><title>{`${reportTimestamp(point.timestamp)} · O ${reportNumber(point.open)} H ${reportNumber(point.high)} L ${reportNumber(point.low)} C ${reportNumber(point.close)}`}</title><line stroke={color} strokeWidth="1" x1={x} x2={x} y1={yFor(point.high)} y2={yFor(point.low)} /><rect fill={color} height={bodyHeight} width={candleWidth} x={x - candleWidth / 2} y={bodyTop} /></g> })}
      {visibleIndicators.map((indicator) => { const indicatorPoints = (indicator.points || []).filter((point) => point.timestamp >= viewportStartTimestamp && point.timestamp <= viewportEndTimestamp); const coordinates = indicatorPoints.map((point) => `${xForTimestamp(point.timestamp)},${yFor(point.value)}`).join(' '); const lineStyle = indicatorStyles[indicator.preferenceKey || indicator.key] || { width: 1, alpha: 0.8, dash: 'solid' }; return coordinates ? <polyline className="trade-indicator-line" key={indicator.key} points={coordinates} style={{ '--indicator-color': indicator.color, '--indicator-width': lineStyle.width, '--indicator-opacity': lineStyle.alpha, '--indicator-dasharray': lineStyle.dash === 'dashed' ? '5 4' : 'none' }}><title>{indicator.label}</title></polyline> : null })}
      <g clipPath="url(#trade-series-plot-clip)">{visibleTrades.map((trade, index) => { const isLoss = Number(trade.profit) < 0; const colorClass = isLoss ? 'is-losing' : 'is-winning'; return <g className={colorClass} key={`${trade.bucketId}-${trade.instanceId}-${trade.entryTimestamp}-${index}`}><title>{`${trade.instrument || 'Trade'} · ${trade.side} · ${trade.strategyTag || trade.strategyName} · ${reportMoney(trade.profit)}`}</title><line className="trade-connector" style={{ stroke: isLoss ? '#ec747b' : '#51b88c' }} x1={xForTimestamp(trade.entryTimestamp)} x2={xForTimestamp(trade.exitTimestamp)} y1={yFor(trade.entryPrice)} y2={yFor(trade.exitPrice)} /></g> })}</g>
      <g clipPath="url(#trade-series-plot-clip)">{fillEvents.map((fill) => { const x = xForIndex(fill.candleIndex); const y = yFor(fill.price); const isBuy = fill.action === 'BUY'; const points = isBuy ? `${x},${y + 3} ${x - 5},${y + 12} ${x + 5},${y + 12}` : `${x},${y - 3} ${x - 5},${y - 12} ${x + 5},${y - 12}`; return <polygon aria-label={`${fill.orderName} ${fill.label} at ${reportNumber(fill.price)}`} className={isBuy ? 'trade-buy-arrow' : 'trade-sell-arrow'} key={`${fill.trade.bucketId}-${fill.trade.instanceId}-${fill.trade.entryTimestamp}-${fill.label}`} points={points}><title>{`${fill.orderName} ${fill.label} · ${reportNumber(fill.price)} · ${fill.trade.side} trade · P&L ${reportMoney(fill.trade.profit)}`}</title></polygon> })}</g>
      {Array.from({ length: 6 }, (_, index) => { const pointIndex = Math.min(points.length - 1, viewportStartIndex + Math.round((Math.max(1, viewportEndIndex - viewportStartIndex) - 1) * index / 5)); const point = points[pointIndex]; return <text key={index} textAnchor={index === 0 ? 'start' : index === 5 ? 'end' : 'middle'} x={xForIndex(pointIndex)} y={height - 12}>{dateLabel(point.timestamp)}</text> })}
    </svg></div></div>}
    {points.length > 0 && <div aria-live="polite" className="trade-chart-readout">
      {chartHover ? <><strong>{reportTimestamp(points[chartHover.index].timestamp)}</strong><span>O {reportNumber(points[chartHover.index].open)}</span><span>H {reportNumber(points[chartHover.index].high)}</span><span>L {reportNumber(points[chartHover.index].low)}</span><span>C {reportNumber(points[chartHover.index].close)}</span><span>Cursor {reportNumber(chartHover.price)}</span>{fillEvents.filter((fill) => fill.candleIndex === chartHover.index).slice(0, 2).map((fill) => <span className={`trade-chart-readout-order ${fill.action === 'BUY' ? 'trade-hover-buy' : 'trade-hover-sell'}`} key={fill.label + fill.trade.entryTimestamp}><b>{fill.orderName} {fill.label}</b> {reportNumber(fill.price)} · {fill.trade.strategyTag || fill.trade.strategyName} · P&amp;L {reportMoney(fill.trade.profit)}</span>)}</> : <span>Hover over a candle, entry, or exit to inspect OHLC and fill details.</span>}
    </div>}
    {points.length > 0 && visibleTrades.length === 0 && <p className="input-help">Scroll horizontally to the dates where this feed’s trades occurred.</p>}
  </section>
}

function correlationSeriesData(sources, frequency, { sharedCapital, startingCapital, strategyMode = false }) {
  const interval = frequency === 'hourly' ? 3_600_000 : 86_400_000
  const periods = [...new Set(sources.flatMap((source) => {
    const timestamps = source.timestamps
    return (timestamps || []).map((timestamp) => Math.floor(timestamp / interval))
  }))].sort((left, right) => left - right)
  const series = sources.map((source) => {
    const initial = source.initial
    const timestamps = source.timestamps
    const curve = source.curve
    const byPeriod = new Map()
    timestamps.forEach((timestamp, index) => byPeriod.set(Math.floor(timestamp / interval), curve[index] ?? initial))
    const activePeriods = [...byPeriod.keys()]
    const firstPeriod = activePeriods.length ? Math.min(...activePeriods) : Infinity
    const lastPeriod = activePeriods.length ? Math.max(...activePeriods) : -Infinity
    let current = initial
    let peak = initial
    let previous = initial
    const values = periods.map((period) => {
      if (byPeriod.has(period)) current = byPeriod.get(period)
      peak = Math.max(peak, current)
      const active = period >= firstPeriod && period <= lastPeriod
      const change = current - previous
      const point = {
        period,
        equity: current,
        contributionChange: active ? change : null,
        drawdownPct: !sharedCapital && active && peak > 0 ? (current / peak - 1) * 100 : null,
        drawdownDollars: active ? current - peak : null,
        returnPct: active && (strategyMode || sharedCapital ? startingCapital > 0 : previous > 0)
          ? (change / (strategyMode || sharedCapital ? startingCapital : previous)) * 100
          : null,
      }
      previous = current
      return point
    })
    return { id: source.id, label: source.label, initial, values, returns: values.map((point) => point.returnPct), drawdowns: values.map((point) => sharedCapital || strategyMode ? point.drawdownDollars : point.drawdownPct) }
  })
  const correlation = (left, right) => {
    if (left.length < 2 || left.length !== right.length) return null
    const pairs = left.flatMap((value, index) => Number.isFinite(value) && Number.isFinite(right[index]) ? [[value, right[index]]] : [])
    if (pairs.length < 2) return null
    const leftMean = pairs.reduce((sum, [value]) => sum + value, 0) / pairs.length
    const rightMean = pairs.reduce((sum, [, value]) => sum + value, 0) / pairs.length
    let covariance = 0
    let leftVariance = 0
    let rightVariance = 0
    for (const [leftValue, rightValue] of pairs) {
      const leftDelta = leftValue - leftMean
      const rightDelta = rightValue - rightMean
      covariance += leftDelta * rightDelta
      leftVariance += leftDelta * leftDelta
      rightVariance += rightDelta * rightDelta
    }
    return leftVariance > 0 && rightVariance > 0 ? covariance / Math.sqrt(leftVariance * rightVariance) : null
  }
  return { periods, series, correlation, sharedCapital, strategyMode }
}

function bucketCorrelationData(scenario, frequency) {
  const buckets = scenario.buckets || []
  const sharedCapital = scenario.bucketCapitalMode !== 'INDEPENDENT'
  return correlationSeriesData(buckets.map((bucket) => ({
    id: bucket.id,
    label: bucket.id,
    initial: sharedCapital ? 0 : (bucket.metrics?.initialEquity || 0),
    timestamps: sharedCapital ? (bucket.contributionTimestamps || []) : (bucket.equityTimestamps || []),
    curve: sharedCapital ? (bucket.contributionCurve || []) : (bucket.equityCurve || []),
  })), frequency, { sharedCapital, startingCapital: scenario.metrics?.initialEquity || 0 })
}

function strategyCorrelationData(scenario, bucket, frequency) {
  const strategies = bucket.strategies || []
  return correlationSeriesData(strategies.map((strategy) => ({
    id: strategy.instanceId,
    label: strategy.strategyTag || `${strategy.name || 'Strategy'}#${strategy.instanceId}`,
    initial: 0,
    timestamps: strategy.contributionTimestamps || [],
    curve: strategy.contributionCurve || [],
  })), frequency, { sharedCapital: true, startingCapital: scenario.metrics?.initialEquity || 0, strategyMode: true })
}

function correlationCellStyle(value) {
  if (!Number.isFinite(value)) return { background: '#272c31', color: '#8d979f' }
  const stops = value < 0
    ? [[37, 99, 235], [48, 52, 58], Math.abs(value)]
    : [[48, 52, 58], [220, 48, 56], value]
  const [from, to, amount] = stops
  const rgb = from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount))
  return { background: `rgb(${rgb.join(' ')})`, color: '#fff' }
}

function BucketCorrelationMatrix({ scenario, frequency, onFrequencyChange }) {
  const buckets = scenario.buckets || []
  const bucketData = bucketCorrelationData(scenario, frequency)
  const strategyDataByBucket = buckets.map((bucket) => ({ bucket, data: strategyCorrelationData(scenario, bucket, frequency) }))
  const renderMatrix = (data, title, valuesKey) => <section className="bucket-correlation-section"><h4>{title}</h4><div className="bucket-correlation-table-wrap"><table className="bucket-correlation-table"><thead><tr><th></th>{data.series.map((series) => <th key={series.id}>{series.label}</th>)}</tr></thead><tbody>{data.series.map((row, rowIndex) => <tr key={row.id}><th>{row.label}</th>{data.series.map((column, columnIndex) => { if (columnIndex >= rowIndex) return <td aria-hidden="true" className="correlation-empty-cell" key={column.id} />; const value = data.correlation(row[valuesKey], column[valuesKey]); return <td key={column.id} style={correlationCellStyle(value)}>{Number.isFinite(value) ? value.toFixed(2) : '—'}</td> })}</tr>)}</tbody></table></div></section>
  return <div className="bucket-correlation-view">
    <div className="bucket-correlation-heading"><div><h3>Correlation · {scenario.scenarioLabel}</h3><p>All series are aligned to the same daily or hourly UTC intervals. Strategy curves show attributed P&amp;L contributions, including when strategies share capital.</p></div><label>Aggregation<select onChange={(event) => onFrequencyChange(event.target.value)} value={frequency}><option value="daily">Daily</option><option value="hourly">Hourly</option></select></label></div>
    {buckets.length > 1 && (bucketData.series.length < 2 || bucketData.periods.length < 2
      ? <p className="input-help">Not enough bucket history to calculate bucket correlations.</p>
      : <div className="correlation-matrix-pair">{renderMatrix(bucketData, bucketData.sharedCapital ? 'Bucket contribution return correlation' : 'Bucket equity return correlation', 'returns')}{renderMatrix(bucketData, bucketData.sharedCapital ? 'Bucket contribution drawdown ($) correlation' : 'Bucket drawdown level correlation', 'drawdowns')}</div>)}
    {strategyDataByBucket.map(({ bucket, data }) => <section className="bucket-correlation-section" key={bucket.id}><h3>{buckets.length > 1 ? `${bucket.id} · strategy correlation` : 'Strategy correlation'}</h3>
      {data.series.length < 2 || data.periods.length < 2 ? <p className="input-help">Not enough strategy history in {bucket.id} to calculate strategy correlations.</p> : <div className="correlation-matrix-pair">{renderMatrix(data, 'Strategy return correlation', 'returns')}{renderMatrix(data, 'Strategy contribution drawdown ($) correlation', 'drawdowns')}</div>}
    </section>)}
  </div>
}

function regressionForReference(referencePoints, responsePoints, frequency, contributionBase = null) {
  const interval = frequency === 'hourly' ? 3_600_000 : 86_400_000
  const benchmarkLevels = new Map()
  const responseLevels = new Map()
  referencePoints.forEach((point) => benchmarkLevels.set(Math.floor(point.timestamp / interval), point.price))
  responsePoints.forEach((point) => responseLevels.set(Math.floor(point.timestamp / interval), point.value))
  const matchedPeriods = [...benchmarkLevels.keys()].filter((period) => responseLevels.has(period)).sort((left, right) => left - right)
  const x = []
  const y = []
  for (let index = 1; index < matchedPeriods.length; index += 1) {
    const previousPeriod = matchedPeriods[index - 1]
    const currentPeriod = matchedPeriods[index]
    const previousBenchmark = benchmarkLevels.get(previousPeriod)
    const currentBenchmark = benchmarkLevels.get(currentPeriod)
    const previousResponse = responseLevels.get(previousPeriod)
    const currentResponse = responseLevels.get(currentPeriod)
    if (!(previousBenchmark > 0) || !(previousResponse > 0) && contributionBase === null) continue
    const xReturn = (currentBenchmark / previousBenchmark - 1) * 100
    const yReturn = contributionBase === null
      ? (currentResponse / previousResponse - 1) * 100
      : (currentResponse - previousResponse) / contributionBase * 100
    if (Number.isFinite(xReturn) && Number.isFinite(yReturn)) { x.push(xReturn); y.push(yReturn) }
  }
  if (x.length < 2) return { observations: x.length, alpha: null, beta: null, rSquared: null, firstPeriod: matchedPeriods[0], lastPeriod: matchedPeriods.at(-1) }
  const xMean = x.reduce((sum, value) => sum + value, 0) / x.length
  const yMean = y.reduce((sum, value) => sum + value, 0) / y.length
  const covariance = x.reduce((sum, value, index) => sum + (value - xMean) * (y[index] - yMean), 0)
  const xVariance = x.reduce((sum, value) => sum + (value - xMean) ** 2, 0)
  const yVariance = y.reduce((sum, value) => sum + (value - yMean) ** 2, 0)
  if (xVariance === 0 || yVariance === 0) return { observations: x.length, alpha: null, beta: null, rSquared: null, correlation: null, firstPeriod: matchedPeriods[0], lastPeriod: matchedPeriods.at(-1) }
  const beta = covariance / xVariance
  const alpha = yMean - beta * xMean
  const rSquared = (covariance * covariance) / (xVariance * yVariance)
  const correlation = covariance / Math.sqrt(xVariance * yVariance)
  return { observations: x.length, alpha, beta, rSquared, correlation, firstPeriod: matchedPeriods[0], lastPeriod: matchedPeriods.at(-1) }
}

function equityResponsePoints(scenario) {
  return (scenario.equityTimestamps || []).flatMap((timestamp, index) => Number.isFinite(scenario.equityCurve?.[index]) ? [{ timestamp, value: scenario.equityCurve[index] }] : [])
}

function BucketBenchmarkRegression({ scenarios, benchmarkFiles, frequency }) {
  const defaultPath = benchmarkFiles.find((file) => file.path.includes('/benchmarks/') && file.path.includes('_1d_'))?.path
    || benchmarkFiles.find((file) => file.path.includes('/benchmarks/'))?.path
    || benchmarkFiles[0]?.path
  const [selectedPath, setSelectedPath] = useState(defaultPath || '')
  const [userPickedDataset, setUserPickedDataset] = useState(false)
  const [tsUnit, setTsUnit] = useState('MILLISECONDS')
  const [dateFormat, setDateFormat] = useState('DDMMYYYY')
  const [reference, setReference] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const validSelectedPath = benchmarkFiles.some((file) => file.path === selectedPath) ? selectedPath : (defaultPath || '')
  const expectedSAndPInterval = frequency === 'hourly' ? '1h' : '1d'
  const matchingSAndPFile = benchmarkFiles.find((file) => file.path.startsWith('reference/benchmarks/SP500_') && file.path.includes(`_${expectedSAndPInterval}_`))
  const effectivePath = !userPickedDataset && validSelectedPath.startsWith('reference/benchmarks/SP500_') && matchingSAndPFile
    ? matchingSAndPFile.path
    : validSelectedPath
  const activeReference = effectivePath ? reference : null
  useEffect(() => {
    if (!effectivePath) return undefined
    const controller = new AbortController()
    const loadReference = async () => {
      setLoading(true)
      setError('')
      try {
        const query = new URLSearchParams({ path: effectivePath, tsUnit, dateFormat })
        const response = await fetch(`/api/backtests/reference-series?${query}`, { signal: controller.signal })
        const result = await readApiJson(response, 'regression reference data')
        if (!response.ok) throw new Error(result.error || 'Could not read the selected reference dataset.')
        setReference(result)
      } catch (loadError) {
        if (loadError.name !== 'AbortError') { setReference(null); setError(loadError.message) }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    loadReference()
    return () => controller.abort()
  }, [effectivePath, tsUnit, dateFormat])

  const tooCoarseForHourly = frequency === 'hourly' && activeReference?.medianGapMs > 2 * 3_600_000
  const interval = frequency === 'hourly' ? 3_600_000 : 86_400_000
  const regressions = useMemo(() => {
    if (!activeReference || tooCoarseForHourly) return []
    return scenarios.map((scenario) => {
      const shared = scenario.bucketCapitalMode !== 'INDEPENDENT'
      const rows = [{ label: 'Total portfolio', response: equityResponsePoints(scenario), contributionBase: null }]
      const hasSingleBucket = (scenario.buckets || []).length === 1
      if (hasSingleBucket) {
        for (const strategy of scenario.buckets[0].strategies || []) {
          const timestamps = strategy.contributionTimestamps || []
          const curve = strategy.contributionCurve || []
          const response = timestamps.flatMap((timestamp, index) => Number.isFinite(curve[index]) ? [{ timestamp, value: curve[index] }] : [])
          rows.push({ label: `${strategy.strategyTag || `${strategy.name || 'Strategy'}#${strategy.instanceId}`} contribution`, response, contributionBase: scenario.metrics?.initialEquity })
        }
      } else {
        for (const bucket of scenario.buckets || []) {
          const timestamps = shared ? (bucket.contributionTimestamps || []) : (bucket.equityTimestamps || [])
          const curve = shared ? (bucket.contributionCurve || []) : (bucket.equityCurve || [])
          const response = timestamps.flatMap((timestamp, index) => Number.isFinite(curve[index]) ? [{ timestamp, value: curve[index] }] : [])
          rows.push({ label: shared ? `${bucket.id} contribution` : bucket.id, response, contributionBase: shared ? scenario.metrics?.initialEquity : null })
        }
      }
      const calculatedRows = rows.map((row) => ({ ...row, ...regressionForReference(activeReference.points, row.response, frequency, row.contributionBase) }))
      const strategies = hasSingleBucket ? (scenario.buckets[0].strategies || []) : []
      const correlationRows = hasSingleBucket
        ? [calculatedRows[0], ...strategies.map((strategy) => {
          const timestamps = strategy.contributionTimestamps || []
          const curve = strategy.contributionCurve || []
          const response = timestamps.flatMap((timestamp, index) => Number.isFinite(curve[index]) ? [{ timestamp, value: curve[index] }] : [])
          const label = strategy.strategyTag || `${strategy.name || 'Strategy'}#${strategy.instanceId}`
          return { label, response, ...regressionForReference(activeReference.points, response, frequency, scenario.metrics?.initialEquity) }
        })]
        : calculatedRows
      return {
        scenario,
        rows: calculatedRows,
        correlationRows,
      }
    })
  }, [activeReference, scenarios, frequency, tooCoarseForHourly])

  return <>
    {activeReference && !loading && !error && !tooCoarseForHourly && <section className="bucket-correlation-section benchmark-correlation-section">
      <h3>Benchmark return correlation · {frequency}</h3>
      {regressions.map(({ scenario, correlationRows }) => <div className="benchmark-regression-scenario" key={scenario.scenarioId}>
        <h4>{scenario.scenarioLabel}</h4>
        <div className="bucket-correlation-table-wrap"><table className="bucket-correlation-table">
          <thead><tr><th>Benchmark</th>{correlationRows.map((row) => <th key={row.label}>{row.label}</th>)}</tr></thead>
          <tbody><tr><th>{benchmarkFiles.find((file) => file.path === effectivePath)?.label || effectivePath}</th>{correlationRows.map((row) => <td key={row.label} style={correlationCellStyle(row.correlation)}>{Number.isFinite(row.correlation) ? row.correlation.toFixed(2) : '—'}</td>)}</tr></tbody>
        </table></div>
      </div>)}
    </section>}
    <section className="benchmark-regression-section">
    <div className="bucket-correlation-heading"><div><h3>Regression against reference dataset</h3><p>Reference returns are the regressor (x); portfolio, strategy, or bucket returns are response series (y). Benchmark prices are sampled to {frequency} UTC closes before returns are calculated.</p></div></div>
    <div className="benchmark-regression-controls">
      <label>Reference dataset<select onChange={(event) => { setUserPickedDataset(true); setSelectedPath(event.target.value) }} value={effectivePath}>{benchmarkFiles.map((file) => <option key={file.path} value={file.path}>{file.label}</option>)}</select></label>
      <label>Numeric timestamp<select onChange={(event) => setTsUnit(event.target.value)} value={tsUnit}><option>SECONDS</option><option>MILLISECONDS</option><option>MICROSECONDS</option><option>NANOSECONDS</option></select></label>
      <label>Date order<select onChange={(event) => setDateFormat(event.target.value)} value={dateFormat}><option>DDMMYYYY</option><option>MMDDYYYY</option></select></label>
    </div>
    {!benchmarkFiles.length && <p className="input-help">Add a CSV or Parquet price series under data/ to use it as a regression reference.</p>}
    {effectivePath && loading && <p className="input-help">Loading reference prices…</p>}
    {effectivePath && error && <p className="form-error">{error}</p>}
    {tooCoarseForHourly && <p className="form-error">This reference dataset is too coarse for hourly regression. Choose an hourly or finer price series.</p>}
    {activeReference && !loading && !error && !tooCoarseForHourly && <>
      <p className="input-help">Using {activeReference.priceColumn} · {activeReference.currency} · {activeReference.points.length.toLocaleString()} prices. Regressions use only matching interval closes. Strategy and shared-bucket contribution rows use P&amp;L changes divided by starting portfolio capital; total portfolio uses equity returns, so their coefficients can differ. A currency mismatch with the portfolio is not FX-adjusted.</p>
      {regressions.map(({ scenario, rows }) => <section className="benchmark-regression-scenario" key={scenario.scenarioId}><h4>{scenario.scenarioLabel}</h4><div className="orders-table-wrap"><table className="orders-table bucket-regression-table"><thead><tr><th>Response series</th><th>Alpha / {frequency} interval</th><th>Beta</th><th>R²</th><th>Observations</th><th>Matched range</th></tr></thead><tbody>{rows.map((row) => {
        const start = Number.isFinite(row.firstPeriod) ? new Date(row.firstPeriod * interval).toLocaleDateString() : '—'
        const end = Number.isFinite(row.lastPeriod) ? new Date(row.lastPeriod * interval).toLocaleDateString() : '—'
        return <tr key={row.label}><td>{row.label}</td><td>{reportNumber(row.alpha, '%', 4)}</td><td>{reportNumber(row.beta, '', 4)}</td><td>{reportNumber(row.rSquared, '', 4)}</td><td>{row.observations.toLocaleString()}</td><td>{start} – {end}</td></tr>
      })}</tbody></table></div></section>)}
    </>}
    </section>
  </>
}

function BucketAssetCorrelationTables({ scenarios, frequency }) {
  const requests = useMemo(() => {
    const unique = new Map()
    for (const scenario of scenarios) {
      for (const bucket of scenario.buckets || []) {
        for (const feed of bucket.feeds || []) {
          const key = `${feed.path}|${feed.tsUnit || 'MILLISECONDS'}|${feed.dateFormat || 'DDMMYYYY'}`
          if (!unique.has(key)) unique.set(key, { key, ...feed })
        }
      }
    }
    return [...unique.values()]
  }, [scenarios])
  const [references, setReferences] = useState({})
  const [errors, setErrors] = useState({})
  const loading = requests.some((feed) => !references[feed.key] && !errors[feed.key])

  useEffect(() => {
    if (!requests.length) return undefined
    const controller = new AbortController()
    const loadAssetReferences = async () => {
      const results = await Promise.all(requests.map(async (feed) => {
        try {
          const query = new URLSearchParams({ path: feed.path, tsUnit: feed.tsUnit || 'MILLISECONDS', dateFormat: feed.dateFormat || 'DDMMYYYY' })
          const response = await fetch(`/api/backtests/reference-series?${query}`, { signal: controller.signal })
          const result = await readApiJson(response, 'asset correlation data')
          if (!response.ok) throw new Error(result.error || 'Could not read this asset dataset.')
          return { key: feed.key, result }
        } catch (error) {
          if (error.name === 'AbortError') return null
          return { key: feed.key, error: error.message }
        }
      }))
      if (controller.signal.aborted) return
      setReferences((current) => ({ ...current, ...Object.fromEntries(results.filter((item) => item?.result).map(({ key, result }) => [key, result])) }))
      setErrors((current) => ({ ...current, ...Object.fromEntries(results.filter((item) => item?.error).map(({ key, error }) => [key, error])) }))
    }
    loadAssetReferences()
    return () => controller.abort()
  }, [requests])

  if (!requests.length) return null
  return <section className="benchmark-regression-section bucket-asset-correlation-section">
    <div className="bucket-correlation-heading"><div><h3>Asset return correlation · {frequency}</h3><p>Each dataset is correlated with the portfolio and the strategies connected to it. Price returns use matched UTC interval closes.</p></div></div>
    {loading && <p className="input-help">Loading the bucket asset datasets…</p>}
    {scenarios.map((scenario) => <section className="benchmark-regression-scenario" key={scenario.scenarioId}>
      <h4>{scenario.scenarioLabel}</h4>
      {(scenario.buckets || []).map((bucket) => <section className="bucket-correlation-section" key={bucket.id}>
        <h4>{bucket.id}</h4>
        {(bucket.feeds || []).map((feed) => {
          const key = `${feed.path}|${feed.tsUnit || 'MILLISECONDS'}|${feed.dateFormat || 'DDMMYYYY'}`
          const reference = references[key]
          const connectedStrategies = (bucket.strategies || []).filter((strategy) => !Array.isArray(strategy.feedIds) || strategy.feedIds.includes(feed.id))
          const responses = [{ label: 'Total portfolio', points: equityResponsePoints(scenario), contributionBase: null }, ...connectedStrategies.map((strategy) => ({
            label: strategy.strategyTag || `${strategy.name || 'Strategy'}#${strategy.instanceId}`,
            points: (strategy.contributionTimestamps || []).flatMap((timestamp, index) => Number.isFinite(strategy.contributionCurve?.[index]) ? [{ timestamp, value: strategy.contributionCurve[index] }] : []),
            contributionBase: scenario.metrics?.initialEquity,
          }))]
          const correlations = reference ? responses.map((response) => ({
            label: response.label,
            value: regressionForReference(reference.points, response.points, frequency, response.contributionBase).correlation,
          })) : []
          return <div className="benchmark-regression-scenario" key={key}>
            <h4>{feed.name || feed.path}</h4>
            {errors[key] && <p className="form-error">{errors[key]}</p>}
            {reference && <div className="bucket-correlation-table-wrap"><table className="bucket-correlation-table">
              <thead><tr><th>Asset</th>{correlations.map((item) => <th key={item.label}>{item.label}</th>)}</tr></thead>
              <tbody><tr><th>{feed.path}</th>{correlations.map((item) => <td key={item.label} style={correlationCellStyle(item.value)}>{Number.isFinite(item.value) ? item.value.toFixed(2) : '—'}</td>)}</tr></tbody>
            </table></div>}
            {!loading && !reference && !errors[key] && <p className="input-help">No asset price history available for this feed.</p>}
          </div>
        })}
      </section>)}
    </section>)}
    <small className="input-help">Asset returns use the dataset’s native prices; this correlation view does not convert asset or portfolio currency.</small>
  </section>
}

function BucketPerformanceView({ scenarios, currency }) {
  return <div className="bucket-performance-scenarios">{scenarios.map((scenario) => <section className="bucket-performance-scenario" key={scenario.scenarioId}><div className="config-section-heading"><h3>{scenario.scenarioLabel} · bucket performance</h3><span>Each bucket uses its own equal share of total starting capital</span></div><div className="bucket-performance-grid">{(scenario.buckets || []).map((bucket) => <article className="bucket-performance-card" key={bucket.id}><div className="bucket-performance-card-heading"><h4>{bucket.id}</h4><span>{bucket.feeds?.length || 0} feeds · {bucket.strategies?.length || 0} strategies</span></div><div className="report-metric-grid"><div><span>Profit</span><strong>{reportNumber(bucket.metrics?.profitPct, '%')}</strong></div><div><span>Maximum drawdown</span><strong>{reportMoney(bucket.metrics?.maxDrawdownDollars, currency)} · {reportNumber(bucket.metrics?.maxDrawdownPct, '%')}</strong></div><div><span>Sharpe</span><strong>{reportNumber(bucket.metrics?.sharpe, '', 4)}</strong></div><div><span>Trades / year</span><strong>{reportNumber(bucket.metrics?.tradesPerYear)}</strong></div></div><EquityCurveChart currency={currency} scenarios={[{ scenarioId: bucket.id, scenarioLabel: bucket.id, metrics: bucket.metrics, equityCurve: bucket.equityCurve || [], equityTimestamps: bucket.equityTimestamps || [] }]} /></article>)}</div></section>)}</div>
}

function BacktestReport({ scenarios, compare, benchmarkFiles }) {
  const [activeTab, setActiveTab] = useState('general')
  const [performanceView, setPerformanceView] = useState('portfolio')
  const [correlationFrequency, setCorrelationFrequency] = useState('daily')
  const [detailScenarioId, setDetailScenarioId] = useState(scenarios[0]?.scenarioId || 'both')
  const [visualizeSeries, setVisualizeSeries] = useState(false)
  const [activeMetricHelp, setActiveMetricHelp] = useState(null)
  const metricHelpRef = useRef(null)
  useEffect(() => {
    if (!activeMetricHelp) return undefined
    const closeOnOutsideClick = (event) => { if (!metricHelpRef.current?.contains(event.target)) setActiveMetricHelp(null) }
    const closeOnEscape = (event) => { if (event.key === 'Escape') setActiveMetricHelp(null) }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('pointerdown', closeOnOutsideClick); document.removeEventListener('keydown', closeOnEscape) }
  }, [activeMetricHelp])
  const detailScenario = scenarios.find((scenario) => scenario.scenarioId === detailScenarioId) || scenarios[0]
  const currency = detailScenario.metrics.currency || 'USD'
  const hasIndependentBuckets = detailScenario.bucketCapitalMode === 'INDEPENDENT'
  const performanceViews = hasIndependentBuckets
    ? [['portfolio', 'Portfolio'], ['buckets', 'Buckets'], ['correlation', 'Correlation']]
    : [['portfolio', 'Portfolio'], ['correlation', 'Correlation']]
  const activePerformanceView = performanceViews.some(([id]) => id === performanceView) ? performanceView : 'portfolio'
  const indicatorColors = ['#a887ff', '#57b8ed', '#f1b654', '#ef7fab', '#52d1c3', '#a5c96b', '#ff8066', '#6f91ff', '#d47ce5', '#36b978', '#e6c84f', '#43c3c9']
  const tradeSeriesOptions = (detailScenario.buckets || []).flatMap((bucket) => (bucket.feeds || []).map((feed) => {
    const trades = (detailScenario.trades || []).filter((trade) => trade.bucketId === bucket.id && trade.feedId === feed.id)
    const indicators = (bucket.strategies || []).flatMap((strategy) => (strategy.indicators || []).filter((indicator) => indicator.feedId === feed.id).map((indicator) => ({ strategy, indicator }))).map(({ strategy, indicator }, index) => ({
      key: `${bucket.id}:${strategy.instanceId}:${indicator.name}:${index}`,
      preferenceKey: `${strategy.strategyId || strategy.name}:${indicator.name}:${index}`,
      label: `${indicator.strategyTag || strategy.strategyTag || `${strategy.name}#${strategy.instanceId}`} · ${indicator.name}`,
      color: indicatorColors[index % indicatorColors.length],
      points: indicator.points || [],
    }))
    return { key: `${bucket.id}:${feed.id}`, label: `${feed.name} · ${bucket.id}`, feed, trades, indicators }
  })).filter((series) => series.trades.length > 0 || series.indicators.length > 0)
  const tabs = [
    ['general', 'General Report'], ['performance', 'Performance'], ['trades', 'Trades'], ['orders', 'Order Log'],
  ]
  const metricLabel = (scenario, label, explanation) => {
    const key = `${scenario.scenarioId}:${label}`
    const isOpen = activeMetricHelp === key
    return <div className="report-metric-label" ref={isOpen ? metricHelpRef : null}><span>{label}</span><button aria-expanded={isOpen} aria-label={`Explain ${label}`} className="metric-help-button" onClick={() => setActiveMetricHelp((current) => current === key ? null : key)} type="button">?</button>{isOpen && <div className="metric-help-popover" role="dialog"><button aria-label="Close explanation" className="metric-help-close" onClick={() => setActiveMetricHelp(null)} type="button">×</button><p>{explanation}</p></div>}</div>
  }
  const scenarioMetricCards = (kind) => scenarios.map((scenario) => (
    <article className="report-scenario-card" key={scenario.scenarioId}>
      <h3>{scenario.scenarioLabel}</h3>
      <div className="report-metric-grid">
        {kind === 'general' ? <>
          <div><span>Equity</span><strong>{reportMoney(scenario.metrics.finalEquity, currency)}</strong></div>
          <div><span>Maximum drawdown</span><strong>{reportMoney(scenario.metrics.maxDrawdownDollars, currency)} · {reportNumber(scenario.metrics.maxDrawdownPct, '%')}</strong></div>
          <div><span>Sharpe</span><strong>{reportNumber(scenario.metrics.sharpe, '', 4)}</strong></div>
          <div><span>Average profit / trade</span><strong>{reportMoney(scenario.metrics.averageProfitPerTrade, currency)}</strong></div>
          <div><span>Trades / year</span><strong>{reportNumber(scenario.metrics.tradesPerYear)}</strong></div>
        </> : <>
          <div>{metricLabel(scenario, 'Profit notional', 'Net portfolio profit or loss in the selected base currency, after configured trading costs.') }<strong>{reportMoney(scenario.metrics.profitNotional, currency)}</strong></div>
          <div>{metricLabel(scenario, 'Profit', 'Net portfolio profit or loss as a percentage of the starting capital.') }<strong>{reportNumber(scenario.metrics.profitPct, '%')}</strong></div>
          <div>{metricLabel(scenario, 'Maximum drawdown', 'Largest peak-to-trough decline in portfolio equity. The value shows both the currency amount and the percentage of the prior peak.') }<strong>{reportMoney(scenario.metrics.maxDrawdownDollars, currency)} · {reportNumber(scenario.metrics.maxDrawdownPct, '%')}</strong></div>
          <div>{metricLabel(scenario, 'CAGR', 'Compound annual growth rate: the annualized rate that would grow starting equity to ending equity over the backtest period.') }<strong>{reportNumber(scenario.metrics.cagrPct, '%', 4)}</strong></div>
          <div>{metricLabel(scenario, 'Win ratio', 'Closed trades with positive net profit divided by all closed trades.') }<strong>{reportNumber(scenario.metrics.winRatio, '%')}</strong></div>
          <div>{metricLabel(scenario, 'Win/loss ratio', 'Average profit of winning trades divided by the absolute average loss of losing trades. Values above 1 mean the average winner is larger than the average loser.') }<strong>{scenario.metrics.winLossRatioInfinite ? '∞' : reportNumber(scenario.metrics.winLossRatio)}</strong></div>
          <div>{metricLabel(scenario, 'Sortino', 'Annualized return divided by downside deviation, which measures variation from negative returns while ignoring upside variation.') }<strong>{scenario.metrics.sortinoInfinite ? '∞' : reportNumber(scenario.metrics.sortino, '', 4)}</strong></div>
          <div>{metricLabel(scenario, 'Calmar', 'CAGR divided by the absolute maximum drawdown percentage. Higher values indicate more annualized return per unit of worst drawdown.') }<strong>{reportNumber(scenario.metrics.calmar, '', 4)}</strong></div>
          <div>{metricLabel(scenario, 'Profit factor', 'Gross profit from winning trades divided by gross losses from losing trades. Above 1 means gross wins exceed gross losses.') }<strong>{scenario.metrics.profitFactorInfinite ? '∞' : reportNumber(scenario.metrics.profitFactor)}</strong></div>
          <div>{metricLabel(scenario, 'Closed trades', 'Number of completed entry-and-exit trade pairs. Open positions are not included.') }<strong>{scenario.metrics.tradeCount.toLocaleString()}</strong></div>
          <div>{metricLabel(scenario, 'Trades / year', 'Closed trade count divided by the backtest duration in years.') }<strong>{reportNumber(scenario.metrics.tradesPerYear)}</strong></div>
          <div>{metricLabel(scenario, 'Orders', 'Total orders generated during this backtest, including entries, exits, and orders that did not become completed trades.') }<strong>{scenario.metrics.orders.toLocaleString()}</strong></div>
        </>}
      </div>
    </article>
  ))

  return (
    <section className="backtest-report">
      <div className="config-section-heading"><h2>Portfolio report</h2><span>{compare ? 'Three independent runs · same total starting capital' : `${detailScenario.scenarioLabel} · all buckets combined`}</span></div>
      <nav aria-label="Backtest report sections" className="report-tabs">
        {tabs.map(([id, label]) => <button aria-current={activeTab === id ? 'page' : undefined} className={activeTab === id ? 'is-active' : ''} key={id} onClick={() => setActiveTab(id)} type="button">{label}</button>)}
      </nav>
      {compare && (activeTab === 'trades' || activeTab === 'orders') && <div className="backtest-scenario-tabs" aria-label="Choose scenario details">
        <span>Scenario:</span>
        {scenarios.map((scenario) => <button aria-pressed={detailScenario.scenarioId === scenario.scenarioId} className={detailScenario.scenarioId === scenario.scenarioId ? 'is-active' : ''} key={scenario.scenarioId} onClick={() => setDetailScenarioId(scenario.scenarioId)} type="button">{scenario.scenarioLabel}</button>)}
      </div>}
      {activeTab === 'general' && <>
        <EquityCurveChart currency={currency} scenarios={scenarios} />
        <div className={`report-scenario-grid ${scenarios.length === 1 ? 'is-single' : ''}`}>{scenarioMetricCards('general')}</div>
      </>}
      {activeTab === 'performance' && <>
        <nav aria-label="Performance views" className="performance-subtabs">
          {performanceViews.map(([id, label]) => <button aria-pressed={activePerformanceView === id} className={activePerformanceView === id ? 'is-active' : ''} key={id} onClick={() => setPerformanceView(id)} type="button">{label}</button>)}
        </nav>
        {activePerformanceView === 'portfolio' && <div className={`report-scenario-grid ${scenarios.length === 1 ? 'is-single' : ''}`}>{scenarioMetricCards('performance')}</div>}
        {hasIndependentBuckets && activePerformanceView === 'buckets' && <BucketPerformanceView currency={currency} scenarios={scenarios} />}
        {activePerformanceView === 'correlation' && <div className="bucket-correlation-scenarios">{scenarios.map((scenario) => <BucketCorrelationMatrix frequency={correlationFrequency} key={scenario.scenarioId} onFrequencyChange={setCorrelationFrequency} scenario={scenario} />)}<BucketAssetCorrelationTables frequency={correlationFrequency} scenarios={scenarios} /><BucketBenchmarkRegression frequency={correlationFrequency} scenarios={scenarios} benchmarkFiles={benchmarkFiles} /></div>}
      </>}
      {activeTab === 'trades' && visualizeSeries ? <TradeVisualizer key={`${detailScenario.scenarioId}:${visualizeSeries.bucketId || 'all'}:${visualizeSeries.instanceId || 'all'}`} focusedTrade={visualizeSeries === true ? null : visualizeSeries} onClose={() => setVisualizeSeries(false)} seriesOptions={tradeSeriesOptions} /> : activeTab === 'trades' && <>
        {tradeSeriesOptions.length > 0 && <div className="trade-series-actions"><span>{detailScenario.trades.length.toLocaleString()} completed trades across {tradeSeriesOptions.length.toLocaleString()} data series</span><button className="trade-visualize-button" onClick={() => setVisualizeSeries(true)} type="button">Visualize series</button></div>}
        <div className="orders-table-wrap report-table-wrap">
        <table className="orders-table"><thead><tr><th>Bucket</th><th>Instrument</th><th>Strategy</th><th>Side</th><th>Entry time</th><th>Exit time</th><th>Quantity</th><th>Entry</th><th>Exit</th><th>Net profit</th><th>R multiple</th><th></th></tr></thead>
          <tbody>{detailScenario.trades?.length ? detailScenario.trades.map((trade, index) => <tr key={`${trade.bucketId}-${trade.instanceId}-${trade.entryTimestamp}-${index}`}><td>{trade.bucketId}</td><td>{trade.instrument || '—'}</td><td>{trade.strategyName} · {trade.instanceId}</td><td>{trade.side}</td><td>{reportTimestamp(trade.entryTimestamp)}</td><td>{reportTimestamp(trade.exitTimestamp)}</td><td>{reportNumber(trade.quantity)}</td><td>{reportNumber(trade.entryPrice)}</td><td>{reportNumber(trade.exitPrice)}</td><td>{reportMoney(trade.profit, currency)}</td><td>{trade.riskReward == null ? '—' : `${reportNumber(trade.riskReward)} R`}</td><td><button className="trade-visualize-button" onClick={() => setVisualizeSeries(trade)} type="button">Visualize</button></td></tr>) : <tr><td colSpan="12">No completed trades in this scenario.</td></tr>}</tbody>
        </table>
        </div>
      </>}
      {activeTab === 'orders' && <div className="orders-table-wrap report-table-wrap">
        <table className="orders-table"><thead><tr><th>Bucket</th><th>Strategy instance</th><th>Feed</th><th>Time (epoch ms)</th><th>Side</th><th>Quantity</th><th>Price</th><th>Status</th><th>Reason</th></tr></thead>
          <tbody>{detailScenario.orders.length ? detailScenario.orders.map((order) => <tr key={`${order.bucketId}-${order.instanceId}-${order.id}-${order.timestamp}`}><td>{order.bucketId}</td><td>{order.strategyName} · {order.instanceId}</td><td>{order.feedId || '—'}</td><td>{order.timestamp}</td><td>{order.signal}</td><td>{reportNumber(order.quantity)}</td><td>{reportNumber(order.price)}</td><td>{order.status}</td><td>{order.reason}</td></tr>) : <tr><td colSpan="9">No orders were generated for this scenario.</td></tr>}</tbody>
        </table>
      </div>}
    </section>
  )
}

function BacktestBucketPanel({
  bucket, strategies, dataFiles, strategyCatalog, expandedStrategies, selectedForSidebar,
  strategyPresets, presetMenuInstanceId, onTogglePresetMenu, onSelectPreset,
  fxFiles, fxDropHover, baseCurrency, ignoreCurrency, onFxDragEnter, onFxDragLeave, onFxDrop, onRemoveFxFile, onUpdateFxFeed, onUpdateFxPair,
  strategyDropHover, dataDropHover, manualDataPath, onSelectBucket, onAddStrategy,
  onStrategyDragEnter, onStrategyDragLeave, onStrategyDrop, onDataDragEnter,
  onDataDragLeave, onDataDrop, onToggleStrategy, onRemoveStrategy,
  onToggleFeed, onUpdateStrategy, onRemoveFeed, onUpdateFeed,
  onManualPathChange, onManualPathKeyDown, onAddManualPath,
}) {
  const [collapsedFeedSections, setCollapsedFeedSections] = useState({})
  const [collapsed, setCollapsed] = useState(false)
  const foreignCurrencies = [...new Set(dataFiles.map((feed) => feed.datasetSettings?.currency).filter((currency) => currency && currency !== baseCurrency))]
  const coveredCurrencies = (fxFile) => foreignCurrencies.filter((currency) => {
    const pair = [fxFile.datasetSettings?.fxBaseCurrency, fxFile.datasetSettings?.fxQuoteCurrency]
    return pair.includes(currency) && pair.includes(baseCurrency)
  })
  return (
    <section className="backtest-bucket">
      <div className="backtest-bucket-heading">
        <div className="backtest-bucket-heading-main">
          <button aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${bucket.name}`} className="bucket-collapse-toggle" onClick={() => setCollapsed((current) => !current)} type="button">
            <span aria-hidden="true" className="tree-chevron">{collapsed ? '›' : '⌄'}</span>
            <span><span className="eyebrow">BACKTEST BUCKET</span><span className="bucket-title">{bucket.name}</span></span>
          </button>
          {collapsed && <small className="bucket-collapsed-summary">{strategies.length} strategies · {dataFiles.length} feeds</small>}
        </div>
        <button className={`secondary-button bucket-sidebar-select ${selectedForSidebar ? 'is-selected' : ''}`} onClick={() => onSelectBucket(bucket.id)} type="button">
          {selectedForSidebar ? 'Selected for sidebar adds' : 'Use for sidebar adds'}
        </button>
      </div>

      {!collapsed && <>
      <section className="config-section assembly-section">
        <div className="config-section-heading"><h2>Strategies</h2><span>{strategies.length} added</span></div>
        <div
          className={`assembly-drop-target strategy-assembly-target ${strategyDropHover ? 'is-drag-hovering' : ''}`}
          onDragEnter={(event) => onStrategyDragEnter(bucket.id, event)}
          onDragLeave={(event) => onStrategyDragLeave(bucket.id, event)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => onStrategyDrop(bucket.id, event)}
        >
          <span>Drop strategies here from Builder</span>
          {strategyCatalog.map((strategy) => <button className="assembly-add-button" key={strategy.id} onClick={() => onAddStrategy(strategy, bucket.id)} type="button">+ {strategy.name}</button>)}
        </div>
        {strategies.length > 0 && <div className="assembly-list">
          {strategies.map((strategy) => {
            const expanded = Boolean(expandedStrategies[strategy.instanceId])
            const feedsExpanded = collapsedFeedSections[strategy.instanceId] === true
            return (
              <article className="strategy-config-card" key={strategy.instanceId}>
                <div className="strategy-config-row">
                  <button aria-expanded={expanded} aria-controls={`strategy-config-${strategy.instanceId}`} className="strategy-config-toggle" onClick={() => onToggleStrategy(strategy.instanceId)} type="button">
                    <span className="tree-chevron">{expanded ? '⌄' : '›'}</span><strong>{strategy.name}</strong><span className="strategy-config-id" title="Strategy instance ID">{strategy.instanceId}</span>
                  </button>
                  <button aria-label={`Choose preset for ${strategy.name}`} className="item-settings strategy-preset-button" onClick={() => onTogglePresetMenu(strategy.instanceId)} title="Choose strategy preset" type="button">⚙</button>
                  <button aria-label={`Remove ${strategy.name}`} className="remove-item-button" onClick={() => onRemoveStrategy(strategy.instanceId)} type="button">×</button>
                </div>
                {presetMenuInstanceId === strategy.instanceId && <div className="strategy-preset-menu"><label><span>Preset</span><select onChange={(event) => onSelectPreset(strategy.instanceId, event.target.value)} value={strategy.presetId || ''}><option value="" disabled>Select a preset</option>{(strategyPresets[strategy.id]?.presets || []).map((preset) => <option key={preset.id} value={preset.id}>{preset.name}{presetIsStale(preset, strategy) ? ' · stale' : ''}</option>)}</select></label>{(!strategyPresets[strategy.id]?.presets?.length) && <small>Create presets from this strategy file’s settings menu.</small>}</div>}
                {expanded && <div className="strategy-config-details" id={`strategy-config-${strategy.instanceId}`}>
                  <section>
                    <button aria-expanded={feedsExpanded} className="feed-section-toggle" onClick={() => setCollapsedFeedSections((current) => ({ ...current, [strategy.instanceId]: !feedsExpanded }))} type="button">
                      <span className="tree-chevron">{feedsExpanded ? '⌄' : '›'}</span><h3>Connected feeds</h3><span>{strategy.feedIds.length} selected</span>
                    </button>
                    {feedsExpanded && (dataFiles.length ? <div className="feed-subscription-list">
                      {dataFiles.map((feed) => <label className="feed-subscription-option" key={feed.instanceId}>
                        <input checked={strategy.feedIds.includes(feed.instanceId)} onChange={() => onToggleFeed(strategy.instanceId, feed.instanceId)} type="checkbox" />
                        <span>{feed.name}</span><small title={feed.path}>{feed.path}</small>
                      </label>)}
                    </div> : <p className="input-help">Add a data feed to this bucket to connect it to the strategy.</p>)}
                  </section>
                  <section>
                    <div className="config-section-heading"><h3>Base settings</h3></div>
                    <div className="config-grid config-toggle-grid">
                      {strategy.baseConfig.map((field) => <ConfigField key={field.key} field={field} value={strategy.baseConfigDraft[field.key]} onChange={(key, value) => onUpdateStrategy(strategy.instanceId, 'baseConfigDraft', key, value)} />)}
                    </div>
                  </section>
                  <section>
                    <div className="config-section-heading"><h3>{strategy.name} settings</h3></div>
                    <StrategyParameterFields fields={strategy.parameters} onChange={(key, value) => onUpdateStrategy(strategy.instanceId, 'strategyConfigDraft', key, value)} values={strategy.strategyConfigDraft} />
                  </section>
                </div>}
              </article>
            )
          })}
        </div>}
      </section>

      <section className="config-section assembly-section">
        <div className="config-section-heading"><h2>Data feeds</h2><span>{dataFiles.length} added · CSV or Parquet</span></div>
        <div
          className={`assembly-drop-target data-assembly-target ${dataDropHover ? 'is-drag-hovering' : ''}`}
          onDragEnter={(event) => onDataDragEnter(bucket.id, event)}
          onDragLeave={(event) => onDataDragLeave(bucket.id, event)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => onDataDrop(bucket.id, event)}
        >Drop data feeds here from the project explorer</div>
        {dataFiles.length > 0 && <div className="assembly-list data-file-list">
          {dataFiles.map((feed) => <div className="data-file-row bucket-feed-row" key={feed.instanceId}>
            <ScriptIcon /><span className="data-file-name" title={feed.path}>{feed.name}</span><span className="data-file-path">{feed.path}</span><span className="feed-market-meta" title={`Timezone: ${feed.datasetSettings?.timezone || 'UTC'}`}>{feed.datasetSettings?.currency || 'USD'}</span>
            <label className="feed-setting"><span>Numeric time</span><select onChange={(event) => onUpdateFeed(feed.instanceId, 'tsUnit', event.target.value)} value={feed.tsUnit}><option>SECONDS</option><option>MILLISECONDS</option><option>MICROSECONDS</option><option>NANOSECONDS</option></select></label>
            <label className="feed-setting"><span>Date order</span><select onChange={(event) => onUpdateFeed(feed.instanceId, 'dateFormat', event.target.value)} value={feed.dateFormat}><option>DDMMYYYY</option><option>MMDDYYYY</option></select></label>
            <button aria-label={`Remove ${feed.name}`} className="remove-item-button" onClick={() => onRemoveFeed(feed.instanceId)} type="button">×</button>
          </div>)}
        </div>}
        <div className="manual-data-entry">
          <input aria-label={`Market-data path for ${bucket.name}`} onChange={(event) => onManualPathChange(event.target.value)} onKeyDown={(event) => onManualPathKeyDown(bucket.id, event)} placeholder="Or enter a CSV / Parquet path" spellCheck="false" type="text" value={manualDataPath} />
          <button className="secondary-button" disabled={!manualDataPath.trim()} onClick={() => onAddManualPath(bucket.id)} type="button">Add feed</button>
        </div>
      </section>

      {!ignoreCurrency && foreignCurrencies.length > 0 && <section className="config-section assembly-section">
        <div className="config-section-heading"><h2>FX conversion history</h2><span>Portfolio currency · {baseCurrency}</span></div>
        <p className="input-help">Add user-provided FX files here when this bucket has assets in another currency, then choose each file’s base and quote currencies below.</p>
        <p className="fx-required-currencies">Required pairs: {foreignCurrencies.map((currency) => `${currency}/${baseCurrency}`).join(', ')}{foreignCurrencies.every((currency) => fxFiles.some((file) => coveredCurrencies(file).includes(currency))) ? ' · covered' : ' · missing history'}</p>
        <div className={`assembly-drop-target fx-assembly-target ${fxDropHover ? 'is-drag-hovering' : ''}`} onDragEnter={(event) => onFxDragEnter(bucket.id, event)} onDragLeave={(event) => onFxDragLeave(bucket.id, event)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onFxDrop(bucket.id, event)}>Drop FX history files here from the project explorer</div>
        {fxFiles.length > 0 && <div className="assembly-list data-file-list">{fxFiles.map((feed) => <div className="data-file-row bucket-feed-row fx-feed-row" key={feed.instanceId}>
          <ScriptIcon /><span className="data-file-name">{feed.name}</span><span className="data-file-path" title={feed.path}>{feed.path}</span>
          <label className="feed-setting fx-pair-setting"><span>Pair base</span><SearchableSelect ariaLabel={`${feed.name} FX pair base`} onChange={(value) => onUpdateFxPair(feed.instanceId, 'fxBaseCurrency', value)} options={CURRENCY_OPTIONS} placeholder="Search currencies…" value={feed.datasetSettings.fxBaseCurrency || ''} /></label>
          <label className="feed-setting fx-pair-setting"><span>Pair quote</span><SearchableSelect ariaLabel={`${feed.name} FX pair quote`} onChange={(value) => onUpdateFxPair(feed.instanceId, 'fxQuoteCurrency', value)} options={CURRENCY_OPTIONS} placeholder="Search currencies…" value={feed.datasetSettings.fxQuoteCurrency || ''} /></label>
          <label className="feed-setting"><span>Numeric time</span><select onChange={(event) => onUpdateFxFeed(feed.instanceId, 'tsUnit', event.target.value)} value={feed.tsUnit}><option>SECONDS</option><option>MILLISECONDS</option><option>MICROSECONDS</option><option>NANOSECONDS</option></select></label>
          <label className="feed-setting"><span>Date order</span><select onChange={(event) => onUpdateFxFeed(feed.instanceId, 'dateFormat', event.target.value)} value={feed.dateFormat}><option>DDMMYYYY</option><option>MMDDYYYY</option></select></label>
          <button aria-label={`Remove FX history ${feed.name}`} className="remove-item-button" onClick={() => onRemoveFxFile(feed.instanceId)} type="button">×</button>
        </div>)}</div>}
      </section>}
      </>}
    </section>
  )
}

function App() {
  const [activePage, setActivePage] = useState('home')
  const [siteTheme, setSiteTheme] = useState(loadSiteTheme)
  const [settingsSection, setSettingsSection] = useState('general')
  const [sidebarExpanded, setSidebarExpanded] = useState(() => loadExplorerSettings().sidebarExpanded)
  const [sidebarWidth, setSidebarWidth] = useState(() => loadExplorerSettings().sidebarWidth)
  const [builderExpanded, setBuilderExpanded] = useState(() => loadExplorerSettings().builderExpanded)
  const [builderTree, setBuilderTree] = useState([])
  const [dataTree, setDataTree] = useState([])
  const benchmarkFiles = useMemo(() => listReferenceDatasets(dataTree), [dataTree])
  const [expandedNodes, setExpandedNodes] = useState(() => loadExplorerSettings().expandedNodes)
  const [builderPath, setBuilderPath] = useState(DEFAULT_BUILDER_PATH)
  const [pathDraft, setPathDraft] = useState(DEFAULT_BUILDER_PATH)
  const [builderDialogOpen, setBuilderDialogOpen] = useState(false)
  const [builderDialogView, setBuilderDialogView] = useState('menu')
  const [itemDialog, setItemDialog] = useState(null)
  const [datasetSettingsDialog, setDatasetSettingsDialog] = useState(null)
  const [datasetSettingsDraft, setDatasetSettingsDraft] = useState(null)
  const [datasetSettingsError, setDatasetSettingsError] = useState('')
  const [savingDatasetSettings, setSavingDatasetSettings] = useState(false)
  const [datasetMetadata, setDatasetMetadata] = useState({})
  const [deleteItemPrompt, setDeleteItemPrompt] = useState(null)
  const [deleteItemError, setDeleteItemError] = useState('')
  const [isDeletingItem, setIsDeletingItem] = useState(false)
  const [itemDialogAction, setItemDialogAction] = useState('menu')
  const [itemNameDraft, setItemNameDraft] = useState('')
  const [itemDialogError, setItemDialogError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [fileEditor, setFileEditor] = useState(null)
  const csvPreviewRows = useMemo(() => fileEditor?.csvTableView ? parseCsvPreview(fileEditor.content) : [], [fileEditor])
  const [workspacePreview, setWorkspacePreview] = useState(null)
  const workspacePreviewRequest = useRef(0)
  const workspacePreviewCsv = useMemo(() => workspacePreview?.scope === 'data' && workspacePreview.name.toLowerCase().endsWith('.csv') && !workspacePreview.loading && !workspacePreview.error ? parseCsvPreview(workspacePreview.content) : null, [workspacePreview])
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorError, setEditorError] = useState('')
  const [unsavedPromptOpen, setUnsavedPromptOpen] = useState(false)
  const [unsavedPromptError, setUnsavedPromptError] = useState('')
  const [pendingEditorAction, setPendingEditorAction] = useState(null)
  const [strategyCatalog, setStrategyCatalog] = useState([])
  const [strategyPresets, setStrategyPresets] = useState({})
  const [presetManagerStrategy, setPresetManagerStrategy] = useState(null)
  const [presetManagerData, setPresetManagerData] = useState(null)
  const [presetMenuInstanceId, setPresetMenuInstanceId] = useState(null)
  const [backtestBuckets, setBacktestBuckets] = useState([{ id: 'bucket-1', name: 'Bucket 1' }])
  const [activeBucketId, setActiveBucketId] = useState('bucket-1')
  const [backtestStrategies, setBacktestStrategies] = useState([])
  const [expandedBacktestStrategies, setExpandedBacktestStrategies] = useState({})
  const [dataFiles, setDataFiles] = useState([])
  const [fxFiles, setFxFiles] = useState([])
  const [manualDataPath, setManualDataPath] = useState('')
  const [compilation, setCompilation] = useState({ compiled: false, current: false, strategies: [] })
  const [compileSelection, setCompileSelection] = useState({})
  const [selectingStrategies, setSelectingStrategies] = useState(false)
  const [compileMessage, setCompileMessage] = useState('')
  const [compileError, setCompileError] = useState('')
  const [compileSuccessNotice, setCompileSuccessNotice] = useState(null)
  const [isCompiling, setIsCompiling] = useState(false)
  const [strategyDropHoverBucket, setStrategyDropHoverBucket] = useState(null)
  const [dataDropHoverBucket, setDataDropHoverBucket] = useState(null)
  const [fxDropHoverBucket, setFxDropHoverBucket] = useState(null)
  const strategyInstanceCount = useRef(0)
  const dataInstanceCount = useRef(0)
  const bucketInstanceCount = useRef(1)
  const fileOpenRequest = useRef(0)
  const editorGutterRef = useRef(null)
  const resizePointerId = useRef(null)
  const compileNoticeFadeTimer = useRef(null)
  const compileNoticeClearTimer = useRef(null)
  const [isSidebarResizing, setIsSidebarResizing] = useState(false)
  const [backtestResult, setBacktestResult] = useState(null)
  const [activeBacktestScenarioId, setActiveBacktestScenarioId] = useState('both')
  const [backtestError, setBacktestError] = useState('')
  const [simpleBacktestSettingsError, setSimpleBacktestSettingsError] = useState('')
  const [isRunningBacktest, setIsRunningBacktest] = useState(false)
  const [backtestElapsedMs, setBacktestElapsedMs] = useState(null)
  const backtestStartedAt = useRef(null)
  const [simpleBacktestSettingsOpen, setSimpleBacktestSettingsOpen] = useState(false)
  const [simpleBacktestSettingsDraft, setSimpleBacktestSettingsDraft] = useState({ initial_capital: 100000, cost_bps: 0, fill_latency_seconds: 0, capital_allocation: 'SHARED', bucket_capital_mode: 'SHARED', base_currency: 'USD', ignore_currency: false })
  const [simpleBacktestConfig, setSimpleBacktestConfig] = useState(loadBacktestSettings)
  const [gridSearchSettingsOpen, setGridSearchSettingsOpen] = useState(false)
  const [gridSearchConfig, setGridSearchConfig] = useState(loadGridSearchSettings)
  const [yahooTicker, setYahooTicker] = useState('')
  const [selectedYahooInstruments, setSelectedYahooInstruments] = useState([])
  const [yahooSymbolResults, setYahooSymbolResults] = useState([])
  const [isSearchingYahoo, setIsSearchingYahoo] = useState(false)
  const [yahooSearchError, setYahooSearchError] = useState('')
  const [yahooInterval, setYahooInterval] = useState('1d')
  const [yahooFormat, setYahooFormat] = useState('parquet')
  const [yahooFilenameTemplate, setYahooFilenameTemplate] = useState('{name}_{ts}_{startdate}_{enddate}_{tz}_{provider}.{extension}')
  const [yahooStartDate, setYahooStartDate] = useState(defaultStartDate)
  const [yahooEndDate, setYahooEndDate] = useState(() => localDateString(new Date()))
  const [downloadDestination, setDownloadDestination] = useState('./data')
  const [selectingDownloadFolder, setSelectingDownloadFolder] = useState(false)
  const [isYahooDownloading, setIsYahooDownloading] = useState(false)
  const [yahooDownloadProgress, setYahooDownloadProgress] = useState(null)
  const [yahooDownloadError, setYahooDownloadError] = useState('')
  const [yahooDownloadResult, setYahooDownloadResult] = useState(null)
  const [yahooOverwritePrompt, setYahooOverwritePrompt] = useState(null)

  useEffect(() => {
    if (!isRunningBacktest) return undefined
    const timer = window.setInterval(() => {
      if (backtestStartedAt.current !== null) setBacktestElapsedMs(performance.now() - backtestStartedAt.current)
    }, 100)
    return () => window.clearInterval(timer)
  }, [isRunningBacktest])

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPLORER_SETTINGS_KEY, JSON.stringify({ sidebarExpanded, sidebarWidth, builderExpanded, expandedNodes }))
    } catch { /* Explorer state remains available for this session if storage is unavailable. */ }
  }, [sidebarExpanded, sidebarWidth, builderExpanded, expandedNodes])

  useEffect(() => {
    try { window.localStorage.setItem(SITE_THEME_KEY, siteTheme) } catch { /* Theme remains applied for this session if storage is unavailable. */ }
    document.body.dataset.theme = siteTheme
  }, [siteTheme])

  useEffect(() => () => {
    window.clearTimeout(compileNoticeFadeTimer.current)
    window.clearTimeout(compileNoticeClearTimer.current)
  }, [])

  useEffect(() => {
    if (!fileEditor || fileEditor.content === fileEditor.savedContent) return undefined
    const warnBeforeUnload = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [fileEditor])

  useEffect(() => {
    const query = yahooTicker.trim()
    if (activePage !== 'data-download-yahoo-finance' || query.length < 2) {
      const resetTimer = window.setTimeout(() => {
        setYahooSymbolResults([])
        setIsSearchingYahoo(false)
        setYahooSearchError('')
      }, 0)
      return () => window.clearTimeout(resetTimer)
    }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setIsSearchingYahoo(true)
      setYahooSearchError('')
      try {
        const response = await fetch(`/api/data/yahoo/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        const result = await readApiJson(response, 'Yahoo Finance instrument search')
        if (!response.ok) throw new Error(result.error || 'Symbol search failed.')
        setYahooSymbolResults(result.results || [])
      } catch (error) {
        if (error.name !== 'AbortError') setYahooSearchError(error.message)
      } finally {
        if (!controller.signal.aborted) setIsSearchingYahoo(false)
      }
    }, 350)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [activePage, yahooTicker])

  async function applyStrategy(strategy, bucketId = activeBucketId) {
    let savedPresets = strategyPresets[strategy.id]
    if (!savedPresets) {
      try {
        const response = await fetch(`/api/strategies/presets?strategyId=${encodeURIComponent(strategy.id)}`)
        if (response.ok) savedPresets = await response.json()
      } catch { /* Strategy insertion can proceed with current defaults when no saved presets load. */ }
      if (savedPresets) setStrategyPresets((items) => ({ ...items, [strategy.id]: savedPresets }))
    }
    strategyInstanceCount.current += 1
    const instanceId = `${strategy.id}-${strategyInstanceCount.current}`
    const feedIds = dataFiles.filter((file) => file.bucketId === bucketId).map((file) => file.instanceId)
    const activePreset = savedPresets?.presets?.find((preset) => typeof preset.name === 'string' && preset.name.trim().toLowerCase() === 'default')
    setBacktestStrategies((items) => [...items, {
      instanceId,
      bucketId,
      feedIds,
      ...strategy,
      baseConfigDraft: Object.fromEntries(strategy.baseConfig.map((field) => [field.key, field.default])),
      strategyConfigDraft: activePreset ? reconcilePresetConfig(activePreset, strategy) : strategyDefaults(strategy),
      presetId: activePreset?.id || null,
    }])
    setBacktestResult(null)
    setBacktestError('')
    if (activePreset && presetIsStale(activePreset, strategy)) {
      const config = reconcilePresetConfig(activePreset, strategy)
      const migrated = { ...activePreset, config, fields: Object.fromEntries(strategy.parameters.map((field) => [field.key, presetFieldSchema(field)])) }
      persistStrategyPresets(strategy.id, { ...savedPresets, presets: savedPresets.presets.map((preset) => preset.id === activePreset.id ? migrated : preset), lastPresetId: activePreset.id }).catch((error) => setBacktestError(error.message))
    }
  }

  async function persistStrategyPresets(strategyId, next) {
    const response = await fetch('/api/strategies/presets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategyId, ...next }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Could not save strategy presets.')
    setStrategyPresets((items) => ({ ...items, [strategyId]: result }))
    return result
  }

  async function openStrategyPresets(strategy) {
    if (!strategy) return
    try {
      const response = await fetch(`/api/strategies/presets?strategyId=${encodeURIComponent(strategy.id)}`)
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not load strategy presets.')
      setStrategyPresets((items) => ({ ...items, [strategy.id]: result }))
      setPresetManagerData(result)
      setPresetManagerStrategy(strategy)
    } catch (error) {
      setItemDialogError(error.message)
    }
  }

  async function selectStrategyPreset(instanceId, presetId) {
    const instance = backtestStrategies.find((item) => item.instanceId === instanceId)
    const presets = strategyPresets[instance?.id]?.presets || []
    const preset = presets.find((item) => item.id === presetId)
    if (!instance || !preset) return
    const config = reconcilePresetConfig(preset, instance)
    setBacktestStrategies((items) => items.map((item) => item.instanceId === instanceId ? { ...item, strategyConfigDraft: config, presetId } : item))
    setPresetMenuInstanceId(null)
    setBacktestResult(null)
    if (presetIsStale(preset, instance)) {
      const fields = Object.fromEntries(instance.parameters.map((field) => [field.key, presetFieldSchema(field)]))
      const migrated = { ...preset, config, fields }
      await persistStrategyPresets(instance.id, { ...strategyPresets[instance.id], presets: presets.map((item) => item.id === presetId ? migrated : item), lastPresetId: presetId })
    } else {
      const current = strategyPresets[instance.id]
      if (current?.lastPresetId !== presetId) await persistStrategyPresets(instance.id, { ...current, lastPresetId: presetId })
    }
  }

  function handleStrategyDrop(bucketId, event) {
    event.preventDefault()
    const strategyId = event.dataTransfer.getData('application/x-quantogral-strategy')
    const strategy = strategyCatalog.find((item) => item.id === strategyId)
    if (strategy) applyStrategy(strategy, bucketId)
    else setBacktestError('That strategy is not available in the discovered C++ strategy catalog.')
  }

  function addDataFile(path, name = path.split('/').pop(), bucketId = activeBucketId) {
    if (!path) return
    const duplicate = dataFiles.find((item) => item.path === path && item.bucketId === bucketId)
    if (duplicate) return
    dataInstanceCount.current += 1
    const instanceId = `feed-${dataInstanceCount.current}`
    const relativePath = path.replace(/^\.\/data\//, '')
    const metadata = datasetMetadata[relativePath] || { currency: 'USD', timezone: 'UTC', fxBaseCurrency: '', fxQuoteCurrency: '' }
    setDataFiles((items) => [...items, { instanceId, bucketId, path, name, tsUnit: 'MILLISECONDS', dateFormat: 'DDMMYYYY', datasetSettings: metadata }])
    if (!datasetMetadata[relativePath]) {
      fetch(`/api/data/settings?path=${encodeURIComponent(relativePath)}`).then((response) => response.ok ? response.json() : null).then((settings) => {
        if (!settings) return
        setDatasetMetadata((current) => ({ ...current, [relativePath]: settings }))
        setDataFiles((items) => items.map((feed) => feed.instanceId === instanceId ? { ...feed, datasetSettings: settings } : feed))
      }).catch(() => {})
    }
    setBacktestStrategies((items) => items.map((item) => item.bucketId === bucketId
      ? { ...item, feedIds: item.feedIds.includes(instanceId) ? item.feedIds : [...item.feedIds, instanceId] }
      : item))
    setBacktestResult(null)
    setBacktestError('')
  }

  function handleDataDrop(bucketId, event) {
    event.preventDefault()
    const path = event.dataTransfer.getData('application/x-quantogral-data-file')
    if (path) addDataFile(path, path.replaceAll('\\', '/').split('/').pop(), bucketId)
  }

  async function handleFxDrop(bucketId, event) {
    event.preventDefault()
    setFxDropHoverBucket(null)
    const path = event.dataTransfer.getData('application/x-quantogral-data-file')
    if (!path) return
    const duplicate = fxFiles.find((item) => item.path === path && item.bucketId === bucketId)
    if (duplicate) return
    const relativePath = path.replace(/^\.\/data\//, '')
    let metadata = datasetMetadata[relativePath]
    try {
      if (!metadata) {
        const response = await fetch(`/api/data/settings?path=${encodeURIComponent(relativePath)}`)
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not read FX file settings.')
        metadata = result
        setDatasetMetadata((items) => ({ ...items, [relativePath]: result }))
      }
      dataInstanceCount.current += 1
      setFxFiles((items) => [...items, { instanceId: `fx-${dataInstanceCount.current}`, bucketId, path, name: path.split('/').pop(), datasetSettings: metadata, tsUnit: 'MILLISECONDS', dateFormat: 'DDMMYYYY' }])
      setBacktestResult(null)
      setBacktestError('')
    } catch (error) {
      setBacktestError(error.message)
    }
  }

  function addManualDataFile(bucketId = activeBucketId) {
    const path = manualDataPath.trim()
    if (!path) return
    addDataFile(path, path.replaceAll('\\', '/').split('/').pop(), bucketId)
    setManualDataPath('')
  }

  function removeDataFile(instanceId) {
    setDataFiles((items) => items.filter((item) => item.instanceId !== instanceId))
    setBacktestStrategies((items) => items.map((item) => ({ ...item, feedIds: item.feedIds.filter((feedId) => feedId !== instanceId) })))
    setBacktestResult(null)
  }

  function updateFeed(instanceId, key, value) {
    setDataFiles((items) => items.map((item) => item.instanceId === instanceId ? { ...item, [key]: value } : item))
    setBacktestResult(null)
  }

  function updateFxFeed(instanceId, key, value) {
    setFxFiles((items) => items.map((item) => item.instanceId === instanceId ? { ...item, [key]: value } : item))
    setBacktestResult(null)
  }

  async function updateFxPair(instanceId, key, value) {
    const feed = fxFiles.find((item) => item.instanceId === instanceId)
    if (!feed) return
    const relativePath = feed.path.replace(/^\.\/data\//, '')
    const nextSettings = { ...feed.datasetSettings, [key]: value }
    setFxFiles((items) => items.map((item) => item.instanceId === instanceId ? { ...item, datasetSettings: nextSettings } : item))
    setBacktestResult(null)
    try {
      const response = await fetch('/api/data/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...nextSettings, path: relativePath }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save the FX currency pair.')
      setDatasetMetadata((items) => ({ ...items, [relativePath]: result }))
      setFxFiles((items) => items.map((item) => item.instanceId === instanceId ? { ...item, datasetSettings: result } : item))
      setBacktestError('')
    } catch (error) {
      setBacktestError(error.message)
    }
  }

  function toggleStrategyFeed(instanceId, feedId) {
    setBacktestStrategies((items) => items.map((item) => item.instanceId === instanceId
      ? { ...item, feedIds: item.feedIds.includes(feedId) ? item.feedIds.filter((id) => id !== feedId) : [...item.feedIds, feedId] }
      : item))
    setBacktestResult(null)
  }

  function addBacktestBucket() {
    bucketInstanceCount.current += 1
    const bucket = { id: `bucket-${bucketInstanceCount.current}`, name: `Bucket ${bucketInstanceCount.current}` }
    setBacktestBuckets((items) => [...items, bucket])
    setActiveBucketId(bucket.id)
  }

  function removeBacktestBucket(bucketId) {
    if (backtestBuckets.length <= 1) return
    const remaining = backtestBuckets.filter((bucket) => bucket.id !== bucketId)
    setBacktestBuckets(remaining)
    setBacktestStrategies((items) => items.filter((item) => item.bucketId !== bucketId))
    setDataFiles((items) => items.filter((item) => item.bucketId !== bucketId))
    setFxFiles((items) => items.filter((item) => item.bucketId !== bucketId))
    if (activeBucketId === bucketId) setActiveBucketId(remaining[0].id)
    setBacktestResult(null)
  }

  function resetBacktestWorkspace() {
    setBacktestBuckets([{ id: 'bucket-1', name: 'Bucket 1' }])
    setActiveBucketId('bucket-1')
    setBacktestStrategies([])
    setExpandedBacktestStrategies({})
    setDataFiles([])
    setFxFiles([])
    setManualDataPath('')
    setStrategyDropHoverBucket(null)
    setDataDropHoverBucket(null)
    strategyInstanceCount.current = 0
    dataInstanceCount.current = 0
    bucketInstanceCount.current = 1
    setBacktestResult(null)
    setActiveBacktestScenarioId('both')
    setBacktestError('')
    setBacktestElapsedMs(null)
  }

  function updateBacktestStrategy(instanceId, section, key, value) {
    setBacktestStrategies((items) => items.map((item) => item.instanceId === instanceId
      ? { ...item, [section]: { ...item[section], [key]: value } }
      : item))
    setBacktestResult(null)
  }

  useEffect(() => {
    let isCurrent = true
    async function loadConfig() {
      try {
        const response = await fetch('/api/config')
        if (!response.ok) throw new Error('Could not load local workspace configuration.')
        const config = await response.json()
        if (isCurrent) {
          setBuilderPath(config.builder.path)
          const savedSettings = config.simpleBacktestConfigured ? config.simple_backtest : loadBacktestSettings()
          setSimpleBacktestConfig(savedSettings)
          setSimpleBacktestSettingsDraft(savedSettings)
          const savedGridSettings = config.gridSearchConfigured ? config.grid_search : loadGridSearchSettings()
          setGridSearchConfig(savedGridSettings)
          try { window.localStorage.setItem(GRID_SEARCH_SETTINGS_KEY, JSON.stringify(savedGridSettings)) } catch { /* Project config remains the saved copy. */ }
          if (!config.simpleBacktestConfigured) {
            await fetch('/api/config/backtest', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...savedSettings, mode: 'simple' }) })
          }
          if (!config.gridSearchConfigured) {
            await fetch('/api/config/backtest', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'gridsearch', settings: savedGridSettings }) })
          }
        }
      } catch (error) {
        if (isCurrent) setSaveError(error.message)
      }
    }
    loadConfig()
    return () => { isCurrent = false }
  }, [])

  useEffect(() => {
    let isCurrent = true
    Promise.all([fetch('/api/strategies'), fetch('/api/compilation')])
      .then(async ([strategyResponse, compilationResponse]) => {
        if (!strategyResponse.ok || !compilationResponse.ok) throw new Error('Could not load the C++ strategy catalog.')
        return [await strategyResponse.json(), await compilationResponse.json()]
      })
      .then(([catalog, state]) => {
        if (!isCurrent) return
        setStrategyCatalog(catalog.strategies)
        setCompilation(state)
        setCompileSelection(Object.fromEntries(state.strategies.map((strategy) => [strategy.id, true])))
        Promise.all(catalog.strategies.map(async (strategy) => {
          const response = await fetch(`/api/strategies/presets?strategyId=${encodeURIComponent(strategy.id)}`)
          if (!response.ok) return [strategy.id, { presets: [], lastPresetId: null }]
          return [strategy.id, await response.json()]
        })).then((entries) => { if (isCurrent) setStrategyPresets(Object.fromEntries(entries)) }).catch(() => {})
      })
      .catch(() => {
        if (isCurrent) setCompileError('Could not load C++ compilation status.')
      })
    return () => { isCurrent = false }
  }, [])

  useEffect(() => {
    let isCurrent = true
    fetch('/api/builder/tree')
      .then((response) => {
        if (!response.ok) throw new Error('Could not read Builder folders.')
        return response.json()
      })
      .then((tree) => {
        if (isCurrent) {
          setBuilderTree(tree.children)
          setDataTree(tree.dataChildren || [])
        }
      })
      .catch(() => {
        if (isCurrent) setBuilderTree([
          { name: 'strategies', type: 'directory', children: [] },
          { name: 'indicators', type: 'directory', children: [] },
        ])
        if (isCurrent) setDataTree([])
      })
    return () => { isCurrent = false }
  }, [builderPath])

  function toggleBuilder() {
    setBuilderExpanded((expanded) => !expanded)
  }

  function toggleTreeNode(nodeKey) {
    setExpandedNodes((nodes) => ({ ...nodes, [nodeKey]: !nodes[nodeKey] }))
  }

  function collapseExplorerToDefault() {
    setSidebarExpanded(true)
    setBuilderExpanded(true)
    setExpandedNodes({})
  }

  function resizeSidebar(event) {
    if (resizePointerId.current !== event.pointerId) return
    setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, event.clientX)))
  }

  function openBuilderDialog() {
    setPathDraft(builderPath)
    setSaveError('')
    setCompileError('')
    setCompileMessage('')
    setBuilderDialogView('menu')
    setBuilderDialogOpen(true)
  }

  function openItemSettings(item) {
    setItemDialog(item)
    setItemDialogAction('menu')
    setItemNameDraft('')
    setItemDialogError('')
  }

  async function openDatasetSettings(item) {
    setDatasetSettingsError('')
    try {
      const response = await fetch(`/api/data/settings?path=${encodeURIComponent(item.path)}`)
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not load dataset settings.')
      setDatasetSettingsDraft(result)
      setDatasetSettingsDialog(item)
      setDatasetMetadata((metadata) => ({ ...metadata, [item.path]: result }))
      setItemDialog(null)
    } catch (error) {
      setItemDialogError(error.message)
    }
  }

  function updateDatasetSettingsDraft(key, value) {
    setDatasetSettingsDraft((settings) => ({ ...settings, [key]: value }))
  }

  async function saveDatasetSettings() {
    if (!datasetSettingsDialog || !datasetSettingsDraft || savingDatasetSettings) return
    setSavingDatasetSettings(true)
    setDatasetSettingsError('')
    try {
      const response = await fetch('/api/data/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...datasetSettingsDraft, path: datasetSettingsDialog.path }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save dataset settings.')
      setDatasetMetadata((metadata) => ({ ...metadata, [result.path]: result }))
      setDataFiles((items) => items.map((feed) => feed.path === `./data/${result.path}` ? { ...feed, datasetSettings: result } : feed))
      setFxFiles((items) => items.map((feed) => feed.path === `./data/${result.path}` ? { ...feed, datasetSettings: result } : feed))
      setDatasetSettingsDialog(null)
      setBacktestResult(null)
    } catch (error) {
      setDatasetSettingsError(error.message)
    } finally {
      setSavingDatasetSettings(false)
    }
  }

  function openSimpleBacktestSettings() {
    setSimpleBacktestSettingsError('')
    if (simpleBacktestSettingsOpen) {
      setSimpleBacktestSettingsOpen(false)
    } else {
      setSimpleBacktestSettingsDraft(simpleBacktestConfig)
      setSimpleBacktestSettingsOpen(true)
    }
  }

  function updateSimpleBacktestSettingsDraft(key, value) {
    setSimpleBacktestSettingsDraft((settings) => ({ ...settings, [key]: value }))
  }

  async function saveSimpleBacktestSettings() {
    const settings = {
      initial_capital: Number(simpleBacktestSettingsDraft.initial_capital),
      cost_bps: Number(simpleBacktestSettingsDraft.cost_bps),
      fill_latency_seconds: Number(simpleBacktestSettingsDraft.fill_latency_seconds),
      capital_allocation: simpleBacktestSettingsDraft.capital_allocation,
      bucket_capital_mode: simpleBacktestSettingsDraft.bucket_capital_mode || 'SHARED',
      run_mode: simpleBacktestSettingsDraft.run_mode,
      base_currency: simpleBacktestSettingsDraft.base_currency,
      ignore_currency: Boolean(simpleBacktestSettingsDraft.ignore_currency),
    }
    setSimpleBacktestSettingsError('')
    try {
      const response = await fetch('/api/config/backtest', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, mode: 'simple' }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save backtest settings.')
      setSimpleBacktestConfig(settings)
      try { window.localStorage.setItem(BACKTEST_SETTINGS_KEY, JSON.stringify(settings)) } catch { /* The local project config remains the saved copy. */ }
      setSimpleBacktestSettingsOpen(false)
    } catch (error) {
      setSimpleBacktestSettingsError(error.message)
    }
  }

  function openGridSearchSettings() {
    setGridSearchSettingsOpen((open) => !open)
  }

  function beginCreateItem() {
    setItemDialogAction('create')
    setItemNameDraft('')
    setItemDialogError('')
  }

  function beginRenameItem() {
    setItemDialogAction('rename')
    setItemNameDraft(itemDialog?.name || '')
    setItemDialogError('')
  }

  function beginSelectDownloadFolder() {
    setSelectingDownloadFolder(true)
    setSidebarExpanded(true)
    setExpandedNodes((nodes) => ({ ...nodes, data: true }))
  }

  function selectDownloadFolder(path) {
    setDownloadDestination(path)
    setSelectingDownloadFolder(false)
    setYahooDownloadError('')
    setYahooDownloadResult(null)
  }

  async function openWorkspaceFile(file) {
    const requestId = ++fileOpenRequest.current
    setEditorError('')
    setFileEditor({ ...file, format: '', content: '', savedContent: '', loading: true })
    try {
      const query = new URLSearchParams({ scope: file.scope, path: file.path })
      const response = await fetch(`/api/workspace/file?${query}`)
      const result = await readApiJson(response, 'workspace file')
      if (!response.ok) throw new Error(result.error || 'Could not open this file.')
      if (requestId !== fileOpenRequest.current) return
      setFileEditor({ ...file, format: result.format, content: result.content, savedContent: result.content, loading: false, rows: result.rows, columns: result.columns, csvTableView: file.name.toLowerCase().endsWith('.csv') })
    } catch (error) {
      if (requestId !== fileOpenRequest.current) return
      setFileEditor({ ...file, format: '', content: '', savedContent: '', loading: false, error: error.message })
    }
  }

  async function openWorkspacePreview(file) {
    const requestId = ++workspacePreviewRequest.current
    setItemDialog(null)
    setWorkspacePreview({ ...file, loading: true, content: '' })
    try {
      const query = new URLSearchParams({ scope: file.scope, path: file.path, preview: '1' })
      const response = await fetch(`/api/workspace/file?${query}`)
      const result = await readApiJson(response, 'file preview')
      if (!response.ok) throw new Error(result.error || 'Could not preview this file.')
      if (requestId !== workspacePreviewRequest.current) return
      const parquetData = result.format === 'parquet-json' ? JSON.parse(result.content) : null
      setWorkspacePreview({ ...file, ...result, previewRows: parquetData?.rows || [], loading: false })
    } catch (error) {
      if (requestId !== workspacePreviewRequest.current) return
      setWorkspacePreview({ ...file, loading: false, error: error.message })
    }
  }

  function closeWorkspacePreview() {
    workspacePreviewRequest.current += 1
    setWorkspacePreview(null)
  }

  const persistWorkspaceFile = useCallback(async (editor) => {
    const response = await fetch('/api/workspace/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: editor.scope, path: editor.path, content: editor.content }),
    })
    const result = await readApiJson(response, 'workspace file save')
    if (!response.ok) throw new Error(result.error || 'Could not save this file.')
    return result
  }, [])

  const refreshStrategyCatalog = useCallback(async () => {
    const [catalogResponse, compilationResponse] = await Promise.all([fetch('/api/strategies'), fetch('/api/compilation')])
    const [catalog, state] = await Promise.all([readApiJson(catalogResponse, 'strategy catalog'), readApiJson(compilationResponse, 'compilation status')])
    if (!catalogResponse.ok || !compilationResponse.ok) throw new Error('Could not refresh the C++ strategy catalog.')
    setStrategyCatalog(catalog.strategies || [])
    setCompilation(state)
    setCompileSelection((current) => Object.fromEntries((catalog.strategies || []).map((strategy) => [strategy.id, current[strategy.id] ?? true])))
  }, [])

  const refreshCatalogIfStrategyHeader = useCallback(async (editor) => {
    if (editor.scope === 'builder' && editor.path.includes('strategies/') && editor.path.toLowerCase().endsWith('.hpp')) {
      try {
        await refreshStrategyCatalog()
      } catch (error) {
        setCompileError(`File saved, but strategy discovery failed: ${error.message}`)
      }
    }
  }, [refreshStrategyCatalog])

  const saveCurrentWorkspaceFile = useCallback(async () => {
    if (!fileEditor || fileEditor.loading) return false
    const contentToSave = fileEditor.content
    setEditorSaving(true)
    setEditorError('')
    try {
      await persistWorkspaceFile(fileEditor)
      setFileEditor((current) => current ? { ...current, savedContent: contentToSave } : current)
      await refreshCatalogIfStrategyHeader(fileEditor)
      return true
    } catch (error) {
      setEditorError(error.message)
      return false
    } finally {
      setEditorSaving(false)
    }
  }, [fileEditor, persistWorkspaceFile, refreshCatalogIfStrategyHeader])

  useEffect(() => {
    if (!fileEditor) return undefined
    const saveOnShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!editorSaving && !fileEditor.loading && fileEditor.content !== fileEditor.savedContent) saveCurrentWorkspaceFile()
      }
    }
    window.addEventListener('keydown', saveOnShortcut)
    return () => window.removeEventListener('keydown', saveOnShortcut)
  }, [fileEditor, editorSaving, saveCurrentWorkspaceFile])

  function applyEditorAction(action) {
    if (!action) return
    if (action.type !== 'open') fileOpenRequest.current += 1
    setPendingEditorAction(null)
    setUnsavedPromptOpen(false)
    setUnsavedPromptError('')
    if (action.type === 'open') openWorkspaceFile(action.file)
    else if (action.type === 'page') { setFileEditor(null); setActivePage(action.page) }
    else if (action.type === 'close') setFileEditor(null)
  }

  function requestEditorAction(action) {
    if (fileEditor?.content !== fileEditor?.savedContent) {
      setPendingEditorAction(action)
      setUnsavedPromptError('')
      setUnsavedPromptOpen(true)
      return
    }
    applyEditorAction(action)
  }

  function requestOpenWorkspaceFile(file) {
    if (fileEditor?.scope === file.scope && fileEditor?.path === file.path) return
    requestEditorAction({ type: 'open', file })
  }

  function navigateToPage(page) {
    requestEditorAction({ type: 'page', page })
  }

  async function resolveUnsavedPrompt(choice) {
    if (choice === 'cancel') {
      setUnsavedPromptOpen(false)
      setPendingEditorAction(null)
      return
    }
    if (choice === 'save') {
      setEditorSaving(true)
      setUnsavedPromptError('')
      try {
        await persistWorkspaceFile(fileEditor)
        await refreshCatalogIfStrategyHeader(fileEditor)
      } catch (error) {
        setUnsavedPromptError(`Could not save changes: ${error.message}`)
        setEditorSaving(false)
        return
      }
      setEditorSaving(false)
    }
    applyEditorAction(pendingEditorAction)
  }

  async function submitWorkspaceItem(event) {
    event.preventDefault()
    if (!itemDialog) return
    setItemDialogError('')
    try {
      const isRename = itemDialogAction === 'rename'
      const response = await fetch('/api/workspace/items', {
        method: isRename ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isRename
          ? { scope: itemDialog.scope, path: itemDialog.path, name: itemNameDraft }
          : { scope: itemDialog.scope, directory: itemDialog.path, name: itemNameDraft }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || `Could not ${isRename ? 'rename' : 'create'} item.`)
      const treeResponse = await fetch('/api/builder/tree')
      if (!treeResponse.ok) throw new Error('Item changed, but the project explorer could not refresh.')
      const tree = await treeResponse.json()
      setBuilderTree(tree.children)
      setDataTree(tree.dataChildren || [])
      if (itemDialog.scope === 'builder') await refreshStrategyCatalog()
      if (itemDialog.scope === 'builder') setBuilderExpanded(true)
      else setExpandedNodes((nodes) => ({ ...nodes, data: true }))
      if (!isRename && result.type === 'directory') {
        const key = `${itemDialog.scope === 'data' ? 'data' : 'Builder'}${itemDialog.path ? `/${itemDialog.path}` : ''}/${result.name}`
        setExpandedNodes((nodes) => ({ ...nodes, [key]: true }))
      }
      setItemDialog(null)
    } catch (error) {
      setItemDialogError(error.message)
    }
  }

  async function confirmDeleteWorkspaceItem() {
    if (!deleteItemPrompt || isDeletingItem) return
    setDeleteItemError('')
    setIsDeletingItem(true)
    try {
      const response = await fetch('/api/workspace/items', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: deleteItemPrompt.scope, path: deleteItemPrompt.path }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not delete this file.')
      const deleted = deleteItemPrompt
      setDeleteItemPrompt(null)
      if (fileEditor?.scope === deleted.scope && fileEditor.path === deleted.path) setFileEditor(null)
      try {
        const treeResponse = await fetch('/api/builder/tree')
        if (!treeResponse.ok) throw new Error('File deleted, but the project explorer could not refresh.')
        const tree = await treeResponse.json()
        setBuilderTree(tree.children)
        setDataTree(tree.dataChildren || [])
      } catch (error) {
        setSaveError(error.message)
      }
      if (deleted.scope === 'builder') {
        try { await refreshStrategyCatalog() } catch (error) { setCompileError(`File deleted, but strategy discovery failed: ${error.message}`) }
      }
    } catch (error) {
      setDeleteItemError(error.message)
    } finally {
      setIsDeletingItem(false)
    }
  }

  async function watchYahooDownloadJob(jobId) {
    let job
    do {
      await new Promise((resolve) => window.setTimeout(resolve, 500))
      const statusResponse = await fetch(`/api/data/yahoo/download/${encodeURIComponent(jobId)}`)
      job = await readApiJson(statusResponse, 'Yahoo Finance download status')
      if (!statusResponse.ok) throw new Error(job.error || 'Could not read download status.')
      setYahooDownloadProgress(job)
    } while (!job.finished)
    setYahooDownloadResult(job)
    setYahooOverwritePrompt(job.needsConfirmation ? job : null)
    fetch('/api/builder/tree').then((treeResponse) => treeResponse.ok ? treeResponse.json() : null).then((tree) => {
      if (tree) { setBuilderTree(tree.children); setDataTree(tree.dataChildren || []) }
    }).catch(() => {})
    return job
  }

  async function submitYahooDownload(event) {
    event.preventDefault()
    setYahooDownloadError('')
    setYahooDownloadResult(null)
    const missing = []
    if (selectedYahooInstruments.length === 0) missing.push('select at least one instrument')
    if (!yahooStartDate) missing.push('choose a start date')
    if (!yahooEndDate) missing.push('choose an end date')
    if (yahooStartDate && yahooEndDate && yahooStartDate > yahooEndDate) missing.push('make sure the start date is on or before the end date')
    if (!downloadDestination.trim()) missing.push('choose or enter a destination folder')
    if (!yahooFilenameTemplate.trim()) missing.push('enter a filename pattern')
    if (missing.length) {
      setYahooDownloadError(`Can't download yet: ${missing.join('; ')}.`)
      return
    }
    setYahooOverwritePrompt(null)
    setIsYahooDownloading(true)
    setYahooDownloadProgress({ status: 'Starting download…', completed: 0, total: selectedYahooInstruments.length, currentTicker: null, results: [], errors: [] })
    try {
      const response = await fetch('/api/data/yahoo/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers: selectedYahooInstruments.map((instrument) => instrument.symbol), interval: yahooInterval, startDate: yahooStartDate, endDate: yahooEndDate, format: yahooFormat, destination: downloadDestination, filenameTemplate: yahooFilenameTemplate }),
      })
      const launch = await readApiJson(response, 'Yahoo Finance download')
      if (!response.ok) throw new Error(launch.error || 'Yahoo Finance download failed.')
      await watchYahooDownloadJob(launch.jobId)
    } catch (error) {
      setYahooDownloadError(error.message)
      setYahooDownloadProgress((progress) => progress ? { ...progress, status: 'Download status unavailable' } : null)
    } finally {
      setIsYahooDownloading(false)
    }
  }

  async function overwriteYahooDataFiles() {
    if (!yahooOverwritePrompt) return
    setIsYahooDownloading(true)
    setYahooDownloadError('')
    try {
      const response = await fetch(`/api/data/yahoo/download/${encodeURIComponent(yahooOverwritePrompt.jobId)}/overwrite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const result = await readApiJson(response, 'Yahoo Finance overwrite confirmation')
      if (!response.ok) throw new Error(result.error || 'Could not overwrite existing data files.')
      setYahooOverwritePrompt(null)
      await watchYahooDownloadJob(result.jobId)
    } catch (error) {
      setYahooDownloadError(error.message)
    } finally {
      setIsYahooDownloading(false)
    }
  }

  function backFromYahooOverwrite() {
    setYahooOverwritePrompt(null)
    setYahooDownloadProgress((progress) => progress ? { ...progress, status: 'Stopped; existing files were left unchanged.' } : null)
  }

  async function openCompilationView() {
    setBuilderDialogView('compilation')
    setCompileError('')
    try {
      const response = await fetch('/api/compilation')
      if (!response.ok) throw new Error('Could not read C++ compilation status.')
      const state = await response.json()
      setCompilation(state)
      setStrategyCatalog(state.strategies)
      setCompileSelection((selected) => Object.keys(selected).length
        ? selected
        : Object.fromEntries(state.strategies.map((strategy) => [strategy.id, true])))
    } catch (error) {
      setCompileError(error.message)
    }
  }

  async function compileStrategies(mode) {
    if (mode === 'selected' && !Object.values(compileSelection).some(Boolean)) {
      setCompileError('Select at least one strategy to compile.')
      return
    }
    setIsCompiling(true)
    setCompileError('')
    setCompileMessage(mode === 'all' ? 'Compiling all discovered strategies…' : 'Compiling selected strategies…')
    try {
      const strategyIds = Object.entries(compileSelection).filter(([, selected]) => selected).map(([id]) => id)
      const response = await fetch('/api/compilation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, strategyIds }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Compilation failed.')
      setCompilation({ compiled: result.compiled, current: result.current, strategies: strategyCatalog })
      setCompileMessage(result.message)
      if (mode === 'selected') {
        window.clearTimeout(compileNoticeFadeTimer.current)
        window.clearTimeout(compileNoticeClearTimer.current)
        setSelectingStrategies(false)
        setCompileSuccessNotice({ message: result.message, fading: false })
        compileNoticeFadeTimer.current = window.setTimeout(() => {
          setCompileSuccessNotice((notice) => notice ? { ...notice, fading: true } : null)
          compileNoticeClearTimer.current = window.setTimeout(() => setCompileSuccessNotice(null), 400)
        }, 5000)
      }
    } catch (error) {
      setCompileMessage('')
      setCompileError(error.message)
    } finally {
      setIsCompiling(false)
    }
  }

  function startCompileSelection() {
    setCompileSelection(Object.fromEntries(strategyCatalog.map((strategy) => [strategy.id, false])))
    setCompileError('')
    setCompileMessage('')
    setBuilderDialogOpen(false)
    setSidebarExpanded(true)
    setBuilderExpanded(true)
    const strategyFolderKeys = findStrategyFolderKeys(builderTree, strategyCatalog)
    setExpandedNodes((nodes) => ({ ...nodes, 'Builder/strategies': true, ...Object.fromEntries(strategyFolderKeys.map((key) => [key, true])) }))
    setSelectingStrategies(true)
  }

  function cancelCompileSelection() {
    setSelectingStrategies(false)
    setCompileError('')
    setCompileMessage('')
  }

  function toggleCompileSelection(strategyId) {
    setCompileSelection((selection) => ({ ...selection, [strategyId]: !selection[strategyId] }))
    setCompileError('')
  }

  async function saveBuilderPath(event) {
    event.preventDefault()
    const normalizedPath = pathDraft.trim() || DEFAULT_BUILDER_PATH
    setSaveError('')
    try {
      const response = await fetch('/api/config/builder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizedPath }),
      })
      if (!response.ok) throw new Error('Could not save the local workspace configuration.')
      const config = await response.json()
      setBuilderPath(config.builder.path)
      setBuilderDialogOpen(false)
    } catch (error) {
      setSaveError(error.message)
    }
  }

  async function runSimpleBacktest(event) {
    event.preventDefault()
    const populatedBuckets = backtestBuckets.filter((bucket) =>
      backtestStrategies.some((strategy) => strategy.bucketId === bucket.id) || dataFiles.some((feed) => feed.bucketId === bucket.id))
    if (!populatedBuckets.length) {
      setBacktestError('Add a strategy and at least one data feed to a bucket before running.')
      return
    }
    const incompleteBucket = populatedBuckets.find((bucket) => {
      const bucketStrategies = backtestStrategies.filter((strategy) => strategy.bucketId === bucket.id)
      const bucketFeeds = dataFiles.filter((feed) => feed.bucketId === bucket.id)
      return !bucketStrategies.length || !bucketFeeds.length || bucketStrategies.some((strategy) => !strategy.feedIds.length)
    })
    if (incompleteBucket) {
      setBacktestError(`${incompleteBucket.name} needs at least one strategy, one feed, and a feed connection for each strategy.`)
      return
    }
    setBacktestError('')
    setBacktestResult(null)
    backtestStartedAt.current = performance.now()
    setBacktestElapsedMs(0)
    setIsRunningBacktest(true)
    try {
      const response = await fetch('/api/backtests/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buckets: populatedBuckets.map((bucket) => ({
            id: bucket.id,
            feeds: dataFiles.filter((feed) => feed.bucketId === bucket.id).map((feed) => ({
              id: feed.instanceId,
              path: feed.path,
              tsUnit: feed.tsUnit,
              dateFormat: feed.dateFormat,
            })),
            fxFeeds: fxFiles.filter((feed) => feed.bucketId === bucket.id).map((feed) => ({ path: feed.path, tsUnit: feed.tsUnit, dateFormat: feed.dateFormat })),
            strategies: backtestStrategies.filter((strategy) => strategy.bucketId === bucket.id).map((strategy) => ({
              instanceId: strategy.instanceId,
              strategyId: strategy.id,
              feedIds: strategy.feedIds,
              baseConfig: strategy.baseConfigDraft,
              parameters: strategy.strategyConfigDraft,
            })),
          })),
          backtestConfig: simpleBacktestConfig,
        }),
      })
      const result = await readApiJson(response, 'backtest run')
      if (!response.ok) throw new Error(result.error || 'Backtest failed.')
      setBacktestResult(result)
      setActiveBacktestScenarioId(result.scenarios?.[0]?.scenarioId || result.scenarioId || 'both')
    } catch (error) {
      setBacktestError(error.message)
    } finally {
      if (backtestStartedAt.current !== null) {
        setBacktestElapsedMs(performance.now() - backtestStartedAt.current)
        backtestStartedAt.current = null
      }
      setIsRunningBacktest(false)
    }
  }

  const isHome = activePage === 'home'
  const isDataDownload = activePage === 'data-download'
  const isYahooFinance = activePage === 'data-download-yahoo-finance'
  const isBacktesting = activePage === 'backtesting'
  const isGridSearch = activePage === 'gridsearch'
  const isSimpleBacktesting = activePage === 'simplebacktesting'
  const isBuilder = activePage === 'builder'
  const isSettings = activePage === 'settings'
  const isBacktestingSection = isBacktesting || isGridSearch || isSimpleBacktesting
  const hasProjectSidebar = isBuilder || isGridSearch || isSimpleBacktesting || isDataDownload || isYahooFinance
  const selectedStrategies = strategyCatalog.filter((strategy) => compileSelection[strategy.id])
  const yahooToday = localDateString(new Date())
  const resultScenarios = backtestResult?.scenarios || (backtestResult ? [backtestResult] : [])
  const activeBacktestReport = resultScenarios.find((scenario) => scenario.scenarioId === activeBacktestScenarioId) || resultScenarios[0]
  const compareBacktestReports = backtestResult?.runMode === 'COMPARE_ALL'
  const parquetPreviewRows = workspacePreview?.format === 'parquet-json'
    ? (workspacePreview.previewRows || []).map((row, index) => ({ lineNumber: index + 1, values: (workspacePreview.columns || []).map((column) => row[column] == null ? '' : typeof row[column] === 'object' ? JSON.stringify(row[column]) : String(row[column])) }))
    : []
  const yahooFilenamePreview = yahooFilenameTemplate
    .replaceAll('{name}', selectedYahooInstruments[0]?.symbol || 'AAPL')
    .replaceAll('{symbol}', selectedYahooInstruments[0]?.symbol || 'AAPL')
    .replaceAll('{ts}', yahooInterval).replaceAll('{interval}', yahooInterval)
    .replaceAll('{startdate}', yahooStartDate).replaceAll('{start}', yahooStartDate)
    .replaceAll('{enddate}', yahooEndDate).replaceAll('{end}', yahooEndDate)
    .replaceAll('{provider}', 'yfinance').replaceAll('{tz}', 'exchange_timezone').replaceAll('{timezone}', 'exchange_timezone')
    .replaceAll('{extension}', yahooFormat)

  return (
    <div className="app-shell" data-theme={siteTheme} style={{ '--sidebar-expanded-width': `${sidebarWidth}px` }}>
      {hasProjectSidebar && (
        <aside className={`project-sidebar ${sidebarExpanded ? 'is-expanded' : 'is-collapsed'} ${isSidebarResizing ? 'is-resizing' : ''} ${selectingStrategies ? 'is-selecting-strategies' : ''} ${selectingDownloadFolder ? 'is-selecting-download-folder' : ''}`}>
          <div className="sidebar-header">
            {sidebarExpanded && <span className="sidebar-title">{selectingStrategies ? 'SELECT STRATEGIES' : 'PROJECT'}</span>}
            <button aria-label={sidebarExpanded ? 'Collapse project explorer' : 'Expand project explorer'} className="sidebar-toggle" onClick={() => setSidebarExpanded((expanded) => !expanded)} type="button">
              {sidebarExpanded ? '‹' : '›'}
            </button>
          </div>

          {sidebarExpanded && (
            <nav aria-label="Project explorer" className="project-tree">
              <div className="project-tree-toolbar">
                <button className="collapse-all-button" onClick={collapseExplorerToDefault} type="button">Collapse all</button>
              </div>
              {selectingDownloadFolder && <div className="destination-selection-banner"><span>Choose a destination folder</span><button onClick={() => setSelectingDownloadFolder(false)} type="button">Cancel</button></div>}
              <div className="builder-row">
                <button aria-expanded={builderExpanded} className="tree-item builder-item" onClick={toggleBuilder} type="button">
                  <span className="tree-chevron">{builderExpanded ? '⌄' : '›'}</span>
                  <FolderIcon />
                  <span>Builder</span>
                </button>
                <button aria-label="Builder settings" className="builder-settings" onClick={openBuilderDialog} type="button">⚙</button>
              </div>
              {builderExpanded && (
                <div className="tree-children">
                  {builderTree.map((node) => (
                    <TreeNode key={`Builder/${node.name}`} node={node} nodeKey={`Builder/${node.name}`} expandedNodes={expandedNodes} onToggle={toggleTreeNode} strategies={strategyCatalog} onSelectStrategy={applyStrategy} onOpenItemSettings={openItemSettings} selectingStrategies={selectingStrategies} compileSelection={compileSelection} onToggleCompileSelection={toggleCompileSelection} isCodeWorkspace={isBuilder} onOpenWorkspaceFile={requestOpenWorkspaceFile} />
                  ))}
                </div>
              )}
              <div className="tree-node">
                <div className="tree-node-row">
                  <button aria-expanded={Boolean(expandedNodes.data)} className="tree-item directory-item root-data-item" onClick={() => toggleTreeNode('data')} type="button">
                    <span className="tree-chevron">{expandedNodes.data ? '⌄' : '›'}</span>
                    <FolderIcon />
                  <span>data</span>
                  </button>
                  {selectingDownloadFolder && <button className="destination-select-button" onClick={() => selectDownloadFolder('./data')} type="button">Select</button>}
                  <button aria-label="Settings for data" className="item-settings" onClick={() => openItemSettings({ scope: 'data', path: '', name: 'data', type: 'directory', isRoot: true })} title="Settings for data" type="button">⚙</button>
                </div>
                {expandedNodes.data && (
                  <div className="tree-children">
                    {dataTree.length ? dataTree.map((node) => (
                      <TreeNode key={`data/${node.name}`} node={node} nodeKey={`data/${node.name}`} expandedNodes={expandedNodes} onToggle={toggleTreeNode} strategies={strategyCatalog} onSelectStrategy={applyStrategy} onSelectData={addDataFile} onOpenItemSettings={openItemSettings} selectingDownloadFolder={selectingDownloadFolder} onSelectDownloadFolder={selectDownloadFolder} isCodeWorkspace={isBuilder} onOpenWorkspaceFile={requestOpenWorkspaceFile} />
                    )) : <div className="empty-data-folder">Empty folder</div>}
                  </div>
                )}
              </div>
            </nav>
          )}
          {sidebarExpanded && (
            <div
              aria-label={`Resize project explorer, current width ${sidebarWidth}px`}
              aria-orientation="vertical"
              aria-valuemax={SIDEBAR_MAX_WIDTH}
              aria-valuemin={SIDEBAR_MIN_WIDTH}
              aria-valuenow={sidebarWidth}
              className="sidebar-resize-handle"
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') { event.preventDefault(); setSidebarWidth((width) => Math.max(SIDEBAR_MIN_WIDTH, width - 16)) }
                if (event.key === 'ArrowRight') { event.preventDefault(); setSidebarWidth((width) => Math.min(SIDEBAR_MAX_WIDTH, width + 16)) }
              }}
              onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); resizePointerId.current = event.pointerId; setIsSidebarResizing(true) }}
              onPointerMove={resizeSidebar}
              onPointerUp={(event) => { resizePointerId.current = null; setIsSidebarResizing(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
              onPointerCancel={() => { resizePointerId.current = null; setIsSidebarResizing(false) }}
              role="separator"
              tabIndex={0}
            />
          )}
          {sidebarExpanded && selectingStrategies && (
            <div className="compile-tree-footer">
              {compileMessage && <p className="compile-tree-message">{compileMessage}</p>}
              {compileError && <p className="compile-tree-error">{compileError}</p>}
              <div className="compile-tree-actions">
                <button className="secondary-button" disabled={isCompiling} onClick={cancelCompileSelection} type="button">Cancel</button>
                <button className="primary-button" disabled={isCompiling || !Object.values(compileSelection).some(Boolean)} onClick={() => compileStrategies('selected')} type="button">{isCompiling ? 'Compiling…' : 'Compile'}</button>
              </div>
            </div>
          )}
        </aside>
      )}

      <main className={`main-content ${hasProjectSidebar ? (sidebarExpanded ? 'sidebar-is-open' : 'sidebar-is-collapsed') : ''} ${isSidebarResizing ? 'is-sidebar-resizing' : ''} ${activePage === 'more' ? 'is-more-page' : ''}`}>
        {selectingStrategies ? (
          <section className="compile-selection-view">
            <div className="eyebrow">BUILDER · COMPILATION</div>
            <h1>Select strategies</h1>
            <p className="page-description">Choose strategies in the project explorer. The selected strategies will be compiled together.</p>
            <div className="compile-selected-list">
              <div className="config-section-heading"><h2>Selected to compile</h2><span>{selectedStrategies.length} selected</span></div>
              {selectedStrategies.length ? selectedStrategies.map((strategy) => (
                <div className="compile-selected-item" key={strategy.id}>
                  <ScriptIcon />
                  <strong>{strategy.name}</strong>
                  <span>{strategy.file}</span>
                  <code>{strategy.id}</code>
                </div>
              )) : <p className="compile-selection-empty">No strategies selected yet. Check one or more strategies in the left sidebar.</p>}
            </div>
          </section>
        ) : isHome ? (
          <section className="home-view">
            <div className="eyebrow">LOCAL WORKSPACE</div>
            <h1 className="home-welcome-title">Welcome to Quan<span aria-hidden="true" className="wordmark-grail"><img alt="" src="/favicon.png" /></span>ogral</h1>
            <p className="page-description">Your local quantitative research workspace.</p>
            <div className="workspace-tiles">
              <button className="workspace-tile" onClick={() => navigateToPage('backtesting')} type="button">
                <span className="tile-icon" aria-hidden="true">⌁</span>
                <span className="tile-copy"><strong>Backtesting</strong><span>Backtesting workspace</span></span>
                <span className="tile-arrow" aria-hidden="true">→</span>
              </button>
              <button className="workspace-tile" onClick={() => { setBuilderExpanded(true); navigateToPage('builder') }} type="button">
                <span className="tile-icon" aria-hidden="true">▱</span>
                <span className="tile-copy"><strong>Code Workspace</strong><span>Strategy and indicator tools · In progress</span></span>
                <span className="tile-arrow" aria-hidden="true">→</span>
              </button>
              <button className="workspace-tile" onClick={() => navigateToPage('data-download')} type="button">
                <span className="tile-icon" aria-hidden="true">⇩</span>
                <span className="tile-copy"><strong>Data Download</strong><span>Download market data into your local workspace</span></span>
                <span className="tile-arrow" aria-hidden="true">→</span>
              </button>
            </div>
          </section>
        ) : isDataDownload ? (
          <section className="home-view">
            <button aria-label="Back to Home" className="back-link" onClick={() => navigateToPage('home')} title="Back to Home" type="button"><span aria-hidden="true">←</span></button>
            <div className="eyebrow">DATA</div>
            <h1>Data Download</h1>
            <p className="page-description">Choose a provider for market data. Downloaded files will be kept in the local <code>data/</code> folder.</p>
            <div className="provider-tiles">
              <button className="workspace-tile provider-tile" onClick={() => navigateToPage('data-download-yahoo-finance')} type="button">
                <span className="tile-icon provider-icon" aria-hidden="true">YF</span>
                <strong>Yahoo Finance</strong>
                <span>Market data · In progress</span>
                <span className="tile-arrow" aria-hidden="true">→</span>
              </button>
            </div>
          </section>
        ) : isYahooFinance ? (
          <section className="yahoo-download-view">
            <button aria-label="Back to Data Download" className="back-link" onClick={() => navigateToPage('data-download')} title="Back to Data Download" type="button"><span aria-hidden="true">←</span></button>
            <div className="eyebrow">DATA · PROVIDER</div>
            <h1>Yahoo Finance</h1>
            <p className="page-description">Download historical data for one or more Yahoo Finance instruments, one file per symbol.</p>

            <section className="config-section yahoo-download-panel">
              <div className="config-section-heading"><h2>Download settings</h2><span>OHLCV · one symbol per file</span></div>
              <form className="yahoo-download-form" onSubmit={submitYahooDownload}>
                {yahooDownloadError && <p className="form-error yahoo-download-error" role="alert">{yahooDownloadError}</p>}
                <div className="symbol-field config-field">
                  <label htmlFor="yahoo-symbol">Instrument</label>
                  <input autoComplete="off" id="yahoo-symbol" onChange={(event) => { setYahooTicker(event.target.value); setYahooDownloadError(''); setYahooDownloadResult(null) }} placeholder="Search by company, instrument, or ticker (e.g. Apple or AAPL)" type="text" value={yahooTicker} />
                  <span className="field-help">Search Yahoo Finance’s listings, then choose an exact symbol below. Supports stocks, ETFs, indices, currencies, and crypto.</span>
                  {selectedYahooInstruments.length > 0 && <div className="selected-yahoo-instruments"><span>Selected instruments · {selectedYahooInstruments.length}</span>{selectedYahooInstruments.map((instrument) => <div className="selected-yahoo-instrument" key={instrument.symbol}><strong>{instrument.symbol}</strong><span>{instrument.name}</span><button aria-label={`Remove ${instrument.symbol}`} onClick={() => setSelectedYahooInstruments((items) => items.filter((item) => item.symbol !== instrument.symbol))} type="button">Remove</button></div>)}</div>}
                  <div className="symbol-results-panel">
                    <div className="symbol-results-heading">{isSearchingYahoo ? 'Searching Yahoo Finance…' : yahooTicker.trim().length < 2 ? 'Instrument list' : `Search results${yahooSymbolResults.length ? ` · ${yahooSymbolResults.length}` : ''}`}</div>
                    {yahooSearchError && <span className="symbol-search-error">{yahooSearchError} You can still enter a ticker directly.</span>}
                    {yahooTicker.trim().length < 2 && <span className="symbol-results-empty">Type at least 2 characters to list matching Yahoo Finance instruments.</span>}
                    {yahooTicker.trim().length > 0 && <button className="add-manual-symbol" onClick={() => { const symbol = yahooTicker.trim().toUpperCase(); if (symbol && !selectedYahooInstruments.some((item) => item.symbol === symbol)) setSelectedYahooInstruments((items) => [...items, { symbol, name: 'Manually entered ticker' }]); setYahooTicker(''); setYahooSymbolResults([]); setYahooSearchError('') }} type="button">Add “{yahooTicker.trim().toUpperCase()}” as a ticker</button>}
                    {!isSearchingYahoo && yahooTicker.trim().length >= 2 && !yahooSearchError && yahooSymbolResults.length === 0 && <span className="symbol-results-empty">No matching instruments found. You can still use this exact ticker if you know it.</span>}
                    {!isSearchingYahoo && yahooSymbolResults.length > 0 && <div className="symbol-suggestions" role="listbox" aria-label="Yahoo Finance instrument search results">
                      {yahooSymbolResults.filter((result) => !selectedYahooInstruments.some((item) => item.symbol === result.symbol)).map((result) => <button aria-label={`Add ${result.symbol}, ${result.name}`} key={`${result.symbol}-${result.exchange}`} onClick={() => { setSelectedYahooInstruments((items) => [...items, { symbol: result.symbol, name: result.name }]); setYahooTicker(''); setYahooSymbolResults([]); setYahooSearchError('') }} role="option" type="button"><strong>＋ {result.symbol}</strong><span>{result.name}</span><small>{[result.type, result.exchange].filter(Boolean).join(' · ')}</small></button>)}
                    </div>}
                  </div>
                </div>

                <div className="config-grid">
                  <label className="config-field"><span>Time interval</span><select onChange={(event) => setYahooInterval(event.target.value)} value={yahooInterval}>
                    <option value="1m">1 minute</option><option value="2m">2 minutes</option><option value="5m">5 minutes</option><option value="15m">15 minutes</option><option value="30m">30 minutes</option><option value="60m">60 minutes</option><option value="90m">90 minutes</option><option value="1h">1 hour</option><option value="1d">Daily</option><option value="5d">5 days</option><option value="1wk">Weekly</option><option value="1mo">Monthly</option><option value="3mo">Quarterly</option>
                  </select></label>
                  <label className="config-field"><span>File format</span><select onChange={(event) => setYahooFormat(event.target.value)} value={yahooFormat}><option value="parquet">Parquet (.parquet) — default</option><option value="csv">CSV (.csv)</option></select></label>
                  <label className="config-field"><span>Start date</span><input max={yahooToday} onChange={(event) => { setYahooStartDate(event.target.value); setYahooDownloadError(''); setYahooDownloadResult(null) }} type="date" value={yahooStartDate} /></label>
                  <label className="config-field"><span>End date (inclusive)</span><input max={yahooToday} onChange={(event) => { setYahooEndDate(event.target.value); setYahooDownloadError(''); setYahooDownloadResult(null) }} type="date" value={yahooEndDate} /></label>
                </div>

                <div className="config-field destination-field"><label htmlFor="yahoo-destination">Destination folder</label><div className="destination-input-row"><input id="yahoo-destination" onChange={(event) => { setDownloadDestination(event.target.value); setYahooDownloadError(''); setYahooDownloadResult(null) }} placeholder="./data or /path/to/folder" spellCheck="false" type="text" value={downloadDestination} /><button className="secondary-button" onClick={beginSelectDownloadFolder} type="button">Choose in sidebar</button></div>{selectingDownloadFolder && <small className="destination-selection-hint">Select a folder from the <code>data/</code> tree on the left, or cancel to type a path.</small>}<small>Type an existing folder path or choose a folder in the left-side <code>data/</code> tree.</small></div>
                <label className="config-field filename-template-field"><span>Filename pattern</span><input onChange={(event) => setYahooFilenameTemplate(event.target.value)} spellCheck="false" type="text" value={yahooFilenameTemplate} /><small>Standard pattern: <code>{'{name}_{ts}_{startdate}_{enddate}_{tz}_{provider}.{extension}'}</code>. Edit the pattern freely. Fields: name/symbol, ts (selected interval), startdate, enddate, tz (detected exchange timezone), provider, extension.</small></label>
                <div className="yahoo-output-preview"><span>Example filename · first selected symbol</span><code>{yahooFilenamePreview}</code><small>Timezone is detected from Yahoo’s returned data. Each selected instrument gets its own file.</small></div>
                {(yahooInterval.endsWith('m') || yahooInterval === '1h' || yahooInterval === '60m') && <p className="field-help interval-warning">Yahoo limits intraday history. 1-minute data is limited to about 8 days; other minute intervals to about 60 days; hourly data to about 2 years.</p>}
                {yahooDownloadResult?.results?.length > 0 && <div className="yahoo-download-success" role="status"><strong>Downloaded {yahooDownloadResult.results.length} instrument{yahooDownloadResult.results.length === 1 ? '' : 's'}</strong>{yahooDownloadResult.results.map((result) => <span key={result.path}>{result.ticker}: {result.rows.toLocaleString()} rows saved to <code>{result.path}</code></span>)}</div>}
                {yahooDownloadResult?.errors?.length > 0 && <div className="form-error yahoo-download-error">{yahooDownloadResult.errors.map((error) => <p key={`${error.ticker}-${error.error}`}>{error.ticker}: {error.error}</p>)}</div>}
                <div className="yahoo-download-actions"><button className="primary-button" disabled={isYahooDownloading} type="submit">{isYahooDownloading ? 'Downloading…' : selectedYahooInstruments.length ? `Download ${selectedYahooInstruments.length} data file${selectedYahooInstruments.length === 1 ? '' : 's'}` : 'Check download settings'}</button>{isYahooDownloading && <span>Contacting Yahoo Finance. This may take a moment.</span>}</div>
                {yahooDownloadProgress && <div className="yahoo-download-progress" role="status" aria-live="polite"><div className="yahoo-download-progress-heading"><strong>{isYahooDownloading ? yahooDownloadProgress.status : yahooDownloadProgress.status}</strong><span>{yahooDownloadProgress.completed} / {yahooDownloadProgress.total}</span></div><progress max={yahooDownloadProgress.total || 1} value={yahooDownloadProgress.completed} /><small>Progress advances as each instrument file finishes. {yahooDownloadProgress.currentTicker ? `Currently processing ${yahooDownloadProgress.currentTicker}.` : ''}</small></div>}
                <p className="yahoo-provider-notice">Yahoo Finance access uses yfinance, an unofficial third-party interface. Yahoo data access is intended for personal use; review the provider’s terms before using or redistributing downloaded data.</p>
              </form>
            </section>
          </section>
        ) : isBacktesting ? (
          <section className="home-view">
            <button aria-label="Back to Home" className="back-link" onClick={() => navigateToPage('home')} title="Back to Home" type="button"><span aria-hidden="true">←</span></button>
            <div className="eyebrow">RESEARCH</div>
            <h1>Backtesting</h1>
            <p className="page-description">Choose a backtesting method.</p>
            <div className="workspace-tiles">
              <button className="workspace-tile" onClick={() => navigateToPage('simplebacktesting')} type="button">
                <span className="tile-icon" aria-hidden="true">▤</span>
                <span className="tile-copy"><strong>Simple Backtesting</strong><span>Strategy and data workspace · In progress</span></span>
                <span className="tile-arrow" aria-hidden="true">→</span>
              </button>
              <button className="workspace-tile" onClick={() => navigateToPage('gridsearch')} type="button">
                <span className="tile-icon" aria-hidden="true">▦</span>
                <span className="tile-copy"><strong>GridSearch</strong><span>Parameter search · In progress</span></span>
                <span className="tile-arrow" aria-hidden="true">→</span>
              </button>
            </div>
          </section>
        ) : isSimpleBacktesting ? (
          <section className="simple-backtest-view">
            <button aria-label="Back to Backtesting" className="back-link" onClick={() => navigateToPage('backtesting')} title="Back to Backtesting" type="button"><span aria-hidden="true">←</span></button>
            <div className="eyebrow">BACKTESTING</div>
            <div className="simple-backtest-title-row">
              <h1>Simple Backtesting</h1>
              <button aria-label="Backtest settings" className="backtest-settings-button" onClick={openSimpleBacktestSettings} title="Backtest settings" type="button"><span aria-hidden="true">⚙</span></button>
            </div>
            <BacktestSettingsPanel draft={simpleBacktestSettingsDraft} error={simpleBacktestSettingsError} onCancel={() => { setSimpleBacktestSettingsDraft(simpleBacktestConfig); setSimpleBacktestSettingsError(''); setSimpleBacktestSettingsOpen(false) }} onChange={updateSimpleBacktestSettingsDraft} onSave={saveSimpleBacktestSettings} onToggle={openSimpleBacktestSettings} open={simpleBacktestSettingsOpen} />
              <p className="page-description">Add strategies and market-data files from the project explorer, then configure each strategy.</p>

            <form className="simple-backtest-form" onSubmit={runSimpleBacktest}>
              <div className="backtest-buckets-toolbar">
                <div><h2>Buckets</h2><p>Buckets group feeds for strategies that need different data. All buckets share the same backtest account and process events in timestamp order.</p></div>
                <div className="backtest-buckets-toolbar-actions">
                  <button className="secondary-button" disabled={isRunningBacktest} onClick={resetBacktestWorkspace} type="button">Reset backtest</button>
                  <button className="secondary-button" onClick={addBacktestBucket} type="button">+ Add bucket</button>
                </div>
              </div>
              {backtestBuckets.map((bucket) => <div className="backtest-bucket-wrap" key={bucket.id}>
                {backtestBuckets.length > 1 && <button aria-label={`Remove ${bucket.name}`} className="bucket-remove-button" onClick={() => removeBacktestBucket(bucket.id)} type="button">Remove bucket</button>}
                <BacktestBucketPanel
                  bucket={bucket}
                  strategies={backtestStrategies.filter((strategy) => strategy.bucketId === bucket.id)}
                  dataFiles={dataFiles.filter((feed) => feed.bucketId === bucket.id)}
                  fxFiles={fxFiles.filter((feed) => feed.bucketId === bucket.id)}
                  baseCurrency={simpleBacktestConfig.base_currency || 'USD'}
                  ignoreCurrency={simpleBacktestConfig.ignore_currency}
                  fxDropHover={fxDropHoverBucket === bucket.id}
                  onFxDragEnter={(bucketId, event) => { event.preventDefault(); setFxDropHoverBucket(bucketId) }}
                  onFxDragLeave={(bucketId, event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFxDropHoverBucket((current) => current === bucketId ? null : current) }}
                  onFxDrop={handleFxDrop}
                  onRemoveFxFile={(instanceId) => { setFxFiles((items) => items.filter((feed) => feed.instanceId !== instanceId)); setBacktestResult(null) }}
                  onUpdateFxFeed={updateFxFeed}
                  onUpdateFxPair={updateFxPair}
                  strategyCatalog={strategyCatalog}
                  strategyPresets={strategyPresets}
                  presetMenuInstanceId={presetMenuInstanceId}
                  onTogglePresetMenu={(instanceId) => setPresetMenuInstanceId((current) => current === instanceId ? null : instanceId)}
                  onSelectPreset={selectStrategyPreset}
                  expandedStrategies={expandedBacktestStrategies}
                  selectedForSidebar={activeBucketId === bucket.id}
                  strategyDropHover={strategyDropHoverBucket === bucket.id}
                  dataDropHover={dataDropHoverBucket === bucket.id}
                  manualDataPath={manualDataPath}
                  onSelectBucket={setActiveBucketId}
                  onAddStrategy={applyStrategy}
                  onStrategyDragEnter={(bucketId, event) => { event.preventDefault(); setStrategyDropHoverBucket(bucketId) }}
                  onStrategyDragLeave={(bucketId, event) => { if (!event.currentTarget.contains(event.relatedTarget)) setStrategyDropHoverBucket((current) => current === bucketId ? null : current) }}
                  onStrategyDrop={(bucketId, event) => { setStrategyDropHoverBucket(null); handleStrategyDrop(bucketId, event) }}
                  onDataDragEnter={(bucketId, event) => { event.preventDefault(); setDataDropHoverBucket(bucketId) }}
                  onDataDragLeave={(bucketId, event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDataDropHoverBucket((current) => current === bucketId ? null : current) }}
                  onDataDrop={(bucketId, event) => { setDataDropHoverBucket(null); handleDataDrop(bucketId, event) }}
                  onToggleStrategy={(instanceId) => setExpandedBacktestStrategies((items) => ({ ...items, [instanceId]: !items[instanceId] }))}
                  onRemoveStrategy={(instanceId) => { setBacktestStrategies((items) => items.filter((item) => item.instanceId !== instanceId)); setBacktestResult(null) }}
                  onToggleFeed={toggleStrategyFeed}
                  onUpdateStrategy={updateBacktestStrategy}
                  onRemoveFeed={removeDataFile}
                  onUpdateFeed={updateFeed}
                  onManualPathChange={setManualDataPath}
                  onManualPathKeyDown={(bucketId, event) => { if (event.key === 'Enter') { event.preventDefault(); addManualDataFile(bucketId) } }}
                  onAddManualPath={addManualDataFile}
                />
              </div>)}
              <button className="secondary-button add-bucket-after-list" disabled={isRunningBacktest} onClick={addBacktestBucket} type="button">+ Add bucket</button>

              {!compilation.current && (
                <div className="engine-notice">
                  <span>{compilation.message || 'Compile strategies before running a backtest.'}</span>
                  <button className="secondary-button" onClick={() => { openBuilderDialog(); openCompilationView() }} type="button">Manage compilation</button>
                </div>
              )}
              {backtestError && <p className="form-error">{backtestError}</p>}
              <button className="primary-button run-backtest-button" disabled={!compilation.current || backtestStrategies.length === 0 || dataFiles.length === 0 || backtestStrategies.some((strategy) => strategy.feedIds.length === 0) || isRunningBacktest} type="submit">
                {isRunningBacktest ? (simpleBacktestConfig.run_mode === 'COMPARE_ALL' ? 'Running 3 independent scenarios…' : 'Running bucketed C++ backtest…') : 'Run backtest'}
              </button>
              {backtestElapsedMs !== null && <span aria-live="polite" className="backtest-elapsed-time">{isRunningBacktest ? 'Elapsed' : 'Run time'}: {backtestElapsedMs < 1000 ? `${Math.round(backtestElapsedMs)} ms` : `${(backtestElapsedMs / 1000).toFixed(2)} s`}</span>}
            </form>

            {backtestResult && (
              <section className="backtest-results">
                <div className="config-section-heading"><h2>Run results</h2><span>{activeBacktestReport.buckets.length} buckets · {backtestResult.inputRows.toLocaleString()} feed rows per scenario</span></div>
                {compareBacktestReports && <div className="backtest-scenario-tabs" aria-label="Choose scenario bucket details">
                  <span>Bucket details:</span>
                  {resultScenarios.map((scenario) => <button aria-pressed={activeBacktestReport.scenarioId === scenario.scenarioId} className={activeBacktestReport.scenarioId === scenario.scenarioId ? 'is-active' : ''} key={scenario.scenarioId} onClick={() => setActiveBacktestScenarioId(scenario.scenarioId)} type="button">{scenario.scenarioLabel}</button>)}
                </div>}
                <div className="bucket-result-list">
                  {activeBacktestReport.buckets.map((bucket) => <article className="bucket-result-card" key={bucket.id}>
                    <div className="config-section-heading"><h3>{backtestBuckets.find((item) => item.id === bucket.id)?.name || bucket.id}</h3><span>{bucket.strategies.length} strategies · {bucket.feeds.length} feeds</span></div>
                    <div className="bucket-result-details">
                      <span>Orders <strong>{bucket.metrics.orders.toLocaleString()}</strong></span>
                      {activeBacktestReport.bucketCapitalMode === 'INDEPENDENT' ? <>
                        <span>Equity <strong>{reportMoney(bucket.metrics.finalEquity, activeBacktestReport.metrics.currency || 'USD')}</strong></span>
                        <span>Profit <strong>{reportNumber(bucket.metrics.profitPct, '%')}</strong></span>
                        <span>Maximum DD <strong>{reportNumber(bucket.metrics.maxDrawdownPct, '%')}</strong></span>
                        <span>Sharpe <strong>{reportNumber(bucket.metrics.sharpe, '', 4)}</strong></span>
                      </> : <>
                        <span>Profit contribution <strong>{reportNumber(bucket.metrics.profitContributionPct, '%')}</strong></span>
                        <span>Sharpe contribution <strong>{reportNumber(bucket.metrics.contributionSharpe, '', 4)}</strong></span>
                      </>}
                      <span>Trades / year <strong>{reportNumber(bucket.metrics.tradesPerYear)}</strong></span>
                    </div>
                    <p className="bucket-contribution-note">{activeBacktestReport.bucketCapitalMode === 'INDEPENDENT' ? 'Independent account funded with an equal share of total starting capital.' : 'Contribution to the shared portfolio; profit % uses total starting capital.'}</p>
                    <div className="bucket-result-strategies">{bucket.strategies.map((strategy) => <span key={strategy.instanceId}>{strategy.name} <code>{strategy.instanceId}</code> · {strategy.orders.length} orders</span>)}</div>
                  </article>)}
                </div>
                <BacktestReport benchmarkFiles={benchmarkFiles} compare={compareBacktestReports} scenarios={resultScenarios} />
              </section>
            )}
          </section>
        ) : isGridSearch ? (
          <section className="home-view placeholder-view">
            <button aria-label="Back to Backtesting" className="back-link" onClick={() => navigateToPage('backtesting')} title="Back to Backtesting" type="button"><span aria-hidden="true">←</span></button>
            <div className="eyebrow">BACKTESTING</div>
            <div className="simple-backtest-title-row"><h1>GridSearch</h1><button aria-label="GridSearch settings" className="backtest-settings-button" onClick={openGridSearchSettings} title="GridSearch settings" type="button"><span aria-hidden="true">⚙</span></button></div>
            <GridSearchSettingsPanel onToggle={openGridSearchSettings} open={gridSearchSettingsOpen} settings={gridSearchConfig} />
            <span className="progress-badge">IN PROGRESS</span>
          </section>
        ) : isBuilder ? (
          fileEditor ? (
            <section className="file-editor-view">
              <div className="file-editor-toolbar">
                <button className="back-link" onClick={() => requestEditorAction({ type: 'close' })} title="Close file" type="button"><span aria-hidden="true">←</span> Code Workspace</button>
                <span className="file-editor-status">{fileEditor.loading ? 'Opening…' : fileEditor.content !== fileEditor.savedContent ? 'Unsaved changes' : 'Saved'} <span className="editor-shortcut-hint">· Ctrl/⌘ S to save</span></span>
              </div>
              <div className="eyebrow">{fileEditor.scope === 'data' ? 'DATA FILE' : 'SOURCE FILE'}</div>
              <h1>{fileEditor.name}</h1>
              <p className="file-editor-path"><code>{fileEditor.scope === 'data' ? `./data/${fileEditor.path}` : `${builderPath.replace(/\/$/, '')}/${fileEditor.path}`}</code></p>
              {fileEditor.format === 'parquet-json' && <p className="file-editor-help">Editing Parquet rows as JSON. Keep the original columns and value types; up to 5,000 rows are supported.</p>}
              {fileEditor.error && <p className="form-error">{fileEditor.error}</p>}
              {editorError && <p className="form-error">{editorError}</p>}
              {fileEditor.scope === 'data' && fileEditor.name.toLowerCase().endsWith('.csv') && <div aria-label="CSV display mode" className="csv-view-toggle"><button aria-pressed={fileEditor.csvTableView} className={fileEditor.csvTableView ? 'is-active' : ''} onClick={() => setFileEditor((current) => ({ ...current, csvTableView: true }))} type="button">Table view</button><button aria-pressed={!fileEditor.csvTableView} className={!fileEditor.csvTableView ? 'is-active' : ''} onClick={() => setFileEditor((current) => ({ ...current, csvTableView: false }))} type="button">Text editor</button></div>}
              {fileEditor.csvTableView ? (
                <div className="csv-table-frame">
                  <div aria-label="CSV table preview" className="csv-table-viewport" role="region" tabIndex="0">
                    <table className="csv-data-table">
                      <thead><tr><th className="csv-row-number">#</th>{csvPreviewRows.header.map((column, index) => <th key={index}>{column || `Column ${index + 1}`}</th>)}</tr></thead>
                      <tbody>
                        {csvPreviewRows.rows.slice(0, csvPreviewRows.omittedRowCount ? 100 : undefined).map((row) => <tr key={row.lineNumber}><td className="csv-row-number">{row.lineNumber}</td>{Array.from({ length: Math.max(csvPreviewRows.header.length, row.values.length) }, (_, columnIndex) => <td key={columnIndex}>{row.values[columnIndex] ?? ''}</td>)}</tr>)}
                        {csvPreviewRows.omittedRowCount > 0 && <tr className="csv-omitted-rows"><td colSpan={csvPreviewRows.header.length + 1}>… {csvPreviewRows.omittedRowCount.toLocaleString()} rows omitted …</td></tr>}
                        {csvPreviewRows.omittedRowCount > 0 && csvPreviewRows.rows.slice(100).map((row) => <tr key={row.lineNumber}><td className="csv-row-number">{row.lineNumber}</td>{Array.from({ length: Math.max(csvPreviewRows.header.length, row.values.length) }, (_, columnIndex) => <td key={columnIndex}>{row.values[columnIndex] ?? ''}</td>)}</tr>)}
                      </tbody>
                    </table>
                  </div>
                  <div className="csv-preview-note">{csvPreviewRows.omittedRowCount > 0 ? `Showing first 100 and last 100 of ${csvPreviewRows.dataRowCount.toLocaleString()} data rows.` : `Showing all ${csvPreviewRows.dataRowCount.toLocaleString()} data rows.`} Switch to Text editor to edit the full file.</div>
                </div>
              ) : (
                <div className={`workspace-editor-shell ${fileEditor.scope === 'data' ? 'is-data-editor' : 'is-code-editor'}`}>
                  <div aria-hidden="true" className="workspace-editor-gutter" ref={editorGutterRef}>{Array.from({ length: Math.max(1, fileEditor.content.split('\n').length) }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
                  <textarea aria-label={`Edit ${fileEditor.name}`} className="workspace-file-editor" disabled={fileEditor.loading || editorSaving || Boolean(fileEditor.error)} onChange={(event) => { setFileEditor((current) => ({ ...current, content: event.target.value })); setEditorError('') }} onScroll={(event) => { if (editorGutterRef.current) editorGutterRef.current.scrollTop = event.currentTarget.scrollTop }} spellCheck={false} value={fileEditor.content} wrap="off" />
                </div>
              )}
              <div className="file-editor-actions"><span>{fileEditor.format === 'parquet-json' ? 'Parquet · editable JSON table' : 'Text · UTF-8'}</span><button className="secondary-button" onClick={() => requestEditorAction({ type: 'close' })} type="button">Close file</button><button className="primary-button" disabled={fileEditor.loading || editorSaving || Boolean(fileEditor.error) || fileEditor.content === fileEditor.savedContent} onClick={saveCurrentWorkspaceFile} type="button">{editorSaving ? 'Saving…' : 'Save'}</button></div>
            </section>
          ) : (
            <section className="home-view placeholder-view">
              <button aria-label="Back to Home" className="back-link" onClick={() => navigateToPage('home')} title="Back to Home" type="button"><span aria-hidden="true">←</span></button>
              <div className="eyebrow">WORKSPACE</div>
              <h1>Code Workspace</h1>
              <p className="page-description">Open a source file or market-data file from the project explorer to inspect and edit it.</p>
              <div className="workspace-tiles">
                <div className="workspace-tile viewer-tile">
                  <span className="tile-icon" aria-hidden="true">◫</span>
                  <span className="tile-copy"><strong>Viewer</strong><span>In progress</span></span>
                  <span className="progress-badge">IN PROGRESS</span>
                </div>
              </div>
            </section>
          )
        ) : isSettings ? (
          <section className="settings-view">
            <button aria-label="Back to More" className="back-link" onClick={() => navigateToPage('more')} title="Back to More" type="button"><span aria-hidden="true">←</span></button>
            <div className="eyebrow">PREFERENCES</div>
            <h1>Settings</h1>
            <div className="settings-layout">
              <nav aria-label="Settings sections" className="settings-nav">
                <button aria-current={settingsSection === 'general' ? 'page' : undefined} className={settingsSection === 'general' ? 'is-active' : ''} onClick={() => setSettingsSection('general')} type="button">General</button>
              </nav>
              <div className="settings-content">
                {settingsSection === 'general' && (
                  <section className="config-section settings-general-section">
                    <div className="config-section-heading"><h2>General</h2></div>
                    <div className="settings-preference-row">
                      <div className="settings-preference-copy"><strong>Appearance</strong><span>Choose a light or dark color scheme.</span></div>
                      <div aria-label="Site appearance" className="theme-options" role="group">
                        <button aria-pressed={siteTheme === 'light'} className={siteTheme === 'light' ? 'is-selected' : ''} onClick={() => setSiteTheme('light')} type="button">Light</button>
                        <button aria-pressed={siteTheme === 'dark'} className={siteTheme === 'dark' ? 'is-selected' : ''} onClick={() => setSiteTheme('dark')} type="button">Dark</button>
                      </div>
                    </div>
                  </section>
                )}
              </div>
            </div>
          </section>
        ) : (
          <section className="more-view">
            <div className="eyebrow">WORKSPACE</div>
            <h1>More</h1>
            <div className="more-options">
              <button className="more-option more-option-button" onClick={() => { setSettingsSection('general'); navigateToPage('settings') }} type="button"><span>Settings</span><span aria-hidden="true">›</span></button>
              <div className="more-option">
                <span>Profile</span><span className="progress-badge">IN PROGRESS</span>
              </div>
            </div>
            <footer className="more-attribution">
              <span>© {new Date().getFullYear()} Jacopo Michelacci · Quantogral</span>
              <a href="https://www.linkedin.com/in/jmichelacci/" rel="noreferrer" target="_blank">Created by Jacopo Michelacci <span aria-hidden="true">↗</span></a>
            </footer>
          </section>
        )}
      </main>

      {builderDialogOpen && (
        <div className="dialog-backdrop" onMouseDown={() => setBuilderDialogOpen(false)}>
          <section aria-labelledby="builder-dialog-title" aria-modal="true" className="path-dialog builder-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <button aria-label="Close builder settings" className="dialog-close-button" onClick={() => setBuilderDialogOpen(false)} type="button">×</button>
            <div className="eyebrow">BUILDER SETTINGS</div>
            <h2 id="builder-dialog-title">{builderDialogView === 'menu' ? 'Builder' : builderDialogView === 'path' ? 'Builder folder' : 'Manage compilation'}</h2>

            {builderDialogView === 'menu' ? (
              <div className="builder-dialog-options">
                <button className="builder-dialog-option" onClick={() => { setBuilderDialogOpen(false); openItemSettings({ scope: 'builder', path: '', name: 'Builder', type: 'directory', isRoot: true }) }} type="button">
                  <span><strong>Create item in Builder</strong><small>Add a folder or file at the Builder root.</small></span><span aria-hidden="true">›</span>
                </button>
                <button className="builder-dialog-option" onClick={() => { setPathDraft(builderPath); setBuilderDialogView('path') }} type="button">
                  <span><strong>Builder path</strong><small>Choose where your strategies and indicators are stored.</small></span><span aria-hidden="true">›</span>
                </button>
                <button className="builder-dialog-option" onClick={openCompilationView} type="button">
                  <span><strong>Manage Compilation</strong><small>Compile supported strategies for local backtests.</small></span><span aria-hidden="true">›</span>
                </button>
              </div>
            ) : builderDialogView === 'path' ? (
              <>
                <p>Choose the folder containing the `strategies/` and `indicators/` directories. Use an absolute path or a path relative to the Quantogral project root.</p>
                <form onSubmit={saveBuilderPath}>
                  <label htmlFor="builder-path">Builder folder</label>
                  <input autoFocus id="builder-path" onChange={(event) => setPathDraft(event.target.value)} placeholder="/full/path/to/your/builder" spellCheck="false" type="text" value={pathDraft} />
                  <p className="input-help">Default: <code>./cpp/include/builder</code></p>
                  {saveError && <p className="form-error">{saveError}</p>}
                  <div className="dialog-actions">
                    <button className="secondary-button" onClick={() => setBuilderDialogView('menu')} type="button">Back</button>
                    <button className="primary-button" type="submit">Save path</button>
                  </div>
                </form>
              </>
            ) : (
              <>
                <p>Compile discovered C++ strategies. Build output stays in the local `.quantogral/build/` folder; source headers are not modified.</p>
                <div className={`compile-status ${compilation.current ? 'is-ready' : ''}`}>
                  <span className="status-dot" />
                  <span>{compilation.current ? 'Engine compiled and up to date' : compilation.compiled ? 'Engine build is out of date' : 'Engine has not been compiled'}</span>
                </div>
                <div className="compile-strategy-list">
                  {compilation.strategies.map((strategy) => (
                    <label className="compile-strategy-option" key={strategy.id}>
                      <input checked={Boolean(compileSelection[strategy.id])} onChange={(event) => setCompileSelection((selection) => ({ ...selection, [strategy.id]: event.target.checked }))} type="checkbox" />
                      <span><strong>{strategy.name}</strong><small>{strategy.file} · {strategy.input}</small></span>
                    </label>
                  ))}
                </div>
                <p className="input-help">Strategies are detected from their C++ class and Config fields. Save a supported strategy header to add it here.</p>
                {compileMessage && <p className="compile-message">{compileMessage}</p>}
                {compileError && <p className="form-error compile-error">{compileError}</p>}
                <div className="dialog-actions compile-actions">
                  <button className="secondary-button" disabled={isCompiling} onClick={() => setBuilderDialogView('menu')} type="button">Back</button>
                  <button className="secondary-button" disabled={isCompiling} onClick={startCompileSelection} type="button">Compile Selected</button>
                  <button className="primary-button" disabled={isCompiling} onClick={() => compileStrategies('all')} type="button">{isCompiling ? 'Compiling…' : 'Compile All'}</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {itemDialog && (
        <div className="dialog-backdrop" onMouseDown={() => setItemDialog(null)}>
          <section aria-labelledby="item-dialog-title" aria-modal="true" className="path-dialog item-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <button aria-label="Close item settings" className="dialog-close-button" onClick={() => setItemDialog(null)} type="button">×</button>
            <div className="eyebrow">{itemDialog.scope === 'data' ? 'DATA' : 'BUILDER'} · ITEM SETTINGS</div>
            <h2 id="item-dialog-title">{itemDialogAction === 'menu' ? itemDialog.name : itemDialogAction === 'create' ? `Create in ${itemDialog.name}` : `Rename ${itemDialog.name}`}</h2>
            {itemDialogAction === 'menu' ? (
              <div className="builder-dialog-options">
                {itemDialog.type === 'directory' && <button className="builder-dialog-option" onClick={beginCreateItem} type="button"><span><strong>Create here</strong><small>Add a folder or file inside {itemDialog.name}.</small></span><span aria-hidden="true">›</span></button>}
                {itemDialog.scope === 'data' && itemDialog.type === 'file' && <button className="builder-dialog-option" onClick={() => openDatasetSettings(itemDialog)} type="button"><span><strong>Dataset settings</strong><small>Set timezone, currency, or FX pair.</small></span><span aria-hidden="true">›</span></button>}
                {itemDialog.strategyId && <button className="builder-dialog-option" onClick={() => { const strategy = strategyCatalog.find((entry) => entry.id === itemDialog.strategyId); setItemDialog(null); openStrategyPresets(strategy) }} type="button"><span><strong>Presets</strong><small>Manage saved configurations for this strategy.</small></span><span aria-hidden="true">›</span></button>}
                {itemDialog.type === 'file' && <button className="builder-dialog-option" onClick={() => openWorkspacePreview(itemDialog)} type="button"><span><strong>View</strong><small>Preview this file in a window.</small></span><span aria-hidden="true">›</span></button>}
                {!itemDialog.isRoot && <button className="builder-dialog-option" onClick={beginRenameItem} type="button"><span><strong>Rename</strong><small>Change this {itemDialog.type} name.</small></span><span aria-hidden="true">›</span></button>}
                {itemDialog.type === 'file' && <button className="builder-dialog-option danger-dialog-option" onClick={() => { setDeleteItemError(''); setDeleteItemPrompt(itemDialog); setItemDialog(null) }} type="button"><span><strong>Remove file</strong><small>Delete this file from the workspace.</small></span><span aria-hidden="true">›</span></button>}
              </div>
            ) : (
              <form onSubmit={submitWorkspaceItem}>
                <p>{itemDialogAction === 'create' ? 'End a folder name with / (for example, research/) or enter a filename with an extension (for example, notes.txt).' : itemDialog.type === 'directory' ? 'Enter the new folder name.' : 'Enter the new filename, including its extension.'}</p>
                <label htmlFor="workspace-item-name">{itemDialogAction === 'create' ? 'Folder or file name' : 'New name'}</label>
                <input autoFocus id="workspace-item-name" onChange={(event) => setItemNameDraft(event.target.value)} placeholder={itemDialogAction === 'create' ? 'foldername/ or filename.ext' : itemDialog.type === 'directory' ? 'new-folder' : 'new-name.ext'} spellCheck="false" type="text" value={itemNameDraft} />
                {itemDialogError && <p className="form-error">{itemDialogError}</p>}
                <div className="dialog-actions">
                  <button className="secondary-button" onClick={() => { setItemDialogAction('menu'); setItemDialogError('') }} type="button">Back</button>
                  <button className="primary-button" disabled={!itemNameDraft.trim()} type="submit">{itemDialogAction === 'create' ? 'Create here' : 'Rename'}</button>
                </div>
              </form>
            )}
            {itemDialogAction === 'menu' && <div className="dialog-actions"><button className="secondary-button" onClick={() => setItemDialog(null)} type="button">Close</button></div>}
          </section>
        </div>
      )}

      <DatasetSettingsDialog draft={datasetSettingsDraft} error={datasetSettingsError} file={datasetSettingsDialog} onChange={updateDatasetSettingsDraft} onClose={() => setDatasetSettingsDialog(null)} onSave={saveDatasetSettings} saving={savingDatasetSettings} />
      {presetManagerStrategy && <PresetManagerDialog initialData={presetManagerData} onClose={() => setPresetManagerStrategy(null)} onPersist={persistStrategyPresets} strategy={presetManagerStrategy} />}

      {deleteItemPrompt && (
        <div className="dialog-backdrop" onMouseDown={() => !isDeletingItem && setDeleteItemPrompt(null)}>
          <section aria-labelledby="delete-item-title" aria-modal="true" className="path-dialog delete-item-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <button aria-label="Close delete confirmation" className="dialog-close-button" disabled={isDeletingItem} onClick={() => setDeleteItemPrompt(null)} type="button">×</button>
            <div className="eyebrow">{deleteItemPrompt.scope === 'data' ? 'DATA' : 'BUILDER'} · DELETE FILE</div>
            <h2 id="delete-item-title">Are you sure you want to delete this file?</h2>
            <p><strong>{deleteItemPrompt.name}</strong> will be permanently removed. This action cannot be undone.</p>
            {deleteItemError && <p className="form-error">{deleteItemError}</p>}
            <div className="dialog-actions">
              <button className="secondary-button" disabled={isDeletingItem} onClick={() => setDeleteItemPrompt(null)} type="button">Cancel</button>
              <button className="danger-button" disabled={isDeletingItem} onClick={confirmDeleteWorkspaceItem} type="button">{isDeletingItem ? 'Deleting…' : 'Delete file'}</button>
            </div>
          </section>
        </div>
      )}

      {workspacePreview && (
        <div className="dialog-backdrop preview-dialog-backdrop" onMouseDown={closeWorkspacePreview}>
          <section aria-labelledby="workspace-preview-title" aria-modal="true" className="path-dialog workspace-preview-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <button aria-label="Close file preview" className="dialog-close-button" onClick={closeWorkspacePreview} type="button">×</button>
            <div className="eyebrow">{workspacePreview.scope === 'data' ? 'DATA FILE' : 'SOURCE FILE'} · VIEW</div>
            <h2 id="workspace-preview-title">{workspacePreview.name}</h2>
            <p className="workspace-preview-path"><code>{workspacePreview.scope === 'data' ? `./data/${workspacePreview.path}` : `${builderPath.replace(/\/$/, '')}/${workspacePreview.path}`}</code></p>
            <div className="workspace-preview-content">
              {workspacePreview.loading && <p className="file-preview-loading">Loading preview…</p>}
              {workspacePreview.error && <p className="form-error">{workspacePreview.error}</p>}
              {!workspacePreview.loading && !workspacePreview.error && workspacePreviewCsv && <WorkspaceDataTable columns={workspacePreviewCsv.header} rows={workspacePreviewCsv.rows} rowNumber={(row) => row.lineNumber} omittedRowCount={workspacePreviewCsv.omittedRowCount} totalRows={workspacePreviewCsv.dataRowCount} />}
              {!workspacePreview.loading && !workspacePreview.error && workspacePreview.format === 'parquet-json' && <WorkspaceDataTable columns={workspacePreview.columns || []} rows={parquetPreviewRows} omittedRowCount={workspacePreview.omittedRows || 0} totalRows={workspacePreview.rows || parquetPreviewRows.length} edgeRows={500} />}
              {!workspacePreview.loading && !workspacePreview.error && !workspacePreviewCsv && workspacePreview.format !== 'parquet-json' && (
                <div className="workspace-preview-code-wrap">
                  <div aria-hidden="true" className="workspace-preview-line-numbers">{Array.from({ length: Math.max(1, workspacePreview.content.split('\n').length) }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
                  <pre className="workspace-preview-code">{workspacePreview.content}</pre>
                </div>
              )}
            </div>
            <div className="dialog-actions"><span className="workspace-preview-format">{workspacePreview.format === 'parquet-json' ? `Parquet data · ${Number(workspacePreview.rows || 0).toLocaleString()} rows` : workspacePreviewCsv ? 'CSV data' : 'Text · UTF-8'}</span><button className="secondary-button" onClick={closeWorkspacePreview} type="button">Close</button></div>
          </section>
        </div>
      )}

      {yahooOverwritePrompt && (
        <div className="dialog-backdrop" onMouseDown={backFromYahooOverwrite}>
          <section aria-labelledby="yahoo-overwrite-title" aria-modal="true" className="path-dialog yahoo-overwrite-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <button aria-label="Close overwrite prompt" className="dialog-close-button" disabled={isYahooDownloading} onClick={backFromYahooOverwrite} type="button">×</button>
            <div className="eyebrow">DATA · EXISTING FILE</div>
            <h2 id="yahoo-overwrite-title">Data already stored</h2>
            <p>A file with this name is already in the selected destination:</p>
            <ul className="yahoo-overwrite-files">{yahooOverwritePrompt.conflicts.map((conflict) => <li key={conflict.filename}><strong>{conflict.ticker}</strong><code>{conflict.filename}</code></li>)}</ul>
            <p>Overwrite the listed file and continue the remaining downloads? Choosing Back leaves existing files unchanged and stops the rest of this batch.</p>
            <div className="dialog-actions">
              <button className="secondary-button" disabled={isYahooDownloading} onClick={backFromYahooOverwrite} type="button">Back</button>
              <button className="primary-button" disabled={isYahooDownloading} onClick={overwriteYahooDataFiles} type="button">{isYahooDownloading ? 'Overwriting…' : 'Overwrite files'}</button>
            </div>
          </section>
        </div>
      )}

      {unsavedPromptOpen && (
        <div className="dialog-backdrop" onMouseDown={() => resolveUnsavedPrompt('cancel')}>
          <section aria-labelledby="unsaved-changes-title" aria-modal="true" className="path-dialog unsaved-changes-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <button aria-label="Close unsaved changes prompt" className="dialog-close-button" disabled={editorSaving} onClick={() => resolveUnsavedPrompt('cancel')} type="button">×</button>
            <div className="eyebrow">CODE WORKSPACE · UNSAVED FILE</div>
            <h2 id="unsaved-changes-title">Save your changes?</h2>
            <p>You have unsaved changes in <strong>{fileEditor?.name}</strong>.</p>
            <p>Save them before leaving this file?</p>
            {unsavedPromptError && <p className="form-error">{unsavedPromptError}</p>}
            <div className="dialog-actions">
              <button className="secondary-button" disabled={editorSaving} onClick={() => resolveUnsavedPrompt('cancel')} type="button">Cancel</button>
              <button className="secondary-button discard-changes-button" disabled={editorSaving} onClick={() => resolveUnsavedPrompt('discard')} type="button">Don’t Save</button>
              <button className="primary-button" disabled={editorSaving} onClick={() => resolveUnsavedPrompt('save')} type="button">{editorSaving ? 'Saving…' : 'Save changes'}</button>
            </div>
          </section>
        </div>
      )}

      {compileSuccessNotice && (
        <div aria-live="polite" className={`compile-success-toast ${compileSuccessNotice.fading ? 'is-fading' : ''}`} role="status">
          <span className="status-dot" />{compileSuccessNotice.message}
        </div>
      )}

      <nav aria-label="Main navigation" className="bottom-bar">
        <button aria-label="Backtesting" className={isBacktestingSection ? 'is-active' : ''} onClick={() => navigateToPage('backtesting')} type="button">
          <span aria-hidden="true">⌁</span><span>Backtesting</span>
        </button>
        <button aria-label="Home" className={isHome ? 'is-active' : ''} onClick={() => navigateToPage('home')} type="button">
          <span aria-hidden="true">⌂</span><span>Home</span>
        </button>
        <button aria-label="More" className={activePage === 'more' ? 'is-active' : ''} onClick={() => navigateToPage('more')} type="button">
          <span aria-hidden="true">⋯</span><span>More</span>
        </button>
      </nav>
    </div>
  )
}

export default App
