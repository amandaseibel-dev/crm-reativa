import { Tela, IndicadorCard, AnelProgresso, RaioReativa, moeda, num, statusMeta, statusRitmo, T, fs } from "./tvUI";

// =============================================================================
// TV ReATIVA — TELA "MAGIC NUMBER" (dedicada)
// -----------------------------------------------------------------------------
// Arquivo próprio exportando SÓ o componente, pelo mesmo motivo de
// tvMetaDoMes.jsx: em tvTelas.jsx cada tela soma um erro de react-refresh na
// catraca de lint do CI.
// =============================================================================

// O Magic Number é um VALOR PRÓPRIO da competência, não um múltiplo da meta.
// Vinha sendo derivado de dois jeitos incompatíveis — meta x 1,5 nesta tela e
// "honorários do mês anterior" no card 'magic' de snap.metas — e nenhum dos
// dois bate com o que a gestão combina. Em outubro/2026: piso R$ 122.400,00,
// Magic R$ 142.800,00.
//
//   • alvo       -> snap.magic.valor    (magic_number_mensal da competência)
//   • realizado  -> snap.mes.honorarios (MESMA fonte oficial da meta piso:
//                                        soma dos honorários dos pagamentos do mês)
//   • dias úteis -> snap.mes.dias_uteis_restantes (generate_series sem sáb/dom)
//
// Falta, percentual e ritmo por dia útil são os únicos números que nascem aqui,
// porque o snapshot só pré-calcula esses recortes contra a meta piso. São
// subtração e divisão sobre dois valores que já vieram prontos — nenhuma regra
// financeira nova, nenhuma consulta, nenhum valor fixo.
export default function TelaMagicNumber({ snap }) {
  const alvo = Number(snap?.magic?.valor || 0);
  // Competência sem Magic Number cadastrado: avisa em vez de derivar da meta.
  if (!alvo) {
    return (
      <Tela titulo="Magic Number">
        <div style={vazio}>Magic Number não cadastrado para esta competência.</div>
      </Tela>
    );
  }

  const m = snap?.mes || {};
  const realizado = Number(m.honorarios || 0);
  const duRest = Number(m.dias_uteis_restantes ?? 0);
  const pct = Math.round((realizado / alvo) * 1000) / 10;
  const atingido = realizado >= alvo;
  const falta = Math.max(0, alvo - realizado);
  const porDia = atingido || duRest === 0 ? null : Math.round(falta / duRest);
  const proj = Number(m.proj_honorarios || 0);

  // Mesma régua do slide da meta piso: com o Magic batido a conquista fala por
  // si; senão vale o RITMO (projeção x alvo), não o percentual puro, que no
  // começo do mês acusaria "Abaixo do ritmo" em quem está adiantado.
  const status = atingido ? statusMeta(pct) : proj > 0 ? statusRitmo(proj, alvo) : undefined;

  return (
    <Tela titulo="Magic Number">
      <div style={corpo}>
        <AnelProgresso pct={pct} rotulo="do Magic Number" status={status} tamanho={ALTURA_BLOCO}>
          <RaioReativa tamanho={fs(30, 3.4, 78)} />
        </AnelProgresso>

        <div style={grade}>
          <IndicadorCard rotulo="Realizado" valor={moeda(realizado)} tom="verde" />
          <IndicadorCard rotulo="Falta para o Magic"
            valor={atingido ? "Magic batido" : moeda(falta)} tom={atingido ? "verde" : "ambar"} />
          <IndicadorCard rotulo="Dias úteis restantes" valor={num(duRest)}
            sub={m.dias_uteis_mes == null ? undefined : `de ${num(m.dias_uteis_mes)} dias úteis no mês`} tom="azul" />
          <IndicadorCard rotulo="Necessário por dia útil"
            valor={atingido ? "Magic batido" : porDia == null ? "Sem dias úteis restantes" : moeda(porDia)}
            tom={atingido ? "verde" : "ambar"} />
        </div>
      </div>

      <div style={rodape}>
        <span><strong style={{ color: T.texto }}>Magic Number</strong> {moeda(alvo)}</span>
        {Number(m.meta_empresa || 0) > 0 && (
          <>
            <span style={sep}>·</span>
            <span><strong style={{ color: T.texto }}>Meta do mês</strong> {moeda(m.meta_empresa)}</span>
          </>
        )}
        {proj > 0 && (
          <>
            <span style={sep}>·</span>
            <span>
              <strong style={{ color: T.texto }}>Projeção de fechamento</strong> {moeda(proj)}
              {` (${Math.round((proj / alvo) * 100)}% do Magic)`}
            </span>
          </>
        )}
      </div>
    </Tela>
  );
}

const ALTURA_BLOCO = "min(44vh, 30vw)";
const corpo = {
  display: "flex", alignItems: "center", justifyContent: "center",
  gap: "clamp(18px, 3.2vw, 70px)", width: "100%", flex: "0 0 auto", minHeight: 0, flexWrap: "nowrap",
};
const grade = {
  display: "grid", gridTemplateColumns: "1fr 1fr", gap: "clamp(10px, 1.4vw, 28px)",
  flex: "1 1 auto", maxWidth: "60vw", minWidth: 0,
};
const rodape = {
  display: "flex", alignItems: "baseline", justifyContent: "center", flexWrap: "wrap",
  gap: "0.9vw", flex: "0 0 auto", fontSize: fs(12, 1.25, 28), fontWeight: 600, color: T.textoSuave,
};
const sep = { color: "rgba(148,163,184,0.5)" };
const vazio = {
  fontSize: fs(16, 1.7, 42), color: T.textoMudo, fontWeight: 600, textAlign: "center",
};
