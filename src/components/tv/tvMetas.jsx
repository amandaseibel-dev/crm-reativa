import { Tela, IndicadorCard, AnelProgresso, RaioReativa, BarraProgresso, corSituacao, moeda, T, fs, layout } from "./tvUI";

// =============================================================================
// TV ReATIVA — TELA "METAS" (apresentação modernizada)
// -----------------------------------------------------------------------------
// SÓ A APRESENTAÇÃO MUDOU. Os números continuam vindo prontos de snap.metas,
// montados por _tv_meta_obj() dentro de tv_snapshot_calcular(): alvo, realizado,
// pct, restante, situacao e ritmo_necessario já chegam calculados. Nenhuma conta
// nasce aqui, nenhum snapshot ou RPC foi tocado.
//
// O modelo antigo empilhava um CardMeta por meta — três barras horizontais
// iguais, sem hierarquia: de longe não dava para saber qual número importava.
// Agora a meta do mês é o número-herói no anel (mesma linguagem das telas
// "Meta do Mês" e "Magic Number"), com meta, realizado e falta em cards ao
// lado, e as demais metas viram uma faixa compacta embaixo.
//
// O "Marco histórico" segue fora: é um acumulado de R$ 3 mi já batido, que não
// traz referência do mês e confundia quem assistia (decisão da gestão em
// 11/09/2026). Arquivo próprio exportando só o componente, pelo mesmo motivo de
// tvMetaDoMes.jsx: em tvTelas.jsx cada tela soma um erro de react-refresh na
// catraca de lint do CI.
// =============================================================================

// A meta da empresa é a principal; sem ela, a primeira da lista assume o anel.
function escolherPrincipal(metas) {
  return metas.find((m) => m?.id === "empresa") || metas[0] || null;
}

export default function TelaMetas({ snap }) {
  const metas = (snap?.metas || []).filter((m) => m && m.id !== "marco");
  const principal = escolherPrincipal(metas);

  if (!principal) {
    return (
      <Tela titulo="Metas" icone="🎯">
        <div style={vazio}>Sem registro no snapshot atual.</div>
      </Tela>
    );
  }

  const secundarias = metas.filter((m) => m.id !== principal.id);
  const pct = principal.pct == null ? null : Number(principal.pct);
  const atingida = principal.atingida === true;
  // `situacao` já vem pronta do snapshot ("Meta atingida", "No ritmo",
  // "Atenção", "Abaixo do ritmo") e é a régua honesta: ela compara a PROJEÇÃO
  // com o alvo, não o percentual puro. O anel só a reaproveita.
  const status = { label: principal.situacao, cor: corSituacao(principal.situacao) };

  return (
    <Tela titulo="Metas" icone="🎯">
      <div style={corpo}>
        <AnelProgresso pct={pct} rotulo={principal.nome} status={status} tamanho={ALTURA_BLOCO}>
          <RaioReativa tamanho={fs(30, 3.4, 78)} />
        </AnelProgresso>

        <div style={grade}>
          <IndicadorCard rotulo="Meta do mês" valor={moeda(principal.alvo)} tom="azul" />
          <IndicadorCard rotulo="Realizado" valor={moeda(principal.realizado)} tom="verde" />
          <IndicadorCard
            rotulo={atingida ? "Superamos em" : "Falta para a meta"}
            valor={moeda(atingida ? principal.excedente : principal.restante)}
            sub={
              atingida
                ? principal.data_atingimento ? `Atingida em ${principal.data_atingimento}` : undefined
                : principal.ritmo_necessario == null
                  ? "Sem dias úteis restantes"
                  : `${moeda(principal.ritmo_necessario)} por dia útil`
            }
            tom={atingida ? "verde" : "ambar"}
          />
        </div>
      </div>

      {secundarias.length > 0 && (
        <div style={faixa}>
          {secundarias.map((m) => <MetaCompacta key={m.id} meta={m} />)}
        </div>
      )}
    </Tela>
  );
}

// Meta secundária: nome, percentual, barra e o quanto falta — numa linha só.
// Nunca depende de cor: o rótulo textual de `situacao` acompanha sempre.
function MetaCompacta({ meta }) {
  const cor = corSituacao(meta.situacao);
  const pct = meta.pct == null ? null : Number(meta.pct);
  const atingida = meta.atingida === true;
  return (
    <div style={{ ...layout.card, flex: "1 1 0", minWidth: 0, gap: "0.8vh" }}>
      <div style={linhaTopo}>
        <span style={{ fontSize: fs(13, 1.35, 30), fontWeight: 800, color: T.texto }}>{meta.nome}</span>
        <span style={{ ...layout.selo, color: cor, borderColor: cor }}>{meta.situacao}</span>
      </div>
      <div style={linhaValor}>
        <span style={{ fontSize: fs(20, 2.3, 54), fontWeight: 900, lineHeight: 1, color: cor, whiteSpace: "nowrap" }}>
          {pct == null ? "—" : `${Math.round(pct)}%`}
        </span>
        <span style={{ fontSize: fs(12, 1.2, 26), color: T.textoSuave, fontWeight: 600 }}>
          {moeda(meta.realizado)} de {moeda(meta.alvo)}
        </span>
      </div>
      <BarraProgresso
        pct={pct}
        tom={atingida ? "verde" : meta.situacao === "No ritmo" ? "verde" : meta.situacao === "Atenção" ? "ambar" : "vermelho"}
        altura="1.2vh"
      />
      <div style={{ fontSize: fs(12, 1.2, 26), color: T.textoSuave, fontWeight: 700 }}>
        {atingida
          ? <>Superamos em <strong style={{ color: T.verde }}>{moeda(meta.excedente)}</strong></>
          : <>Falta <strong style={{ color: cor }}>{moeda(meta.restante)}</strong>
              {meta.ritmo_necessario != null && <> · {moeda(meta.ritmo_necessario)}/dia útil</>}</>}
      </div>
    </div>
  );
}

// Anel e cards formam um bloco de altura natural; o <Tela> centraliza bloco e
// faixa juntos. Mesmas medidas de tvMetaDoMes.jsx para os slides não "pularem"
// de tamanho quando o carrossel troca de tela.
const ALTURA_BLOCO = "min(40vh, 27vw)";
const corpo = {
  display: "flex", alignItems: "center", justifyContent: "center",
  gap: "clamp(18px, 3.2vw, 70px)", width: "100%", flex: "0 0 auto", minHeight: 0, flexWrap: "nowrap",
};
const grade = {
  display: "grid", gridTemplateColumns: "1fr", gap: "clamp(8px, 1.1vw, 20px)",
  flex: "1 1 auto", maxWidth: "52vw", minWidth: 0,
};
const faixa = {
  display: "flex", gap: "clamp(10px, 1.4vw, 28px)", justifyContent: "center",
  width: "min(88vw, 1600px)", flex: "0 0 auto", flexWrap: "nowrap",
};
const linhaTopo = {
  display: "flex", justifyContent: "space-between", alignItems: "baseline",
  gap: "1vw", flexWrap: "wrap",
};
const linhaValor = {
  display: "flex", alignItems: "baseline", gap: "1vw", flexWrap: "wrap",
};
const vazio = {
  fontSize: fs(16, 1.7, 42), color: T.textoMudo, fontWeight: 600, textAlign: "center",
};
