import './App.css'

export default function App() {
  const cards = [
    { titulo: "Casos na Fila", valor: "2.431", cor: "verde" },
    { titulo: "Casos Críticos", valor: "87", cor: "vermelho" },
    { titulo: "Sem Acionamento", valor: "156", cor: "laranja" },
    { titulo: "Honorários", valor: "R$ 254.978", cor: "azul" },
  ]

  return (
    <div className="app">

      <aside className="sidebar">

        <div className="logo">
          <h1>REATIVA</h1>
          <span>ONE CRM</span>
        </div>

        <nav>

          <button>🏠 Dashboard</button>

          <button>👥 Operadores</button>

          <button>📂 Base Analítica</button>

          <button>📞 Acionamentos</button>

          <button>💰 Borderôs</button>

          <button>💳 Pagamentos</button>

          <button>📊 Financeiro</button>

          <button>🔔 Alertas</button>

          <button>⚙ Administração</button>

        </nav>

      </aside>

      <main>

        <header>

          <div>

            <h2>Dashboard Operacional</h2>

            <p>Bem-vinda Amanda 👋</p>

          </div>

        </header>

        <section className="cards">

          {cards.map((card) => (

            <div className={`card ${card.cor}`} key={card.titulo}>

              <h4>{card.titulo}</h4>

              <h1>{card.valor}</h1>

            </div>

          ))}

        </section>

        <section className="painel">

          <h2>Casos próximos dos 10 dias</h2>

          <table>

            <thead>

              <tr>

                <th>Aluno</th>

                <th>Operador</th>

                <th>Dias</th>

                <th>Status</th>

              </tr>

            </thead>

            <tbody>

              <tr>

                <td>João da Silva</td>

                <td>Olga</td>

                <td>9</td>

                <td>🟠 Atenção</td>

              </tr>

              <tr>

                <td>Maria Oliveira</td>

                <td>Luana</td>

                <td>10</td>

                <td>🔴 Crítico</td>

              </tr>

            </tbody>

          </table>

        </section>

      </main>

    </div>
  )
}