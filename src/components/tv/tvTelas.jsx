import {
  Tela, IndicadorCard, CardMeta, Ranking, DestaqueOperador,
  MensagemInstitucional, Aviso, Treinamento, Conquista,
  moeda, num, statusRitmo, T, fs, layout,
} from "./tvUI";

// =============================================================================
// TV ReATIVA — TELAS (Etapa 3: regras detalhadas)
// -----------------------------------------------------------------------------
// TODA conta já vem PRONTA do snapshot (gerada no "Atualizar projeção"). Aqui só
// se LÊ e EXIBE — nenhuma consulta ao banco, nenhum cálculo pesado.
// Onde falta dado, usa mensagem padronizada (nunca zero enganoso/placeholder).
// =============================================================================

const linha = layout.linhaCards;
const SR = "Sem registro"; // rótulo padrão p/ indicador inexistente

function Vazio({ children }) {
  return <div style={{ fontSize: fs(16, 1.7, 42), color: T.textoMudo, fontWeight: 600, textAlign: "center" }}>{children}</div>;
}

// 1) Hoje na Operação ---------------------------------------------------------
function TelaHoje({ snap }) {
  const h = snap?.hoje || {};
  if (h.sem_pagamentos) {
    return (
      <Tela titulo="Hoje na Operação" icone="⚡">
        <Vazio>Ainda não há pagamentos confirmados no snapshot atual.</Vazio>
      </Tela>
    );
  }
  const mp = h.maior_pagamento;
  const tr = h.top_recuperador;
  const tq = h.top_qtd;
  return (
    <Tela titulo="Hoje na Operação" icone="⚡">
      <div style={linha}>
        <IndicadorCard rotulo="Recuperado hoje" valor={moeda(h.recuperado)} tom="verde" grande />
        <IndicadorCard rotulo="Honorários hoje" valor={moeda(h.honorarios)} tom="azul" grande />
      </div>
      <div style={linha}>
        <IndicadorCard rotulo="Pagamentos confirmados hoje" valor={num(h.pagamentos_confirmados)} tom="ambar" />
        <DestaqueOperador rotulo="Maior pagamento do dia" nome={mp ? mp.operador : SR} valor={mp ? moeda(mp.valor) : null} icone="💰" />
      </div>
      <div style={linha}>
        <DestaqueOperador rotulo="Maior valor recuperado hoje" nome={tr ? tr.operador : SR} valor={tr ? moeda(tr.valor) : null} icone="⭐" />
        <DestaqueOperador rotulo="Mais pagamentos confirmados hoje" nome={tq ? tq.operador : SR} valor={tq ? `${num(tq.qtd)} pagamentos` : null} icone="🎯" />
      </div>
    </Tela>
  );
}

// 2) Resultado do Mês ---------------------------------------------------------
function TelaResultadoMes({ snap }) {
  const m = snap?.mes || {};
  const cmp = m.comparacao || {};
  const necTxt = m.meta_atingida
    ? "Meta já atingida."
    : m.necessidade_diaria == null
      ? "Sem dias úteis restantes."
      : `${moeda(m.necessidade_diaria)}/dia útil`;
  return (
    <Tela titulo="Resultado do Mês" icone="📊">
      <div style={linha}>
        <IndicadorCard rotulo="Recuperado no mês" valor={moeda(m.recuperado)} tom="verde" grande />
        <IndicadorCard rotulo="Honorários no mês" valor={moeda(m.honorarios)} tom="azul" grande />
      </div>
      <div style={linha}>
        <IndicadorCard rotulo="Pagamentos confirmados no mês" valor={num(m.pagamentos_confirmados)} tom="ambar" />
        <IndicadorCard rotulo="Média diária de recuperação" valor={moeda(m.media_diaria)} tom="azul" />
        <IndicadorCard rotulo="Projeção de fechamento" valor={moeda(m.projecao_fechamento)} tom="verde" />
      </div>
      <div style={linha}>
        <IndicadorCard rotulo={`Dias úteis (${m.dias_uteis_transcorridos}/${m.dias_uteis_mes})`} valor={`${m.dias_uteis_restantes} restantes`} tom="azul" />
        <IndicadorCard rotulo="Necessário por dia útil" valor={necTxt} tom={m.meta_atingida ? "verde" : "ambar"} />
      </div>
      <Vazio>{m.estimativa_aviso || "Projeção estimada com base no ritmo atual."}</Vazio>
    </Tela>
  );
}

// 3) Metas --------------------------------------------------------------------
function TelaMetas({ snap }) {
  const metas = snap?.metas || [];
  return (
    <Tela titulo="Metas" icone="🎯">
      {metas.length === 0 ? <Vazio>Sem registro no snapshot atual.</Vazio>
        : metas.map((meta) => <CardMeta key={meta.id} meta={meta} />)}
    </Tela>
  );
}

