import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import PlasmaPage from './pages/PlasmaPage';
import CantonPage from './pages/CantonPage';

export default function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <nav className="navbar">
          <div className="nav-brand">Canton Bridge</div>
          <div className="nav-tabs">
            <NavLink
              to="/"
              end
              className={({ isActive }) => `nav-tab${isActive ? ' active' : ''}`}
            >
              Plasma
            </NavLink>
            <NavLink
              to="/canton"
              className={({ isActive }) => `nav-tab${isActive ? ' active' : ''}`}
            >
              Canton
            </NavLink>
          </div>
        </nav>
        <main className="main">
          <Routes>
            <Route path="/" element={<PlasmaPage />} />
            <Route path="/canton" element={<CantonPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
