import { Tela, IndicadorCard, AnelProgresso, RaioReativa, moeda, num, statusMeta, statusRitmo, T, fs } from "./tvUI";

// =============================================================================
// TV ReATIVA — TELA "META DO MÊS" (dedicada)
// -----------------------------------------------------------------------------
// Arquivo próprio e exportando SÓ o componente: tvTelas.jsx tem exports que não
// são componentes (CATALOGO_TELAS etc.), então toda tela declarada lá soma um
// erro de react-refresh na catraca de lint do CI. Aqui, zero.
// =============================================================================

// Todos os números chegam PRONTOS em snap.mes (gerado por tv_snapshot_calcular),
// a mesma fonte do slide "Resultado do Mês": a meta é metas_projecao.meta_honorario
// da competência e o realizado é a soma dos honorários dos pagamentos do mês.
// Nada é recalculado aqui e nenhum valor é fixo no código.
//   • % atingido       -> mes.meta_pct             (realizado / meta)
//   • falta            -> mes.meta_falta           (meta - realizado)
//   • por dia útil     -> mes.necessidade_diaria   (falta / dias úteis restantes)
//   • dias úteis       -> mes.dias_uteis_restantes (generate_series sem sáb/dom)
//   • projeção         -> mes.proj_honorarios      (ritmo por dia útil transcorrido)
//
// ESTA TELA É SÓ DA META PISO. O Magic Number tem valor próprio por competência
// (magic_number_mensal) e tela própria — ver tvMagicNumber.jsx. Nenhum fator
// multiplica a meta aqui: em outubro/2026 o piso é R$ 122.400,00 e o Magic é
// R$ 142.800,00, uma relação que nenhum fator fixo reproduz.

export default function TelaMetaDoMes({ snap }) {
  const m = snap?.mes || {};
  const meta = Number(m.meta_empresa || 0);
  // Sem meta cadastrada no mês não há percentual honesto: avisa, não mostra 0%.
  if (!meta) {
    return (
      <Tela titulo="Meta do Mês" icone="⚡">
        <div style={vazio}>Meta de honorário do mês não cadastrada nesta atualização.</div>
      </Tela>
    );
  }

  const realizado = Number(m.honorarios || 0);
  const pct = m.meta_pct == null ? null : Number(m.meta_pct);
  const falta = Number(m.meta_falta ?? 0);
  const atingida = m.meta_atingida === true;
  const duRest = Number(m.dias_uteis_restantes ?? 0);
  const nec = m.necessidade_diaria;
  // Projeção só entra quando o snapshot trouxe o número (ritmo do mês). Ausente
  // ou zero => o rodapé simplesmente não cita projeção, em vez de exibir R$ 0.
  const proj = Number(m.proj_honorarios || 0);
  const projPct = m.proj_honorarios_pct == null ? null : Number(m.proj_honorarios_pct);

  // Régua do selo: com meta batida, a conquista fala por si; sem meta batida,
  // o que importa é se o RITMO leva lá no fim do mês — percentual puro acusaria
  // "Abaixo do ritmo" no dia 2 de quem está adiantado. Sem projeção no
  // snapshot, cai no percentual puro (statusMeta), que é o padrão do anel.
  const status = atingida ? statusMeta(pct) : proj > 0 ? statusRitmo(proj, meta) : undefined;

  const faltaTxt = atingida ? "Meta atingida" : moeda(falta);
  const necTxt = atingida
    ? "Meta atingida"
    : nec == null || duRest === 0
      ? "Sem dias úteis restantes"
      : moeda(nec);

  return (
    <Tela titulo="Meta do Mês" icone="⚡">
      <div style={corpo}>
        <AnelProgresso pct={pct} rotulo="da meta do mês" status={status} tamanho={ALTURA_BLOCO}>
          <RaioReativa tamanho={fs(30, 3.4, 78)} />
        </AnelProgresso>

        <div style={grade}>
          {/* `grande` não entra: ele fixa minWidth 30vw e duas colunas assim
              estouram a área segura da TV. O anel já é o número-herói. */}
          <IndicadorCard rotulo="Realizado" valor={moeda(realizado)} tom="verde" />
          <IndicadorCard rotulo="Falta para a meta" valor={faltaTxt} tom={atingida ? "verde" : "ambar"} />
          <IndicadorCard rotulo="Dias úteis restantes" valor={num(duRest)}
            sub={m.dias_uteis_mes == null ? undefined : `de ${num(m.dias_uteis_mes)} dias úteis no mês`} tom="azul" />
          <IndicadorCard rotulo="Necessário por dia útil" valor={necTxt}
            tom={atingida ? "verde" : "ambar"} />
        </div>
      </div>

      <div style={rodapeMeta}>
        <span><strong style={{ color: T.texto }}>Meta do mês</strong> {moeda(meta)}</span>
        {proj > 0 && (
          <>
            <span style={sep}>·</span>
            <span>
              <strong style={{ color: T.texto }}>Projeção de fechamento</strong> {moeda(proj)}
              {projPct != null && ` (${Math.round(projPct)}% da meta)`}
            </span>
          </>
        )}
      </div>
    </Tela>
  );
}

const corpo = {
  display: "flex", alignItems: "center", justifyContent: "center",
  gap: "clamp(18px, 3.2vw, 70px)", width: "100%", flex: "0 0 auto", minHeight: 0, flexWrap: "nowrap",
};
// Anel e cards formam um bloco de altura natural; o <Tela> centraliza bloco e
// rodapé juntos, sem buraco entre o conteúdo e a linha secundária.
const ALTURA_BLOCO = "min(44vh, 30vw)";
const grade = {
  display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr",
  gap: "clamp(10px, 1.4vw, 28px)", flex: "1 1 auto", maxWidth: "60vw", minWidth: 0,
};
const rodapeMeta = {
  display: "flex", alignItems: "baseline", justifyContent: "center", flexWrap: "wrap",
  gap: "0.9vw", flex: "0 0 auto", fontSize: fs(12, 1.25, 28), fontWeight: 600, color: T.textoSuave,
};
const sep = { color: "rgba(148,163,184,0.5)" };

const vazio = {
  fontSize: fs(16, 1.7, 42), color: T.textoMudo, fontWeight: 600, textAlign: "center",
};
