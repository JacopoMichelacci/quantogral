import { useState } from 'react'
import './App.css'

function App() {
  const [activePage, setActivePage] = useState('home')

  return (
    <div>
      <div className="bottom-bar">
        <span onClick={() => setActivePage('home')}>🏠</span>
      </div>
    </div>
  )
}

export default App