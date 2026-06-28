export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="logo">
        <strong>ReATIVA</strong>
        <span>ONE</span>
      </div>

      <nav>
        <button className="active">🏠 Dashboard</button>
        <button>👥 Operadores</button>
        <button>📂 Base Analítica</button>
        <button>📞 Acionamentos</button>
        <button>💰 Borderôs</button>
        <button>💳 Pagamentos</button>
        <button>📈 Financeiro</button>
        <button>🔔 Alertas</button>
        <button>⚙ Administração</button>
      </nav>
    </aside>
  )
}