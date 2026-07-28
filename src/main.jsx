import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { AbaLiderProvider } from './context/AbaLiderContext.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AbaLiderProvider>
      <App />
    </AbaLiderProvider>
  </StrictMode>,
)
// deploy fix
