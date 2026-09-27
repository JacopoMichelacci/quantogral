import { useState } from 'react'
import './App.css'

const DEFAULT_STRATEGY_PATH = './builder/strategies'

function App() {
  const [activePage, setActivePage] = useState('home')
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [builderExpanded, setBuilderExpanded] = useState(false)
  const [builderSelected, setBuilderSelected] = useState(false)
  const [strategyPath, setStrategyPath] = useState(
    () => window.localStorage.getItem('quantogral.strategyPath') || DEFAULT_STRATEGY_PATH,
  )
  const [builderConfigured, setBuilderConfigured] = useState(
    () => Boolean(window.localStorage.getItem('quantogral.strategyPath')),
  )

  function openBuilder() {
    setBuilderExpanded(true)
    setBuilderSelected(true)
  }

  function saveStrategyPath(event) {
    event.preventDefault()
    const normalizedPath = strategyPath.trim() || DEFAULT_STRATEGY_PATH
    setStrategyPath(normalizedPath)
    window.localStorage.setItem('quantogral.strategyPath', normalizedPath)
    setBuilderConfigured(true)
  }

  const isHome = activePage === 'home'

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
              <button aria-expanded={builderExpanded} className={`tree-item builder-item ${builderSelected ? 'is-selected' : ''}`} onClick={openBuilder} type="button">
                <span className="tree-chevron">{builderExpanded ? '⌄' : '›'}</span>
                <span className="folder-icon">□</span>
                <span>Builder</span>
              </button>
              {builderExpanded && (
                <div className="tree-children">
                  <button className="tree-item" onClick={openBuilder} type="button"><span className="folder-icon">□</span><span>strategies</span></button>
                  <button className="tree-item" onClick={openBuilder} type="button"><span className="folder-icon">□</span><span>indicators</span></button>
                </div>
              )}
            </nav>
          )}
        </aside>
      )}

      <main className={`main-content ${isHome && sidebarExpanded ? 'sidebar-is-open' : ''}`}>
        {builderSelected ? (
          <section className="builder-view">
            <div className="eyebrow">BUILDER</div>
            <h1>{builderConfigured ? 'Strategy workspace' : 'Set up your strategy workspace'}</h1>
            <p className="page-description">Choose the folder that contains your Python strategies. Quantogral will use this location as your strategy root.</p>
            <form className="path-form" onSubmit={saveStrategyPath}>
              <label htmlFor="strategy-path">Python strategies folder</label>
              <input id="strategy-path" onChange={(event) => setStrategyPath(event.target.value)} placeholder="/full/path/to/your/strategies" spellCheck="false" type="text" value={strategyPath} />
              <p className="input-help">Default: <code>./builder/strategies</code>, relative to the Quantogral project root.</p>
              <button className="primary-button" type="submit">{builderConfigured ? 'Update folder' : 'Use this folder'}</button>
            </form>
          </section>
        ) : (
          <section className="home-view">
            <div className="eyebrow">LOCAL WORKSPACE</div>
            <h1>Quantogral</h1>
            <p className="page-description">Open Builder to choose where your Python strategies live.</p>
          </section>
        )}
      </main>

      <nav aria-label="Main navigation" className="bottom-bar">
        <button aria-label="Home" className={isHome ? 'is-active' : ''} onClick={() => setActivePage('home')} type="button">
          <span aria-hidden="true">⌂</span><span>Home</span>
        </button>
      </nav>
    </div>
  )
}

export default App
