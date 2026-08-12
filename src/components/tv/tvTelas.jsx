import {
  Tela, IndicadorCard, CardMeta, MetaCard, Ranking, DestaqueOperador,
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

// Destaque de aniversário só aparece NO DIA exato (data local do painel, sem
// consultar o banco). data no formato 'YYYY-MM-DD'. Fora do dia → oculto.
function aniversarioDestaqueHoje(d) {
  if (!d || d.ativo === false || !d.data) return false;
  // Modo prévia: /tv?preview=1 força a exibição (para conferir antes do dia).
  // Não afeta a TV normal — sem o parâmetro, segue a trava de data.
  try {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("preview")) return true;
  } catch { /* ignore */ }
  const h = new Date();
  const iso = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, "0")}-${String(h.getDate()).padStart(2, "0")}`;
  return d.data === iso;
}

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
        <IndicadorCard rotulo="Projeção de fechamento (honorários)" valor={moeda(m.proj_honorarios)} tom="verde" />
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

// 3b) Premiação — faixas de comissão da competência (ganha desde o 1º pagamento)
function TelaPremiacao({ snap }) {
  const p = snap?.premiacao || {};
  const faixas = p.faixas || [];
  if (faixas.length === 0) {
    return <Tela titulo="Premiação" icone="🏅"><Vazio>Sem faixas cadastradas nesta atualização.</Vazio></Tela>;
  }
  const cores = [T.ambar, T.azulClaro, "#a78bfa", "#fb923c"]; // M1..M4
  return (
    <Tela titulo="Premiação do Mês" icone="🏅">
      <div style={{ fontSize: fs(15, 1.6, 40), fontWeight: 800, color: T.textoSuave, textAlign: "center", maxWidth: "82vw", lineHeight: 1.25 }}>
        Você premia <span style={{ color: T.ambar }}>desde o primeiro pagamento</span>. Quanto mais alto o honorário do mês, maior o percentual.
      </div>
      <div style={{ display: "flex", gap: "1.4vw", justifyContent: "center", width: "100%", flexWrap: "nowrap" }}>
        {faixas.map((f, i) => {
          const cor = cores[i] || T.azulClaro;
          const destaque = i === 0;
          const pctTxt = String(f.percentual).replace(".", ",");
          const sub = f.desde_primeiro
            ? `Desde o 1º pagamento${f.ate ? ` até ${moeda(f.ate)}` : ""}`
            : f.maxima ? `Máxima — passando de ${moeda(f.valor)}` : `Passando de ${moeda(f.valor)}`;
          return (
            <div key={i} style={{
              ...layout.card, flex: "1 1 0", minWidth: 0, alignItems: "flex-start", gap: "1vh",
              border: `1px solid ${destaque ? "rgba(251,191,36,0.5)" : T.surfaceBorda}`,
              background: destaque ? "linear-gradient(160deg, rgba(251,191,36,0.16), rgba(15,23,42,0.4))" : T.surface,
              position: "relative", overflow: "hidden",
            }}>
              <div style={{ position: "absolute", top: 0, left: 0, height: "4px", width: "100%", background: cor }} />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                <span style={{ fontSize: fs(14, 1.4, 32), fontWeight: 900, letterSpacing: "0.1em", color: T.textoMudo }}>{f.marco}</span>
                {destaque && <span style={{ fontSize: fs(10, 1, 20), fontWeight: 900, letterSpacing: "0.14em", color: T.ambar, textTransform: "uppercase" }}>Já premia</span>}
                {f.maxima && <span style={{ fontSize: fs(10, 1, 20), fontWeight: 900, letterSpacing: "0.14em", color: cor, textTransform: "uppercase" }}>Máxima</span>}
              </div>
              <div style={{ fontSize: fs(40, 5.4, 120), fontWeight: 900, lineHeight: 0.9, color: cor, textShadow: `0 0 34px ${cor}55` }}>
                {pctTxt}<span style={{ fontSize: "0.42em", fontWeight: 800 }}>%</span>
              </div>
              <div style={{ fontSize: fs(12, 1.25, 28), fontWeight: 700, color: T.textoSuave, lineHeight: 1.25 }}>{sub}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: fs(13, 1.4, 32), fontWeight: 800, color: T.texto }}>
        Todo pagamento já premia. Agora é subir de faixa 🚀
      </div>
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
        {mpm && <DestaqueOperador rotulo="Maior pagamento único do mês" nome={mpm.operador} valor={moeda(mpm.valor)} icone="💰" />}
      </div>
      {top3.length > 0 && <Ranking titulo="Top 3 do mês por valor recuperado" itens={top3.map((o) => ({ nome: o.operador }))} podio />}
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

// 7b) Destaque da semana — campeão da semana por pagamentos únicos -----------
function TelaDestaqueSemana({ snap }) {
  const semana = snap?.dados?.ranking_semana || [];
  if (semana.length === 0) return <Tela titulo="Destaque da Semana" icone="⭐"><Vazio>Sem dados da semana.</Vazio></Tela>;
  const campeao = semana[0];
  const vice = semana.slice(1, 3);
  return (
    <Tela titulo="Destaque da Semana" icone="⭐">
      <div style={{ fontSize: fs(30, 3.8, 90) }}>⭐</div>
      <div style={{ fontSize: fs(32, 4, 100), fontWeight: 900, color: T.verde, textAlign: "center", lineHeight: 1 }}>{campeao.operador}</div>
      <div style={{ fontSize: fs(14, 1.5, 34), fontWeight: 700, color: T.textoMudo, textTransform: "uppercase", letterSpacing: "0.08em" }}>
        Mais pagamentos únicos da semana
      </div>
      {vice.length > 0 && (
        <div style={{ display: "flex", gap: "3vw", marginTop: "1vh" }}>
          {vice.map((o, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.2vh" }}>
              <span style={{ fontSize: fs(13, 1.3, 28), fontWeight: 800, color: T.textoMudo }}>{i === 0 ? "🥈" : "🥉"}</span>
              <span style={{ fontSize: fs(16, 1.7, 44), fontWeight: 800, color: T.textoSuave }}>{o.operador}</span>
            </div>
          ))}
        </div>
      )}
    </Tela>
  );
}

// 7c) Acionamentos do dia — Top 3 com as quantidades -------------------------
function TelaAcionamentosDia({ snap }) {
  const top = snap?.rank?.top_dia || [];
  if (top.length === 0) return <Tela titulo="Acionamentos do Dia" icone="📞"><Vazio>Sem acionamentos registrados hoje.</Vazio></Tela>;
  return (
    <Tela titulo="Acionamentos do Dia — Top 3" icone="📞">
      <Ranking titulo="Quem mais acionou hoje" podio
        itens={top.map((o) => ({ nome: o.nome, valor: `${num(o.qtd)} acion.` }))} />
    </Tela>
  );
}

// 7d) Magic Number — meta de superação = 150% da meta de honorários ----------
//     Calculado no cliente a partir de mes.meta_empresa (não precisa backend).
function TelaMagicNumber({ snap }) {
  const m = snap?.mes || {};
  const meta = Number(m.meta_empresa || 0);
  if (!meta) return <Tela titulo="Magic Number" icone="✨"><Vazio>Meta não cadastrada nesta atualização.</Vazio></Tela>;
  const alvo = Math.round(meta * 1.5);
  const real = Number(m.honorarios || 0);
  const pct = alvo > 0 ? (real / alvo) * 100 : null;
  const falta = Math.max(0, alvo - real);
  const detalhe = real >= alvo
    ? "Magic batido! Superação total da meta 🚀"
    : `Faltam ${moeda(falta)} para o Magic (150% da meta)`;
  return (
    <Tela titulo="Magic Number" icone="✨">
      <MetaCard titulo="Magic Number — 150% da meta" valor={moeda(real)} alvo={moeda(alvo)} pct={pct} detalhe={detalhe} />
    </Tela>
  );
}

// 8) Elogios de atendimento (aprovados para a TV) ----------------------------
//    Fonte: snap.elogios (aluno_movimentacoes com elogio_aprovado_tv). Só TEXTO
//    — quem foi elogiado e quando. O print fica na aprovação; a TV celebra o nome.
function TelaElogios({ snap }) {
  const elogios = snap?.elogios || [];
  if (elogios.length === 0) return <Tela titulo="Elogios" icone="💙"><Vazio>Sem elogio aprovado nesta atualização.</Vazio></Tela>;
  return (
    <Tela titulo="Elogios ao Atendimento" icone="💙">
      <MensagemInstitucional badge="Reconhecimento" titulo="Elogio de quem foi bem atendido"
        texto="Cada elogio é um cliente que saiu satisfeito. Parabéns a quem fez acontecer." />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2vh 2vw", justifyContent: "center", width: "84%" }}>
        {elogios.slice(0, 6).map((e, i) => (
          <div key={e.id || i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.4vh",
            background: T.surface, border: `1px solid ${T.surfaceBorda}`, borderRadius: "1.2vh", padding: "1.6vh 2vw", minWidth: "22vw" }}>
            <span style={{ fontSize: fs(22, 2.6, 64), fontWeight: 900, color: T.texto }}>{e.registrado_por_nome || "Equipe"}</span>
            <span style={{ fontSize: fs(12, 1.2, 26), fontWeight: 700, color: T.textoMudo }}>💙 Elogio ao atendimento</span>
          </div>
        ))}
      </div>
    </Tela>
  );
}

// 9) Aniversário com destaque (foto + mensagem) ------------------------------
//    Fonte: snap.aniversario_destaque { nome, mensagem, foto, data }. A DATA
//    controla a exibição no cliente (só aparece no dia exato) — ver catálogo.
function TelaAniversarioDestaque({ snap }) {
  const d = snap?.aniversario_destaque;
  if (!d) return null;
  return (
    <Tela titulo="Aniversário de Hoje" icone="🎉">
      <div style={{ display: "flex", alignItems: "center", gap: "4vw", width: "84%", justifyContent: "center", flexWrap: "wrap" }}>
        {d.foto && (
          <img src={d.foto} alt={d.nome || "Aniversariante"}
            style={{ width: "min(32vh, 28vw)", height: "min(42vh, 38vw)", objectFit: "cover", objectPosition: "center 25%",
              borderRadius: "2.4vh", border: `0.5vh solid ${T.azulClaro}`, boxShadow: "0 0 40px rgba(59,130,246,0.5)" }} />
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.4vh", maxWidth: "44vw" }}>
          <div style={{ fontSize: fs(34, 4.4, 96) }}>🎂</div>
          <div style={{ fontSize: fs(30, 3.8, 92), fontWeight: 900, color: T.texto, lineHeight: 1 }}>{d.nome}</div>
          <div style={{ fontSize: fs(16, 1.8, 44), fontWeight: 700, color: T.textoSuave, lineHeight: 1.3 }}>
            {d.mensagem || "Feliz aniversário! Que seu dia seja especial."}
          </div>
        </div>
      </div>
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
  { id: "metas", nome: "Metas", Comp: TelaMetas, ativa: false, temConteudo: (s) => (s?.metas || []).length > 0 },
  { id: "premiacao", nome: "Premiação", Comp: TelaPremiacao, ativa: true, temConteudo: (s) => (s?.premiacao?.faixas || []).length > 0 },
  { id: "julho", nome: "Julho Histórico", Comp: TelaJulhoHistorico, ativa: true, temConteudo: (s) => s?.julho_historico?.ativo === true },
  { id: "rankings", nome: "Rankings e Destaques", Comp: TelaRankings, ativa: true, temConteudo: (s) => {
      const r = s?.rankings || {}; return !!(r.melhor_mes?.operador || (r.top3_mes || []).length > 0 || r.maior_pagamento_mes); } },
  { id: "aniversario_destaque", nome: "Aniversário (destaque)", Comp: TelaAniversarioDestaque, ativa: true, temConteudo: (s) => aniversarioDestaqueHoje(s?.aniversario_destaque) },
  { id: "aniversariantes", nome: "Aniversariantes", Comp: TelaAniversariantes, ativa: true, temConteudo: (s) => (s?.aniversariantes || []).length > 0 || (s?.aniversariantes_hoje || []).length > 0 },
  { id: "magic_number", nome: "Magic Number", Comp: TelaMagicNumber, ativa: true, temConteudo: (s) => Number(s?.mes?.meta_empresa || 0) > 0 },
  { id: "destaque_semana", nome: "Destaque da Semana", Comp: TelaDestaqueSemana, ativa: true, temConteudo: (s) => (s?.dados?.ranking_semana || []).length > 0 },
  { id: "acionamentos_dia", nome: "Acionamentos do Dia", Comp: TelaAcionamentosDia, ativa: true, temConteudo: (s) => (s?.rank?.top_dia || []).length > 0 },
  { id: "elogios", nome: "Elogios", Comp: TelaElogios, ativa: true, temConteudo: (s) => (s?.elogios || []).length > 0 },
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