// 4) Julho Histórico (ativável por tv_config) ---------------------------------
function TelaJulhoHistorico({ snap }) {
  const j = snap?.julho_historico;
  if (!j?.ativo) return <Tela titulo="Julho Histórico" icone="🏅"><Vazio>Reconhecimento indisponível nesta atualização.</Vazio></Tela>;
  const metas = j.metas || [];
  return (
    <Tela titulo={j.titulo || "Julho Histórico"} icone="🏅">
      <div style={{ fontSize: fs(18, 2.2, 52), fontWeight: 800, color: T.texto, textAlign: "center", maxWidth: "80vw", lineHeight: 1.2 }}>
        {j.texto_principal}
      </div>
      <div style={{ display: "flex", gap: "1.6vw", justifyContent: "center", width: "100%", flexWrap: "nowrap" }}>
        {metas.map((mt, i) => (
          <div key={i} style={{ ...layout.card, flex: "1 1 0", alignItems: "center", textAlign: "center", gap: "0.6vh", minWidth: 0 }}>
            <div style={{ fontSize: fs(24, 3, 60) }}>✅</div>
            <div style={{ fontSize: fs(15, 1.6, 36), fontWeight: 800, color: T.texto }}>{mt.nome}</div>
            <div style={{ fontSize: fs(24, 3, 66), fontWeight: 900, color: T.verde }}>{mt.pct}%</div>
            <div style={{ fontSize: fs(12, 1.2, 26), color: T.textoSuave, fontWeight: 600 }}>{moeda(mt.realizado)} · excedente {moeda(mt.excedente)}</div>
          </div>
        ))}
      </div>
      {j.texto_complementar && <div style={{ fontSize: fs(13, 1.4, 30), color: T.textoMudo, fontWeight: 600, textAlign: "center", maxWidth: "80vw" }}>{j.texto_complementar}</div>}
    </Tela>
  );
}

// 5) Rankings e Destaques -----------------------------------------------------
function TelaRankings({ snap }) {
  const r = snap?.rankings || {};
  const top3 = r.top3_mes || [];
  const mpm = r.maior_pagamento_mes;
  return (
    <Tela titulo="Rankings e Destaques" icone="🏆">
      <div style={linha}>
        {r.melhor_dia?.operador && <DestaqueOperador rotulo="Melhor recuperador do dia" nome={r.melhor_dia.operador} icone="🌟" />}
        {r.melhor_mes?.operador && <DestaqueOperador rotulo="Melhor recuperador do mês" nome={r.melhor_mes.operador} icone="👑" />}
        {r.mais_pagos_dia?.operador && <DestaqueOperador rotulo="Mais pagamentos confirmados hoje" nome={r.mais_pagos_dia.operador} valor={`${num(r.mais_pagos_dia.qtd)} pagamentos`} icone="🎯" />}
      </div>
      {top3.length > 0 && <Ranking titulo="Top 3 do mês por valor recuperado" itens={top3.map((o) => ({ nome: o.operador }))} podio />}
      {mpm && <DestaqueOperador rotulo="Maior pagamento único do mês" nome={mpm.operador} valor={moeda(mpm.valor)} icone="💰" />}
    </Tela>
  );
}

// 6) Aniversariantes ----------------------------------------------------------
//    No dia exato (aniversariantes_hoje preenchido pelo snapshot) → destaque
//    individual com mensagem especial. Fora disso → card mensal. A regra do
//    "hoje" é decidida no snapshot; aqui só se exibe o estado gravado.
function TelaAniversariantes({ snap }) {
  const hoje = snap?.aniversariantes_hoje || [];
  if (hoje.length > 0) {
    const nomes = hoje.map((a) => a.nome);
    const nomeTxt = nomes.length === 1 ? nomes[0]
      : nomes.slice(0, -1).join(", ") + " e " + nomes[nomes.length - 1];
    const msg = `Hoje é dia de celebrar o(a) ${nomeTxt}. Parabéns pelo seu aniversário. Desejamos um novo ciclo de saúde, realizações e boas conquistas.`;
    return (
      <Tela titulo="Aniversário de Hoje" icone="🎉">
        <div style={{ fontSize: fs(34, 4.4, 96), lineHeight: 1 }}>🎂</div>
        <div style={{ fontSize: fs(26, 3.4, 80), fontWeight: 900, color: T.texto, textAlign: "center" }}>
          {nomeTxt}
        </div>
        <MensagemInstitucional badge="Parabéns!" titulo="Feliz aniversário!" texto={msg} />
      </Tela>
    );
  }
  const aniv = snap?.aniversariantes || [];
  return (
    <Tela titulo="Aniversariantes do Mês" icone="🎂">
      <MensagemInstitucional badge="Aniversariantes" titulo="Parabéns aos aniversariantes do mês"
        texto="Desejamos um novo ciclo de boas conquistas." />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2vh 3vw", justifyContent: "center", width: "84%" }}>
        {aniv.map((a, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: "1vw", fontSize: fs(20, 2.2, 60), fontWeight: 800, color: T.texto }}>
            <span>🎉</span><span>{a.nome}</span>
            {a.dia != null && <span style={{ color: T.azulClaro, fontWeight: 900 }}>dia {a.dia}</span>}
          </div>
        ))}
      </div>
    </Tela>
  );
}

