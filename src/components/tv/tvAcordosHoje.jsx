import { Tela, IndicadorCard, AnelProgresso, RaioReativa, moeda, num, statusMeta, T, fs } from "./tvUI";

// =============================================================================
// TV ReATIVA — TELA "ACORDOS DE HOJE"
// -----------------------------------------------------------------------------
// Arquivo próprio exportando só o componente, como as outras telas novas: em
// tvTelas.jsx cada tela soma um erro de react-refresh na catraca de lint.
//
// Tudo vem PRONTO de snap.acordos_hoje, montado por tv_snapshot_atualizar. A
// tela não calcula nada e não consulta nada — nem a taxa, que já vem no
// payload. As duas definições estão fixadas na migration 20261008120000:
//
//   fechado hoje -> acordos.criado_em no fuso de São Paulo, sem duplicado e
//                   sem cancelado; dono = acordos.operador_responsavel_email
//   convertido   -> pagamento real em public.pagamentos, casado pelo boleto da
//                   parcela, com data_pagamento >= o dia do acordo
//
// O recorte de data do pagamento é o que separa desempenho de artefato: 32%
// dos acordos pagos dos últimos 45 dias só têm pagamento ANTERIOR ao acordo —
// são registros retroativos, não conversão. Eles não entram aqui.
//
// A tela fica visível mesmo zerada (decisão da gestão): dia sem acordo é
// informação, não ausência de informação.
//
// VOCABULÁRIO, de propósito: "com pagamento" e "convertidos", nunca "pagos" ou
// "quitados". Um acordo com pagamento recebeu DINHEIRO de alguma parcela — não
// quer dizer que esteja liquidado. Confundir os dois no telão viraria número
// inflado na cabeça de quem assiste.
// =============================================================================

export default function TelaAcordosHoje({ snap }) {
  const a = snap?.acordos_hoje || {};
  const fechados = Number(a.fechados || 0);
  const convertidos = Number(a.convertidos || 0);
  const valor = Number(a.valor_pago || 0);
  const ranking = Array.isArray(a.ranking) ? a.ranking : [];
  // `taxa_pct` vem null quando não houve acordo — não é zero, é "não se aplica".
  const taxa = a.taxa_pct == null ? null : Number(a.taxa_pct);

  // Sem acordo nenhum o anel não tem o que dizer: a tela vira um convite, não
  // um "0%" que parece desempenho ruim quando na verdade o dia mal começou.
  if (fechados === 0) {
    return (
      <Tela titulo="Acordos de Hoje">
        <div style={vazioBloco}>
          <RaioReativa tamanho={fs(34, 4.0, 92)} />
          <div style={vazioTitulo}>Nenhum acordo fechado hoje ainda</div>
          <div style={vazioTexto}>O primeiro do dia aparece aqui assim que for registrado.</div>
        </div>
      </Tela>
    );
  }

  // SEM selo de julgamento (decisão da gestão em 08/10/2026): às 9h da manhã,
  // com 3 acordos e nenhum convertido, o telão dizia "Abaixo do ritmo" em
  // vermelho. O número está certo; o julgamento não — o dia mal começou e
  // pagamento de acordo raramente entra na mesma hora. A taxa fica informativa;
  // `status` segue só para a COR do arco, sem rótulo.
  const status = statusMeta(taxa);

  return (
    <Tela titulo="Acordos de Hoje">
      <div style={corpo}>
        <AnelProgresso pct={taxa} rotulo="com pagamento" status={status} semSelo tamanho={ALTURA_BLOCO}>
          <RaioReativa tamanho={fs(28, 3.2, 72)} />
        </AnelProgresso>

        <div style={grade}>
          <IndicadorCard rotulo="Acordos fechados hoje" valor={num(fechados)} tom="azul" />
          <IndicadorCard rotulo="Já com pagamento" valor={num(convertidos)} tom="verde" />
          <IndicadorCard rotulo="Valor pago" valor={moeda(valor)} tom="verde" />
          <IndicadorCard rotulo="Ainda sem pagamento" valor={num(Math.max(0, fechados - convertidos))}
            tom={convertidos >= fechados ? "verde" : "ambar"} />
        </div>
      </div>

      {ranking.length > 0 && (
        <div style={faixa}>
          {ranking.slice(0, 4).map((r) => (
            <div key={r.operador} style={cardOp}>
              <div style={nomeOp}>{r.operador}</div>
              <div style={linhaOp}>
                <span style={numeroOp}>{num(r.fechados)}</span>
                <span style={rotuloOp}>fechados</span>
                <span style={{ ...numeroOp, color: T.verde }}>{num(r.convertidos)}</span>
                <span style={rotuloOp}>convertidos</span>
              </div>
              <div style={valorOp}>{moeda(r.valor_pago)}</div>
            </div>
          ))}
        </div>
      )}
    </Tela>
  );
}

const ALTURA_BLOCO = "min(38vh, 26vw)";
const corpo = {
  display: "flex", alignItems: "center", justifyContent: "center",
  gap: "clamp(18px, 3.2vw, 70px)", width: "100%", flex: "0 0 auto", minHeight: 0, flexWrap: "nowrap",
};
const grade = {
  display: "grid", gridTemplateColumns: "1fr 1fr", gap: "clamp(8px, 1.2vw, 22px)",
  flex: "1 1 auto", maxWidth: "58vw", minWidth: 0,
};
const faixa = {
  display: "flex", gap: "clamp(10px, 1.4vw, 28px)", justifyContent: "center",
  width: "min(88vw, 1600px)", flex: "0 0 auto", flexWrap: "nowrap",
};
const cardOp = {
  background: "rgba(148,163,184,0.10)", border: "1px solid rgba(148,163,184,0.22)",
  borderRadius: 18, padding: "1.2vh 1.4vw", display: "flex", flexDirection: "column",
  gap: "0.5vh", flex: "1 1 0", minWidth: 0, alignItems: "center", textAlign: "center",
  boxShadow: "0 10px 40px rgba(2,6,23,0.35)", boxSizing: "border-box",
};
const nomeOp = {
  fontSize: fs(13, 1.35, 30), fontWeight: 800, color: T.texto,
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%",
};
const linhaOp = { display: "flex", alignItems: "baseline", gap: "0.5vw", flexWrap: "nowrap" };
const numeroOp = { fontSize: fs(20, 2.3, 52), fontWeight: 900, lineHeight: 1, color: T.azulClaro };
const rotuloOp = {
  fontSize: fs(10, 1.0, 22), fontWeight: 700, color: T.textoMudo,
  textTransform: "uppercase", letterSpacing: "0.08em",
};
const valorOp = { fontSize: fs(13, 1.35, 30), fontWeight: 700, color: T.textoSuave };
const vazioBloco = {
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  gap: "1.4vh", textAlign: "center",
};
const vazioTitulo = { fontSize: fs(22, 2.6, 64), fontWeight: 900, color: T.texto };
const vazioTexto = { fontSize: fs(14, 1.5, 34), fontWeight: 600, color: T.textoSuave };
