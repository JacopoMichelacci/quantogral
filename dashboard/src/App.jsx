import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const DEFAULT_BUILDER_PATH = './cpp/include/builder'
const BACKTEST_SETTINGS_KEY = 'quantogral.simpleBacktest.settings'
const EXPLORER_SETTINGS_KEY = 'quantogral.projectExplorer.settings'
const SITE_THEME_KEY = 'quantogral.siteTheme'
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420

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
      capital_allocation: saved.capital_allocation === 'EQUAL_PER_STRATEGY' ? 'EQUAL_PER_STRATEGY' : 'SHARED',
    }
  } catch {
    return { initial_capital: 100000, cost_bps: 0, capital_allocation: 'SHARED' }
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
          }}
          title={isCodeWorkspace && isEditableFile ? `Open ${node.name}` : strategy ? `Drag or click to add ${strategy.name}` : isDataFile ? `Drag or click to add ${dataPath}` : node.name}
          type="button"
        >
          <span className="tree-indent" />
          <ScriptIcon />
          <span>{node.name}</span>
        </button>
        {!selectingStrategies && <button aria-label={`Settings for ${node.name}`} className="item-settings" onClick={() => onOpenItemSettings({ scope, path: relativePath, name: node.name, type: 'file' })} title={`Settings for ${node.name}`} type="button">⚙</button>}
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

