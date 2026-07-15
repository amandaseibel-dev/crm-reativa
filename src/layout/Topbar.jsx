export default function Topbar() {
  return (
    <header className="topbar">
      <div>
        <h1>Dashboard</h1>
        <p>Visão geral da operação ReATIVA</p>
      </div>

      <div className="top-actions">
        <input placeholder="Pesquisar aluno, CPF ou operador..." />
        <div className="user">Amanda Seibel</div>
      </div>
    </header>
  )
}