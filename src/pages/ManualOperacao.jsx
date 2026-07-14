import { useNavigate } from "react-router-dom";

export default function ManualOperacao() {
  const navigate = useNavigate();

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <p style={styles.selo}>ReATIVA One</p>
          <h1 style={styles.titulo}>Manual Básico da Operação</h1>
          <p style={styles.subtitulo}>
            Guia rápido para teste controlado da Fila Operacional, Agenda e Ficha Unificada.
          </p>
        </div>

        <div style={styles.nav}>
          <button style={styles.botaoClaro} onClick={() => navigate("/minha-fila")}>
            Fila Operacional
          </button>
          <button style={styles.botaoClaro} onClick={() => navigate("/agenda-operacional")}>
            Agenda
          </button>
          <button style={styles.botaoClaro} onClick={() => navigate("/alunos-unificados")}>
            Pesquisar Alunos
          </button>
        </div>
      </div>

      <div style={styles.gridCards}>
        <section style={styles.card}>
          <h2 style={styles.cardTitulo}>1. Onde começar</h2>
          <p style={styles.texto}>
            O operador deve iniciar pela <strong>Fila Operacional</strong>.
          </p>
          <div style={styles.blocoLink}>/minha-fila</div>
          <p style={styles.texto}>
            Ali ficam os alunos unificados para atendimento, com todos os casos financeiros dentro da ficha.
          </p>
        </section>

        <section style={styles.card}>
          <h2 style={styles.cardTitulo}>2. Pesquisar aluno</h2>
          <p style={styles.texto}>
            A pesquisa pode ser feita por:
          </p>
          <ul style={styles.lista}>
            <li>nome do aluno;</li>
            <li>CPF de referência;</li>
            <li>operador responsável;</li>
            <li>chave de unificação.</li>
          </ul>
          <p style={styles.texto}>
            A pesquisa principal fica em <strong>Alunos Unificados</strong>.
          </p>
          <div style={styles.blocoLink}>/alunos-unificados</div>
        </section>

        <section style={styles.card}>
          <h2 style={styles.cardTitulo}>3. Assumir atendimento</h2>
          <p style={styles.texto}>
            Ao localizar um aluno, o operador deve clicar em <strong>Assumir atendimento</strong>.
          </p>
          <p style={styles.texto}>
            Isso grava o operador responsável no cadastro unificado do aluno.
          </p>
          <div style={styles.alerta}>
            Depois de assumir, o aluno passa a aparecer na fila do operador.
          </div>
        </section>

        <section style={styles.card}>
          <h2 style={styles.cardTitulo}>4. Abrir ficha unificada</h2>
          <p style={styles.texto}>
            Clique em <strong>Abrir ficha unificada</strong> para visualizar:
          </p>
          <ul style={styles.lista}>
            <li>dados do aluno;</li>
            <li>todos os casos financeiros;</li>
            <li>valor total;</li>
            <li>agenda/próxima ação;</li>
            <li>links de pagamento;</li>
            <li>comprovantes e documentos.</li>
          </ul>
        </section>

        <section style={styles.card}>
          <h2 style={styles.cardTitulo}>5. Registrar contato</h2>
          <p style={styles.texto}>
            Na ficha do aluno, use o bloco <strong>Agenda / Próxima Ação</strong>.
          </p>
          <ul style={styles.lista}>
            <li>selecione o status;</li>
            <li>registre a observação;</li>
            <li>informe data e hora de retorno, se houver;</li>
            <li>clique em salvar.</li>
          </ul>
          <div style={styles.alerta}>
            A observação fica salva no cadastro do aluno e alimenta a Agenda Operacional.
          </div>
        </section>

        <section style={styles.card}>
          <h2 style={styles.cardTitulo}>6. Agenda Operacional</h2>
          <p style={styles.texto}>
            A agenda mostra as prioridades do dia:
          </p>
          <ul style={styles.lista}>
            <li>sem acionamento;</li>
            <li>retornos atrasados;</li>
            <li>retornos de hoje;</li>
            <li>mais de 10 dias sem contato;</li>
            <li>sem operador.</li>
          </ul>
          <div style={styles.blocoLink}>/agenda-operacional</div>
        </section>

        <section style={styles.card}>
          <h2 style={styles.cardTitulo}>7. Link de pagamento</h2>
          <p style={styles.texto}>
            O operador pode solicitar link dentro da ficha do aluno.
          </p>
          <p style={styles.texto}>
            O ADM gera ou cola o link, e o operador acompanha o status.
          </p>
          <ul style={styles.lista}>
            <li>solicitado;</li>
            <li>link gerado;</li>
            <li>link enviado;</li>
            <li>pago aguardando baixa;</li>
            <li>baixado.</li>
          </ul>
        </section>

        <section style={styles.card}>
          <h2 style={styles.cardTitulo}>8. O que o operador não deve fazer</h2>
          <p style={styles.texto}>
            Estas ações ficam restritas para Amanda gestora:
          </p>
          <ul style={styles.lista}>
            <li>baixar pagamento;</li>
            <li>aprovar quitação;</li>
            <li>ajustar valor;</li>
            <li>ajustar cadastro;</li>
            <li>ocultar aluno da fila.</li>
          </ul>
        </section>

        <section style={styles.cardDestaque}>
          <h2 style={styles.cardTituloClaro}>Como reportar erro</h2>
          <p style={styles.textoClaro}>
            Se aparecer erro durante o teste, enviar para Amanda:
          </p>
          <ul style={styles.listaClara}>
            <li>print da tela;</li>
            <li>nome do aluno;</li>
            <li>tela onde ocorreu;</li>
            <li>o que estava tentando fazer.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: "100%",
    background: "linear-gradient(135deg, #071526 0%, #0b1f3a 50%, #102a4c 100%)",
    padding: "28px",
    fontFamily: "Arial, sans-serif",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: "18px",
    alignItems: "flex-start",
    marginBottom: "24px",
  },
  selo: {
    display: "inline-block",
    background: "#19c37d",
    color: "#071526",
    fontWeight: "bold",
    borderRadius: "999px",
    padding: "6px 12px",
    margin: "0 0 10px 0",
  },
  titulo: {
    margin: 0,
    color: "#ffffff",
    fontSize: "32px",
  },
  subtitulo: {
    margin: "8px 0 0 0",
    color: "#dbeafe",
    fontSize: "16px",
  },
  nav: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  botaoClaro: {
    background: "#ffffff",
    color: "#0b1f3a",
    border: "none",
    borderRadius: "10px",
    padding: "11px 14px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  gridCards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: "16px",
  },
  card: {
    background: "#ffffff",
    borderRadius: "16px",
    padding: "20px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
    borderTop: "5px solid #19c37d",
  },
  cardDestaque: {
    background: "#0f172a",
    borderRadius: "16px",
    padding: "20px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
    border: "1px solid rgba(255,255,255,0.14)",
  },
  cardTitulo: {
    margin: "0 0 10px 0",
    color: "#111827",
  },
  cardTituloClaro: {
    margin: "0 0 10px 0",
    color: "#ffffff",
  },
  texto: {
    color: "#374151",
    lineHeight: 1.5,
  },
  textoClaro: {
    color: "#dbeafe",
    lineHeight: 1.5,
  },
  lista: {
    color: "#374151",
    lineHeight: 1.7,
    paddingLeft: "20px",
  },
  listaClara: {
    color: "#dbeafe",
    lineHeight: 1.7,
    paddingLeft: "20px",
  },
  blocoLink: {
    background: "#eff6ff",
    color: "#0b1f3a",
    border: "1px solid #bfdbfe",
    borderRadius: "10px",
    padding: "10px",
    fontWeight: "bold",
    margin: "10px 0",
  },
  alerta: {
    background: "#ecfdf5",
    color: "#065f46",
    border: "1px solid #a7f3d0",
    borderRadius: "10px",
    padding: "10px",
    marginTop: "10px",
    fontWeight: "bold",
  },
};
