import { Component } from "react";

// Error Boundary LOCAL da Projeção Hora a Hora. Garante que um erro de
// renderização nesta página NUNCA deixe a tela totalmente branca: em vez de
// derrubar o app inteiro, mostra uma mensagem e um botão de recarregar.
export default class ErrorBoundaryProjecao extends Component {
  constructor(props) {
    super(props);
    this.state = { erro: null };
  }

  static getDerivedStateFromError(erro) {
    return { erro };
  }

  componentDidCatch(erro, info) {
    // Log no console para diagnóstico (sem quebrar a página).
    console.error("Projeção Hora a Hora — erro de renderização:", erro, info);
  }

  render() {
    if (this.state.erro) {
      return (
        <div
          className="main"
          style={{
            background: "#f4f6fa",
            minHeight: "60vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            fontFamily: "'Inter', system-ui, sans-serif",
          }}
        >
          <div
            style={{
              maxWidth: 440,
              background: "#fff",
              border: "1px solid #e3e7ee",
              borderRadius: 12,
              padding: "28px 24px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 30, marginBottom: 8 }}>⚠️</div>
            <p style={{ fontSize: 15, fontWeight: 700, color: "#0d1321", margin: 0 }}>
              Não foi possível exibir a projeção agora.
            </p>
            <p style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>
              Os demais atendimentos continuam normais. Recarregue a página para tentar de novo.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: 16,
                background: "#1d4ed8",
                color: "#fff",
                border: "none",
                borderRadius: 10,
                padding: "10px 20px",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Recarregar
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
