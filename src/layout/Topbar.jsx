export default function Topbar() {
  return (
    <header className="topbar">
      <div>
        <h1>Dashboard</h1>
        <p>Visão geral da operação ReATIVA</p>
      </div>

      <div className="top-actions">
        <input placeholder="Pesquisar aluno, CPF ou operador..." />
        <button>🔔 12</button>
        <div className="user">Amanda Seibel</div>
      </div>
    </header>
  )
}