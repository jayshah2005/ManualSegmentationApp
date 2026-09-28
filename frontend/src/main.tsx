/**
 * React entry: mount the curation app into `#root`.
 * Vite serves this in dev; production build is optional-hosted by FastAPI.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
