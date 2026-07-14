import { useState } from "react";
import ConsultaFinanceira from "./ConsultaFinanceira";
import FilaConfirmacaoPagamento from "./FilaConfirmacaoPagamento";
import Borderos from "./Borderos";
import PainelAdm from "./PainelAdm";
import GestaoFinanceiraOperadores from "./GestaoFinanceiraOperadores";
import MinhaFilaPagamentos from "./MinhaFilaPagamentos";

// Reune as telas financeiras num lugar so, com abas. Cada aba carrega o
// componente ORIGINAL sem nenhuma alteracao interna -- nenhuma logica,
// permissao ou referencia foi tocada, so a navegacao mudou.
const ABAS = [
  { chave: "PAINEL_ADM", rotulo: "Painel ADM" },
  { chave: "FINANCEIRO", rotulo: "Financeiro" },
  { chave: "CONFIRMACAO", rotulo: "Confirmação de Pagamento" },
  { chave: "FILA_BAIXAS", rotulo: "Fila de Baixas" },
  { chave: "BORDEROS", rotulo: "Borderôs" },
  { chave: "OPERADORES", rotulo: "Financeiro Operadores" },
];

export default function FinanceiroHub() {
  const [aba, setAba] = useState("PAINEL_ADM");

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <h1 style={estilos.titulo}>💰 Financeiro</h1>
        <p style={estilos.subtitulo}>
          Painel ADM, Financeiro, Confirmação de Pagamento, Borderôs e Financeiro Operadores, tudo aqui.
        </p>
      </div>

      <div style={estilos.abas}>
        {ABAS.map((a) => (
          <button
            key={a.chave}
            style={aba === a.chave ? estilos.abaAtiva : estilos.aba}
            onClick={() => setAba(a.chave)}
          >
            {a.rotulo}
          </button>
        ))}
      </div>

      <div style={estilos.conteudo}>
        {aba === "PAINEL_ADM" && <PainelAdm />}
        {aba === "FINANCEIRO" && <ConsultaFinanceira />}
        {aba === "CONFIRMACAO" && <FilaConfirmacaoPagamento />}
        {aba === "FILA_BAIXAS" && <MinhaFilaPagamentos />}
        {aba === "BORDEROS" && <Borderos />}
        {aba === "OPERADORES" && <GestaoFinanceiraOperadores />}
      </div>
    </div>
  );
}

const estilos = {
  container: {
    padding: "24px 26px 40px",
    fontFamily: "'Inter', system-ui, sans-serif",
    background: "var(--rv-fundo, #f4f6fa)",
    minHeight: "100%",
  },
  cabecalho: { marginBottom: 16 },
  titulo: {
    margin: 0,
    color: "var(--rv-tinta, #0d1321)",
    fontFamily: "var(--rv-fonte-titulo, 'Sora', sans-serif)",
    fontSize: 24,
    fontWeight: 800,
    letterSpacing: "-0.02em",
  },
  subtitulo: { margin: "4px 0 0", color: "var(--rv-texto-suave, #8a93a3)", fontSize: 13 },
  abas: {
    display: "flex",
    gap: 4,
    marginBottom: 18,
    borderBottom: "1px solid var(--rv-borda, #e3e7ee)",
    flexWrap: "wrap",
  },
  aba: {
    background: "transparent",
    border: "1px solid transparent",
    borderBottom: "none",
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    padding: "9px 16px",
    fontSize: 13.5,
    fontWeight: 700,
    color: "#98a2b3",
    cursor: "pointer",
    marginBottom: -1,
  },
  abaAtiva: {
    background: "#fff",
    border: "1px solid var(--rv-borda, #e3e7ee)",
    borderBottom: "1px solid #fff",
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    padding: "9px 16px",
    fontSize: 13.5,
    fontWeight: 700,
    color: "var(--rv-verde, #0f9d6b)",
    cursor: "pointer",
    marginBottom: -1,
  },
  conteudo: {
    background: "#fff",
    borderRadius: 16,
    minHeight: 400,
    overflow: "hidden",
  },
};
