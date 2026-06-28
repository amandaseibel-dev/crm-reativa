import './App.css'

function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">R</span>
          <div>
            <h1>Reativa One</h1>
            <p>CRM Operacional</p>
          </div>
        </div>

        <nav>
          <a className="active">🏠 Dashboard</a>
          <a>👥 Operadores</a>
          <a>📂 Base Analítica</a>
          <a>📞 Acionamentos</a>
          <a>💰 Borderôs</a>
          <a>💳 Pagamentos</a>
          <a>📊 Financeiro</a>
          <a>🔔 Alertas</a>
          <a>⚙️ Administração</a>
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h2>Dashboard Gerencial</h2>
            <p>Visão operacional da carteira Reativa</p>
          </div>
          <div className="user">Amanda • Gerente</div>
        </header>

        <section className="cards">
          <div className="card">
            <span>Casos na fila</span>
            <strong>2.431</strong>
            <p>Base ativa em cobrança</p>
          </div>
          <div className="card warning">
            <span>Sem acionamento</span>
            <strong>156</strong>
            <p>Precisam de atenção hoje</p>
          </div>
          <div className="card danger">
            <span>Casos críticos</span>
            <strong>87</strong>
            <p>Próximos ou acima de 10 dias</p>
          </div>
          <div className="card success">
            <span>Honorários mês</span>
            <strong>R$ 254.978</strong>
            <p>92% da meta mensal</p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>Casos próximos dos 10 dias</h3>
            <button>Ver todos</button>
          </div>

          <table>
            <thead>
              <tr>
                <th>Aluno</th>
                <th>Operador</th>
                <th>Dias sem acionamento</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>João da Silva</td>
                <td>Olga</td>
                <td>9 dias</td>
                <td><span className="badge orange">Atenção</span></td>
              </tr>
              <tr>
                <td>Maria Oliveira</td>
                <td>Luana</td>
                <td>8 dias</td>
                <td><span className="badge yellow">Monitorar</span></td>
              </tr>
              <tr>
                <td>Carlos Pereira</td>
                <td>Diego</td>
                <td>10 dias</td>
                <td><span className="badge red">Crítico</span></td>
              </tr>
            </tbody>
          </table>
        </section>
      </main>
    </div>
  )
}

export default App