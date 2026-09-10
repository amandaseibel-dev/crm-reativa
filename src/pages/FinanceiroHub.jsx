import { useState } from "react";
import ConsultaFinanceira from "./ConsultaFinanceira";
import ConferenciaPagamentos from "./ConferenciaPagamentos";
import PainelAdm from "./PainelAdm";
import ConferenciaPrime from "./ConferenciaPrime";
import AcordosSemResponsavel from "../components/AcordosSemResponsavel";
import ForaDaCobranca from "../components/ForaDaCobranca";
import MinhaFilaPagamentos from "./MinhaFilaPagamentos"; import HistoricoConfirmacoes from "./HistoricoConfirmacoes";
import AcordosSemVinculo from "./AcordosSemVinculo";

// Reune as telas financeiras num lugar so, com abas. Cada aba carrega o
// componente ORIGINAL sem nenhuma alteracao interna -- nenhuma logica,
// permissao ou referencia foi tocada, so a navegacao mudou.
// A fila de acordos NAO tem aba propria aqui: ela ja vive dentro de
// "Confirmacao de Pagamento" (sub-aba "Acordos a confirmar"), e ter as duas
// portas pra mesma tela so fazia parecer que eram filas diferentes.
//
// MESMA REGRA, 28/08/2026: "Pagamentos sem aluno" e "Quitacao sugerida"
// nasceram como itens soltos no menu Gestao. Sao conferencia igual as outras
// -- olhar um caso e decidir -- entao vieram para ca como abas. Amanda: "tudo
// que tiver de confirmacao deveria aparecer na aba de confirmacao e nao em
// outro lugar, vai confundir tudo".
//
// DE NOVO, 02/09/2026: "Acordos sem vinculo" tambem nasceu como item solto no
// menu Gestao, e a Amanda perguntou na hora "vai ficar no financeiro onde?".
// E conferencia igual as outras -- olhar o acordo, decidir qual mensalidade ele
// substituiu -- e o vinculo em si e feito no Financeiro da ficha. Virou aba.
const ABAS = [
  { chave: "PAINEL_ADM", rotulo: "Painel ADM" },
  { chave: "FINANCEIRO", rotulo: "Financeiro" },
  { chave: "CONFIRMACAO", rotulo: "Confirmação de Pagamento" },
  { chave: "FILA_BAIXAS", rotulo: "Fila de Baixas" },
  { chave: "CONFERENCIA_PRIME", rotulo: "Conferência Prime" },
  { chave: "ACORDOS_SEM_VINCULO", rotulo: "Acordos sem vínculo" },
  { chave: "HIST_CONFIRMACOES", rotulo: "Histórico de Confirmações" },
  // MESMA REGRA, 10/09/2026: as duas nasceram dentro de /central-pagamentos, que
  // nao tem link em menu nenhum -- so abre por URL digitada. A Amanda foi
  // procurar e nao achou. Sao conferencia como as outras: olhar um acordo sem
  // dono, olhar o que esta fora da cobranca. Viraram aba daqui.
  { chave: "ACORDO_SEM_RESP", rotulo: "Acordos sem responsável" },
  { chave: "FORA_COBRANCA", rotulo: "Fora da cobrança" },
];

export default function FinanceiroHub() {
  const [aba, setAba] = useState("PAINEL_ADM");

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <h1 style={estilos.titulo}>💰 Financeiro</h1>
        <p style={estilos.subtitulo}>
          Painel ADM, Financeiro, Confirmação de Pagamento e Financeiro Operadores, tudo aqui.
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
        {aba === "CONFIRMACAO" && <ConferenciaPagamentos />}
        {aba === "FILA_BAIXAS" && <MinhaFilaPagamentos />}
        {aba === "CONFERENCIA_PRIME" && <ConferenciaPrime />}
        {aba === "ACORDOS_SEM_VINCULO" && <AcordosSemVinculo />}
        {aba === "HIST_CONFIRMACOES" && <HistoricoConfirmacoes />}
        {aba === "ACORDO_SEM_RESP" && <AcordosSemResponsavel />}
        {aba === "FORA_COBRANCA" && <ForaDaCobranca />}
      </div>
    </div>
  );
}

const estilos = {
  container: {
    padding: "24px 26px 40px",
    fontFamily: "'Inter', system-ui, sans-serif",
    background: "var(--rv-fundo, var(--rv-fundo))",
    minHeight: "100%",
  },
  cabecalho: { marginBottom: 16 },
  titulo: {
    margin: 0,
    color: "var(--rv-tinta, var(--rv-tinta))",
    fontFamily: "var(--rv-fonte-titulo, 'Sora', sans-serif)",
    fontSize: 24,
    fontWeight: 800,
    letterSpacing: "-0.02em",
  },
  subtitulo: { margin: "4px 0 0", color: "var(--rv-texto-suave, var(--rv-texto-fraco))", fontSize: 13 },
  abas: {
    display: "flex",
    gap: 8,
    marginBottom: 20,
    flexWrap: "wrap",
  },
  aba: {
    background: "var(--rv-superficie)",
    border: "1px solid var(--rv-borda, var(--rv-borda))",
    borderRadius: 10,
    padding: "10px 18px",
    fontSize: 13.5,
    fontWeight: 700,
    color: "var(--rv-texto)",
    cursor: "pointer",
    boxShadow: "0 1px 2px rgba(16,24,40,0.04)",
    transition: "all 0.15s ease",
  },
  abaAtiva: {
    background: "var(--rv-verde, #1e40af)",
    border: "1px solid var(--rv-verde, #1e40af)",
    borderRadius: 10,
    padding: "10px 18px",
    fontSize: 13.5,
    fontWeight: 800,
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(15,157,107,0.35)",
  },
  conteudo: {
    background: "var(--rv-superficie)",
    borderRadius: 16,
    minHeight: 400,
    overflow: "hidden",
  },
};
