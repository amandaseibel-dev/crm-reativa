import { Component } from "react";

// Boundary local e leve: isola um trecho da Projeção. Se o filho quebrar, o
// resto da página continua renderizando e mostramos um aviso compacto (com a
// mensagem técnica só em dev/Preview — nunca em produção). Sem PII, sem token.
export default class BoundaryLocal extends Component {
  constructor(props) {
    super(props);
    this.state = { erro: null };
  }
  static getDerivedStateFromError(erro) {
    return { erro };
  }
  componentDidCatch(erro, info) {
    console.error(`Projeção — falha em [${this.props.label || "trecho"}]:`, erro, info);
  }
  render() {
    if (this.state.erro) {
      const mostrarDetalhe =
        import.meta.env?.DEV ||
        String(import.meta.env?.VITE_MODO_CONTENCAO_ANALITICAS).toLowerCase() === "false";
      return (
        <div style={{ padding: "10px 12px", borderRadius: 10, background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412", fontSize: 12.5 }}>
          ⚠️ {this.props.label || "Este trecho"} está indisponível no momento.
          {mostrarDetalhe && (
            <div style={{ marginTop: 6, color: "#b91c1c", fontFamily: "monospace", fontSize: 11, whiteSpace: "pre-wrap" }}>
              {`[${this.props.label}] ${this.state.erro?.name || "Error"}: ${this.state.erro?.message || ""}`}
            </div>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