function BacktestBucketPanel({
  bucket, strategies, dataFiles, strategyCatalog, expandedStrategies, selectedForSidebar,
  strategyDropHover, dataDropHover, manualDataPath, onSelectBucket, onAddStrategy,
  onStrategyDragEnter, onStrategyDragLeave, onStrategyDrop, onDataDragEnter,
  onDataDragLeave, onDataDrop, onToggleStrategy, onRemoveStrategy,
  onToggleFeed, onUpdateStrategy, onRemoveFeed, onUpdateFeed,
  onManualPathChange, onManualPathKeyDown, onAddManualPath,
}) {
  return (
    <section className="backtest-bucket">
      <div className="backtest-bucket-heading">
        <div><span className="eyebrow">BACKTEST BUCKET</span><h2>{bucket.name}</h2></div>
        <button className={`secondary-button bucket-sidebar-select ${selectedForSidebar ? 'is-selected' : ''}`} onClick={() => onSelectBucket(bucket.id)} type="button">
          {selectedForSidebar ? 'Selected for sidebar adds' : 'Use for sidebar adds'}
        </button>
      </div>

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
            return (
              <article className="strategy-config-card" key={strategy.instanceId}>
                <div className="strategy-config-row">
                  <button aria-expanded={expanded} aria-controls={`strategy-config-${strategy.instanceId}`} className="strategy-config-toggle" onClick={() => onToggleStrategy(strategy.instanceId)} type="button">
                    <span className="tree-chevron">{expanded ? '⌄' : '›'}</span><strong>{strategy.name}</strong><span className="strategy-config-id" title="Strategy instance ID">{strategy.instanceId}</span>
                  </button>
                  <button aria-label={`Remove ${strategy.name}`} className="remove-item-button" onClick={() => onRemoveStrategy(strategy.instanceId)} type="button">×</button>
                </div>
                {expanded && <div className="strategy-config-details" id={`strategy-config-${strategy.instanceId}`}>
                  <section>
                    <div className="config-section-heading"><h3>Connected feeds</h3><span>{strategy.feedIds.length} selected</span></div>
                    {dataFiles.length ? <div className="feed-subscription-list">
                      {dataFiles.map((feed) => <label className="feed-subscription-option" key={feed.instanceId}>
                        <input checked={strategy.feedIds.includes(feed.instanceId)} onChange={() => onToggleFeed(strategy.instanceId, feed.instanceId)} type="checkbox" />
                        <span>{feed.name}</span><small title={feed.path}>{feed.path}</small>
                      </label>)}
                    </div> : <p className="input-help">Add a data feed to this bucket to connect it to the strategy.</p>}
                  </section>
                  <section>
                    <div className="config-section-heading"><h3>Base settings</h3></div>
                    <div className="config-grid config-toggle-grid">
                      {strategy.baseConfig.map((field) => <ConfigField key={field.key} field={field} value={strategy.baseConfigDraft[field.key]} onChange={(key, value) => onUpdateStrategy(strategy.instanceId, 'baseConfigDraft', key, value)} />)}
                    </div>
                  </section>
                  <section>
                    <div className="config-section-heading"><h3>{strategy.name} settings</h3></div>
                    <div className="config-grid">
                      {strategy.parameters.map((field) => <ConfigField key={field.key} field={field} value={strategy.strategyConfigDraft[field.key]} onChange={(key, value) => onUpdateStrategy(strategy.instanceId, 'strategyConfigDraft', key, value)} />)}
                    </div>
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
            <ScriptIcon /><span className="data-file-name" title={feed.path}>{feed.name}</span><span className="data-file-path">{feed.path}</span>
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
  const [expandedNodes, setExpandedNodes] = useState(() => loadExplorerSettings().expandedNodes)
  const [builderPath, setBuilderPath] = useState(DEFAULT_BUILDER_PATH)
  const [pathDraft, setPathDraft] = useState(DEFAULT_BUILDER_PATH)
  const [builderDialogOpen, setBuilderDialogOpen] = useState(false)
  const [builderDialogView, setBuilderDialogView] = useState('menu')
  const [itemDialog, setItemDialog] = useState(null)
  const [itemDialogAction, setItemDialogAction] = useState('menu')
  const [itemNameDraft, setItemNameDraft] = useState('')
  const [itemDialogError, setItemDialogError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [fileEditor, setFileEditor] = useState(null)
  const csvPreviewRows = useMemo(() => fileEditor?.csvTableView ? parseCsvPreview(fileEditor.content) : [], [fileEditor])
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorError, setEditorError] = useState('')
  const [unsavedPromptOpen, setUnsavedPromptOpen] = useState(false)
  const [unsavedPromptError, setUnsavedPromptError] = useState('')
  const [pendingEditorAction, setPendingEditorAction] = useState(null)
  const [strategyCatalog, setStrategyCatalog] = useState([])
  const [backtestBuckets, setBacktestBuckets] = useState([{ id: 'bucket-1', name: 'Bucket 1' }])
  const [activeBucketId, setActiveBucketId] = useState('bucket-1')
  const [backtestStrategies, setBacktestStrategies] = useState([])
  const [expandedBacktestStrategies, setExpandedBacktestStrategies] = useState({})
  const [dataFiles, setDataFiles] = useState([])
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
  const [backtestError, setBacktestError] = useState('')
  const [isRunningBacktest, setIsRunningBacktest] = useState(false)
  const [backtestSettingsOpen, setBacktestSettingsOpen] = useState(false)
  const [backtestSettingsDraft, setBacktestSettingsDraft] = useState({ initial_capital: 100000, cost_bps: 0, capital_allocation: 'SHARED' })
  const [backtestConfig, setBacktestConfig] = useState(loadBacktestSettings)
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
    try { window.localStorage.setItem(BACKTEST_SETTINGS_KEY, JSON.stringify(backtestConfig)) } catch { /* Keep the current settings for this session if storage is unavailable. */ }
  }, [backtestConfig])

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

  function applyStrategy(strategy, bucketId = activeBucketId) {
    strategyInstanceCount.current += 1
    const instanceId = `${strategy.id}-${strategyInstanceCount.current}`
    const feedIds = dataFiles.filter((file) => file.bucketId === bucketId).map((file) => file.instanceId)
    setBacktestStrategies((items) => [...items, {
      instanceId,
      bucketId,
      feedIds,
      ...strategy,
      baseConfigDraft: Object.fromEntries(strategy.baseConfig.map((field) => [field.key, field.default])),
      strategyConfigDraft: Object.fromEntries(strategy.parameters.map((field) => [field.key, field.default])),
    }])
    setBacktestResult(null)
    setBacktestError('')
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
    setDataFiles((items) => [...items, { instanceId, bucketId, path, name, tsUnit: 'MILLISECONDS', dateFormat: 'DDMMYYYY' }])
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
    if (activeBucketId === bucketId) setActiveBucketId(remaining[0].id)
    setBacktestResult(null)
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
            strategies: backtestStrategies.filter((strategy) => strategy.bucketId === bucket.id).map((strategy) => ({
              instanceId: strategy.instanceId,
              strategyId: strategy.id,
              feedIds: strategy.feedIds,
              baseConfig: strategy.baseConfigDraft,
              parameters: strategy.strategyConfigDraft,
            })),
          })),
          backtestConfig,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Backtest failed.')
      setBacktestResult(result)
    } catch (error) {
      setBacktestError(error.message)
    } finally {
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
              <button aria-label="Backtest settings" className="backtest-settings-button" onClick={() => { setBacktestSettingsDraft(backtestConfig); setBacktestSettingsOpen(true) }} title="Backtest settings" type="button"><span aria-hidden="true">⚙</span></button>
            </div>
              <p className="page-description">Add strategies and market-data files from the project explorer, then configure each strategy.</p>

            <form className="simple-backtest-form" onSubmit={runSimpleBacktest}>
              <div className="backtest-buckets-toolbar">
                <div><h2>Buckets</h2><p>Each bucket is an independent account. Strategies in a bucket share its capital and process its feeds in timestamp order.</p></div>
                <button className="secondary-button" onClick={addBacktestBucket} type="button">+ Add bucket</button>
              </div>
              {backtestBuckets.map((bucket) => <div className="backtest-bucket-wrap" key={bucket.id}>
                {backtestBuckets.length > 1 && <button aria-label={`Remove ${bucket.name}`} className="bucket-remove-button" onClick={() => removeBacktestBucket(bucket.id)} type="button">Remove bucket</button>}
                <BacktestBucketPanel
                  bucket={bucket}
                  strategies={backtestStrategies.filter((strategy) => strategy.bucketId === bucket.id)}
                  dataFiles={dataFiles.filter((feed) => feed.bucketId === bucket.id)}
                  strategyCatalog={strategyCatalog}
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

              {!compilation.current && (
                <div className="engine-notice">
                  <span>{compilation.message || 'Compile strategies before running a backtest.'}</span>
                  <button className="secondary-button" onClick={() => { openBuilderDialog(); openCompilationView() }} type="button">Manage compilation</button>
                </div>
              )}
              {backtestError && <p className="form-error">{backtestError}</p>}
              <button className="primary-button run-backtest-button" disabled={!compilation.current || backtestStrategies.length === 0 || dataFiles.length === 0 || backtestStrategies.some((strategy) => strategy.feedIds.length === 0) || isRunningBacktest} type="submit">
                {isRunningBacktest ? 'Running bucketed C++ backtest…' : 'Run backtest'}
              </button>
            </form>

            {backtestResult && (
              <section className="backtest-results">
                <div className="config-section-heading"><h2>Run results</h2><span>{backtestResult.buckets.length} buckets · {backtestResult.inputRows.toLocaleString()} feed rows processed</span></div>
                <div className="result-metrics">
                  <div><span>Final equity</span><strong>{backtestResult.metrics.finalEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div>
                  <div><span>Return</span><strong>{backtestResult.metrics.returnPct.toFixed(2)}%</strong></div>
                  <div><span>Max drawdown</span><strong>{backtestResult.metrics.maxDrawdownPct.toFixed(2)}%</strong></div>
                  <div><span>Orders</span><strong>{backtestResult.metrics.orders}</strong></div>
                </div>
                <div className="bucket-result-list">
                  {backtestResult.buckets.map((bucket) => <article className="bucket-result-card" key={bucket.id}>
                    <div className="config-section-heading"><h3>{backtestBuckets.find((item) => item.id === bucket.id)?.name || bucket.id}</h3><span>{bucket.strategies.length} strategies · {bucket.feeds.length} feeds</span></div>
                    <div className="bucket-result-details">
                      <span>Equity <strong>{bucket.metrics.finalEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></span>
                      <span>Return <strong>{bucket.metrics.returnPct.toFixed(2)}%</strong></span>
                      <span>Drawdown <strong>{bucket.metrics.maxDrawdownPct.toFixed(2)}%</strong></span>
                    </div>
                    <div className="bucket-result-strategies">{bucket.strategies.map((strategy) => <span key={strategy.instanceId}>{strategy.name} <code>{strategy.instanceId}</code> · {strategy.orders.length} orders</span>)}</div>
                  </article>)}
                </div>
                <div className="orders-table-wrap">
                  <table className="orders-table"><thead><tr><th>Bucket</th><th>Strategy instance</th><th>Feed</th><th>Time (epoch ms)</th><th>Side</th><th>Quantity</th><th>Price</th><th>Status</th></tr></thead>
                    <tbody>{backtestResult.orders.length ? backtestResult.orders.map((order) => <tr key={`${order.bucketId}-${order.instanceId}-${order.id}-${order.timestamp}`}><td>{backtestBuckets.find((item) => item.id === order.bucketId)?.name || order.bucketId}</td><td>{order.strategyName} · {order.instanceId}</td><td>{order.feedId || "—"}</td><td>{order.timestamp}</td><td>{order.signal}</td><td>{order.quantity}</td><td>{order.price.toFixed(4)}</td><td>{order.status}</td></tr>) : <tr><td colSpan="8">No orders were generated for this data and configuration.</td></tr>}</tbody>
                  </table>
                </div>
              </section>
            )}
          </section>
        ) : isGridSearch ? (
          <section className="home-view placeholder-view">
            <button aria-label="Back to Backtesting" className="back-link" onClick={() => navigateToPage('backtesting')} title="Back to Backtesting" type="button"><span aria-hidden="true">←</span></button>
            <div className="eyebrow">BACKTESTING</div>
            <h1>GridSearch</h1>
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

      {backtestSettingsOpen && (
        <div className="dialog-backdrop" onMouseDown={() => setBacktestSettingsOpen(false)}>
          <section aria-labelledby="backtest-settings-title" aria-modal="true" className="path-dialog backtest-settings-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="eyebrow">SIMPLE BACKTESTING</div>
            <h2 id="backtest-settings-title">Run settings</h2>
            <p>These defaults are saved in this browser. Starting capital applies independently to each bucket.</p>
            <div className="backtest-settings-fields">
              <label className="config-field"><span>Starting capital per bucket</span><input autoFocus min="0.01" onChange={(event) => setBacktestSettingsDraft((settings) => ({ ...settings, initial_capital: event.target.value }))} step="1000" type="number" value={backtestSettingsDraft.initial_capital} /></label>
              <label className="config-field"><span>Transaction cost (bps)</span><input min="0" onChange={(event) => setBacktestSettingsDraft((settings) => ({ ...settings, cost_bps: event.target.value }))} step="0.1" type="number" value={backtestSettingsDraft.cost_bps} /></label>
              <label className="config-field"><span>Strategy capital</span><select onChange={(event) => setBacktestSettingsDraft((settings) => ({ ...settings, capital_allocation: event.target.value }))} value={backtestSettingsDraft.capital_allocation}><option value="SHARED">Shared within each bucket</option><option value="EQUAL_PER_STRATEGY">Split evenly per strategy</option></select></label>
            </div>
            <div className="dialog-actions">
              <button className="secondary-button" onClick={() => setBacktestSettingsOpen(false)} type="button">Cancel</button>
              <button className="primary-button" disabled={Number(backtestSettingsDraft.initial_capital) <= 0 || Number(backtestSettingsDraft.cost_bps) < 0} onClick={() => { setBacktestConfig({ initial_capital: Number(backtestSettingsDraft.initial_capital), cost_bps: Number(backtestSettingsDraft.cost_bps), capital_allocation: backtestSettingsDraft.capital_allocation }); setBacktestSettingsOpen(false) }} type="button">Save settings</button>
            </div>
          </section>
        </div>
      )}

      {builderDialogOpen && (
        <div className="dialog-backdrop" onMouseDown={() => setBuilderDialogOpen(false)}>
          <section aria-labelledby="builder-dialog-title" aria-modal="true" className="path-dialog builder-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
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
            <div className="eyebrow">{itemDialog.scope === 'data' ? 'DATA' : 'BUILDER'} · ITEM SETTINGS</div>
            <h2 id="item-dialog-title">{itemDialogAction === 'menu' ? itemDialog.name : itemDialogAction === 'create' ? `Create in ${itemDialog.name}` : `Rename ${itemDialog.name}`}</h2>
            {itemDialogAction === 'menu' ? (
              <div className="builder-dialog-options">
                {itemDialog.type === 'directory' && <button className="builder-dialog-option" onClick={beginCreateItem} type="button"><span><strong>Create here</strong><small>Add a folder or file inside {itemDialog.name}.</small></span><span aria-hidden="true">›</span></button>}
                {!itemDialog.isRoot && <button className="builder-dialog-option" onClick={beginRenameItem} type="button"><span><strong>Rename</strong><small>Change this {itemDialog.type} name.</small></span><span aria-hidden="true">›</span></button>}
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

      {yahooOverwritePrompt && (
        <div className="dialog-backdrop" onMouseDown={backFromYahooOverwrite}>
          <section aria-labelledby="yahoo-overwrite-title" aria-modal="true" className="path-dialog yahoo-overwrite-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
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