// 7) Avisos (um aviso por tela; gira entre os ativos por ciclo) ---------------
function TelaAvisos({ snap, indiceGiro = 0 }) {
  const avisos = snap?.avisos || [];
  if (avisos.length === 0) return <Tela titulo="Avisos" icone="📣"><Vazio>Sem aviso ativo nesta atualização.</Vazio></Tela>;
  const a = avisos[indiceGiro % avisos.length];
  const nivel = a.prioridade >= 2 ? "critico" : a.prioridade === 1 ? "atencao" : "info";
  return (
    <Tela titulo="Avisos" icone="📣">
      <Aviso nivel={nivel} titulo={a.titulo || "Comunicado"} texto={a.mensagem} />
    </Tela>
  );
}

// --- Telas mantidas no código, DESATIVADAS até etapas futuras ---
function TelaHallFama({ snap }) {
  return <Tela titulo="Hall da Fama" icone="👑"><Vazio>Em breve.</Vazio></Tela>;
}
function TelaTreinamento() {
  return <Tela titulo="Treinamento" icone="🎓"><Vazio>Em breve.</Vazio></Tela>;
}
function TelaReconhecimento() {
  return <Tela titulo="Reconhecimento" icone="💙"><Vazio>Em breve.</Vazio></Tela>;
}
function TelaFechamento({ snap }) {
  return <Tela titulo="Modo Fechamento" icone="🏁"><Vazio>Em breve.</Vazio></Tela>;
}

// Catálogo do carrossel (ordem oficial da Etapa 3, §8) ------------------------
//   ativa       -> regra definitiva pronta (false = no código, oculta na TV)
//   temConteudo -> há dado válido no snapshot para exibir agora
// A TV monta o carrossel só com telas (ativa && temConteudo(snap)), sem buracos.
const sempre = () => true;
export const CATALOGO_TELAS = [
  { id: "hoje", nome: "Hoje na Operação", Comp: TelaHoje, ativa: true, temConteudo: (s) => !!s?.hoje },
  { id: "resultado", nome: "Resultado do Mês", Comp: TelaResultadoMes, ativa: true, temConteudo: (s) => !!s?.mes },
  { id: "metas", nome: "Metas", Comp: TelaMetas, ativa: true, temConteudo: (s) => (s?.metas || []).length > 0 },
  { id: "julho", nome: "Julho Histórico", Comp: TelaJulhoHistorico, ativa: true, temConteudo: (s) => s?.julho_historico?.ativo === true },
  { id: "rankings", nome: "Rankings e Destaques", Comp: TelaRankings, ativa: true, temConteudo: (s) => {
      const r = s?.rankings || {}; return !!(r.melhor_mes?.operador || (r.top3_mes || []).length > 0 || r.maior_pagamento_mes); } },
  { id: "aniversariantes", nome: "Aniversariantes", Comp: TelaAniversariantes, ativa: true, temConteudo: (s) => (s?.aniversariantes || []).length > 0 || (s?.aniversariantes_hoje || []).length > 0 },
  { id: "avisos", nome: "Avisos", Comp: TelaAvisos, ativa: true, temConteudo: (s) => (s?.avisos || []).length > 0 },
  // --- estrutura pronta, DESATIVADA (etapas futuras) ---
  { id: "hall", nome: "Hall da Fama", Comp: TelaHallFama, ativa: false, temConteudo: sempre },
  { id: "treinamento", nome: "Treinamento", Comp: TelaTreinamento, ativa: false, temConteudo: sempre },
  { id: "reconhecimento", nome: "Reconhecimento", Comp: TelaReconhecimento, ativa: false, temConteudo: sempre },
  { id: "fechamento", nome: "Modo Fechamento", Comp: TelaFechamento, ativa: false, temConteudo: sempre },
];

export function telasVisiveis(snap) {
  return CATALOGO_TELAS.filter((t) => t.ativa && t.temConteudo(snap));
}
