import { useEffect, useState } from 'react'
import './App.css'

const DEFAULT_STRATEGY_PATH = './builder/strategies'

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

function TreeNode({ node, nodeKey, expandedNodes, onToggle }) {
  const isExpanded = Boolean(expandedNodes[nodeKey])

  if (node.type === 'script') {
    return (
      <div className="tree-item script-item" title={node.name}>
        <span className="tree-indent" />
        <ScriptIcon />
        <span>{node.name}</span>
      </div>
    )
  }

  return (
    <div>
      <button aria-expanded={isExpanded} className="tree-item directory-item" onClick={() => onToggle(nodeKey)} type="button">
        <span className="tree-chevron">{isExpanded ? '⌄' : '›'}</span>
        <FolderIcon />
        <span>{node.name}</span>
      </button>
      {isExpanded && node.children?.length > 0 && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNode key={`${nodeKey}/${child.name}`} node={child} nodeKey={`${nodeKey}/${child.name}`} expandedNodes={expandedNodes} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
  )
}

function App() {
  const [activePage, setActivePage] = useState('home')
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [builderExpanded, setBuilderExpanded] = useState(false)
  const [builderTree, setBuilderTree] = useState([])
  const [expandedNodes, setExpandedNodes] = useState({})
  const [strategyPath, setStrategyPath] = useState(DEFAULT_STRATEGY_PATH)
  const [pathDraft, setPathDraft] = useState(DEFAULT_STRATEGY_PATH)
  const [pathDialogOpen, setPathDialogOpen] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    let isCurrent = true
    async function loadConfig() {
      try {
        const response = await fetch('/api/config')
        if (!response.ok) throw new Error('Could not load local workspace configuration.')
        const config = await response.json()
        if (isCurrent) {
          setStrategyPath(config.builder.strategiesPath)
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
    fetch('/api/builder/tree')
      .then((response) => {
        if (!response.ok) throw new Error('Could not read Builder folders.')
        return response.json()
      })
      .then((tree) => {
        if (isCurrent) setBuilderTree(tree.children)
      })
      .catch(() => {
        if (isCurrent) setBuilderTree([
          { name: 'strategies', type: 'directory', children: [] },
          { name: 'indicators', type: 'directory', children: [] },
        ])
      })
    return () => { isCurrent = false }
  }, [strategyPath])

  function toggleBuilder() {
    setBuilderExpanded((expanded) => !expanded)
  }

  function toggleTreeNode(nodeKey) {
    setExpandedNodes((nodes) => ({ ...nodes, [nodeKey]: !nodes[nodeKey] }))
  }

  function openPathDialog() {
    setPathDraft(strategyPath)
    setSaveError('')
    setPathDialogOpen(true)
  }

  async function saveStrategyPath(event) {
    event.preventDefault()
    const normalizedPath = pathDraft.trim() || DEFAULT_STRATEGY_PATH
    setSaveError('')
    try {
      const response = await fetch('/api/config/builder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategiesPath: normalizedPath }),
      })
      if (!response.ok) throw new Error('Could not save the local workspace configuration.')
      const config = await response.json()
      setStrategyPath(config.builder.strategiesPath)
      setPathDialogOpen(false)
    } catch (error) {
      setSaveError(error.message)
    }
  }

  const isHome = activePage === 'home'
  const isBacktesting = activePage === 'backtesting'

  return (
    <div className="app-shell">
      {isHome && (
        <aside className={`project-sidebar ${sidebarExpanded ? 'is-expanded' : 'is-collapsed'}`}>
          <div className="sidebar-header">
            {sidebarExpanded && <span className="sidebar-title">PROJECT</span>}
            <button aria-label={sidebarExpanded ? 'Collapse project explorer' : 'Expand project explorer'} className="sidebar-toggle" onClick={() => setSidebarExpanded((expanded) => !expanded)} type="button">
              {sidebarExpanded ? '‹' : '›'}
            </button>
          </div>

          {sidebarExpanded && (
            <nav aria-label="Project explorer" className="project-tree">
              <div className="builder-row">
                <button aria-expanded={builderExpanded} className="tree-item builder-item" onClick={toggleBuilder} type="button">
                  <span className="tree-chevron">{builderExpanded ? '⌄' : '›'}</span>
                  <span className="folder-icon">□</span>
                  <span>Builder</span>
                </button>
                <button aria-label="Set Builder path" className="builder-settings" onClick={openPathDialog} type="button">⚙</button>
              </div>
              {builderExpanded && (
                <div className="tree-children">
                  {builderTree.map((node) => (
                    <TreeNode key={`Builder/${node.name}`} node={node} nodeKey={`Builder/${node.name}`} expandedNodes={expandedNodes} onToggle={toggleTreeNode} />
                  ))}
                </div>
              )}
            </nav>
          )}
        </aside>
      )}

      <main className={`main-content ${isHome && sidebarExpanded ? 'sidebar-is-open' : ''}`}>
        {isHome ? (
          <section className="home-view">
            <div className="eyebrow">LOCAL WORKSPACE</div>
            <h1>Welcome to Quantogral</h1>
            <p className="page-description">Your local quantitative research workspace.</p>
            <button className="workspace-tile" onClick={() => setActivePage('backtesting')} type="button">
              <span className="tile-icon" aria-hidden="true">⌁</span>
              <span className="tile-copy"><strong>Backtesting</strong><span>Backtesting workspace · In progress</span></span>
              <span className="tile-arrow" aria-hidden="true">→</span>
            </button>
          </section>
        ) : isBacktesting ? (
          <section className="home-view placeholder-view">
            <div className="eyebrow">RESEARCH</div>
            <h1>Backtesting</h1>
            <span className="progress-badge">IN PROGRESS</span>
          </section>
        ) : (
          <section className="more-view">
            <div className="eyebrow">WORKSPACE</div>
            <h1>More</h1>
            <div className="more-options">
              <div className="more-option">
                <span>Settings</span><span className="progress-badge">IN PROGRESS</span>
              </div>
              <div className="more-option">
                <span>Profile</span><span className="progress-badge">IN PROGRESS</span>
              </div>
            </div>
          </section>
        )}
      </main>

      {pathDialogOpen && (
        <div className="dialog-backdrop" onMouseDown={() => setPathDialogOpen(false)}>
          <section aria-labelledby="builder-path-title" aria-modal="true" className="path-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="eyebrow">BUILDER</div>
            <h2 id="builder-path-title">Set strategies folder</h2>
            <p>Use an absolute path or a path relative to the Quantogral project root. Python `.py` and C++ `.cpp` files appear in the project tree.</p>
            <form onSubmit={saveStrategyPath}>
              <label htmlFor="strategy-path">Strategy scripts folder</label>
              <input autoFocus id="strategy-path" onChange={(event) => setPathDraft(event.target.value)} placeholder="/full/path/to/your/strategies" spellCheck="false" type="text" value={pathDraft} />
              <p className="input-help">Default: <code>./builder/strategies</code></p>
              {saveError && <p className="form-error">{saveError}</p>}
              <div className="dialog-actions">
                <button className="secondary-button" onClick={() => setPathDialogOpen(false)} type="button">Cancel</button>
                <button className="primary-button" type="submit">Save path</button>
              </div>
            </form>
          </section>
        </div>
      )}

      <nav aria-label="Main navigation" className="bottom-bar">
        <button aria-label="Backtesting" className={isBacktesting ? 'is-active' : ''} onClick={() => setActivePage('backtesting')} type="button">
          <span aria-hidden="true">⌁</span><span>Backtesting</span>
        </button>
        <button aria-label="Home" className={isHome ? 'is-active' : ''} onClick={() => setActivePage('home')} type="button">
          <span aria-hidden="true">⌂</span><span>Home</span>
        </button>
        <button aria-label="More" className={activePage === 'more' ? 'is-active' : ''} onClick={() => setActivePage('more')} type="button">
          <span aria-hidden="true">⋯</span><span>More</span>
        </button>
      </nav>
    </div>
  )
}

export default App
