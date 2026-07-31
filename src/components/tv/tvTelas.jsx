import {
  Tela, IndicadorCard, MetaCard, Ranking, DestaqueOperador,
  MensagemInstitucional, Aviso, Treinamento, Conquista,
  moeda, num, statusRitmo, T, fs, layout,
} from "./tvUI";

// =============================================================================
// TV ReATIVA — TELAS (Etapa 2, estrutura)
// -----------------------------------------------------------------------------
// Cada tela recebe o payload do snapshot por PROPS e monta os componentes
// reutilizáveis. NENHUMA consulta ao banco. Onde a regra específica ainda não
// foi definida (Etapa 3+), há um placeholder claro em vez de dado inventado.
//
// Cada entrada de CATALOGO_TELAS = { id, nome, Comp }. O orquestrador percorre
// esse catálogo para montar o carrossel.
// =============================================================================

const linha = layout.linhaCards;

// 1) Hoje na Operação ---------------------------------------------------------
function TelaHoje({ snap }) {
  const d = snap?.dados || {};
  const rank = snap?.rank || {};
  const topDia = (rank.top_dia || [])[0];
  return (
    <Tela titulo="Hoje na Operação" icone="⚡">
      <div style={linha}>
        <IndicadorCard rotulo="Recuperado hoje" valor={moeda(d.recuperado_dia)} tom="verde" grande />
        <IndicadorCard rotulo="Honorários hoje" valor={moeda(d.honorarios_dia)} tom="azul" grande />
      </div>
      <div style={linha}>
        <IndicadorCard rotulo="Alunos recuperados hoje" valor={num(d.alunos_pagos_dia)} tom="ambar" />
        <DestaqueOperador rotulo="Destaque de acionamentos" nome={topDia?.nome} valor={topDia?.qtd != null ? `${num(topDia.qtd)} acionamentos` : null} icone="📞" />
      </div>
    </Tela>
  );
}

// 2) Resultado do Mês ---------------------------------------------------------
function TelaResultadoMes({ snap }) {
  const d = snap?.dados || {};
  const p = snap?.proj || {};
  const mp = d.maior_pagamento;
  return (
    <Tela titulo="Resultado do Mês" icone="📊">
      <div style={linha}>
        <IndicadorCard rotulo="Honorários no mês" valor={moeda(p.honorarios_mes)} tom="verde" grande />
        <IndicadorCard rotulo="Recuperado no mês" valor={moeda(p.recuperado_mes)} tom="azul" grande />
      </div>
      <div style={linha}>
        <IndicadorCard rotulo="Alunos recuperados no mês" valor={num(d.alunos_pagos_mes)} tom="ambar" />
        {mp && <DestaqueOperador rotulo="Maior pagamento do mês" nome={mp.operador} valor={moeda(mp.valor)} icone="💰" />}
      </div>
    </Tela>
  );
}

// 3) Metas --------------------------------------------------------------------
function TelaMetas({ snap }) {
  const p = snap?.proj || {};
  const pctCampanha = p.honorarios_mes != null ? Math.round((Number(p.honorarios_mes) / 500000) * 100) : null;
  return (
    <Tela titulo="Metas" icone="🎯">
      <MetaCard
        titulo="Meta de honorários do mês"
        valor={moeda(p.honorarios_mes)}
        alvo={p.meta ? moeda(p.meta) : null}
        pct={p.pct_meta}
        detalhe={p.falta != null ? `Falta ${moeda(p.falta)} · precisa ${moeda(p.precisa_por_dia)}/dia em ${p.dias_restantes} dia(s) úteis` : null}
      />
      <MetaCard
        titulo="Campanha do mês — R$ 500 mil"
        valor={moeda(p.honorarios_mes)}
        alvo={moeda(500000)}
        pct={pctCampanha}
      />
    </Tela>
  );
}

// 4) Rankings e Destaques -----------------------------------------------------
function TelaRankings({ snap }) {
  const d = snap?.dados || {};
  // ranking_mes/semana vêm como {operador, pagos}; normaliza p/ o componente.
  const mes = (d.ranking_mes || []).map((o) => ({ nome: o.operador, valor: `${num(o.pagos)} pgtos` }));
  return (
    <Tela titulo="Rankings e Destaques" icone="🏆">
      <Ranking titulo="Melhores do mês (alunos recuperados)" itens={mes} podio />
    </Tela>
  );
}

// 5) Hall da Fama -------------------------------------------------------------
function TelaHallFama({ snap }) {
  const d = snap?.dados || {};
  const rank = snap?.rank || {};
  const topMes = (rank.top_mes || [])[0];
  const mp = d.maior_pagamento;
  return (
    <Tela titulo="Hall da Fama" icone="👑">
      <div style={linha}>
        {topMes && <Conquista titulo={topMes.nome} valor={`${num(topMes.qtd)} acionamentos`} subtitulo="Mais acionamentos no mês" icone="👑" />}
        {mp && <Conquista titulo={mp.operador} valor={moeda(mp.valor)} subtitulo={`Maior pagamento do mês · ${mp.quando}`} icone="💎" />}
      </div>
      {!topMes && !mp && <div style={{ color: T.textoMudo, fontSize: fs(16, 1.6, 40) }}>Os grandes marcos aparecerão aqui.</div>}
    </Tela>
  );
}

// 6) Treinamento --------------------------------------------------------------
function TelaTreinamento({ snap, indiceGiro = 0 }) {
  const dicas = snap?.dicas || [];
  if (dicas.length === 0) {
    return (
      <Tela titulo="Treinamento" icone="🎓">
        <Treinamento categoria="Dica do dia" titulo="Conteúdos de treinamento aparecerão aqui." />
      </Tela>
    );
  }
  const dica = dicas[indiceGiro % dicas.length];
  return (
    <Tela titulo="Treinamento" icone="🎓">
      <Treinamento categoria={dica.categoria} titulo={dica.titulo} texto={dica.texto} />
    </Tela>
  );
}

// 7) Reconhecimento (elogios de atendimento) ---------------------------------
function TelaReconhecimento({ snap, elogioUrl, indiceGiro = 0 }) {
  const elogios = snap?.elogios || [];
  if (elogios.length === 0) {
    return (
      <Tela titulo="Reconhecimento" icone="💙">
        <MensagemInstitucional badge="Reconhecimento" titulo="Aqui celebramos os elogios da nossa equipe." />
      </Tela>
    );
  }
  const e = elogios[indiceGiro % elogios.length];
  return (
    <Tela titulo="Reconhecimento" icone="💙">
      <Conquista titulo={e.registrado_por_nome || "Equipe ReATIVA"} subtitulo="Elogio de atendimento" imagemUrl={elogioUrl} icone="💙" />
    </Tela>
  );
}

// 8) Aniversariantes ----------------------------------------------------------
function TelaAniversariantes({ snap }) {
  const aniv = snap?.aniversariantes || [];
  return (
    <Tela titulo="Aniversariantes do Mês" icone="🎂">
      {aniv.length === 0 ? (
        <div style={{ color: T.textoMudo, fontSize: fs(16, 1.6, 40) }}>Sem aniversariantes neste mês.</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2vh 3vw", justifyContent: "center", width: "84%" }}>
          {aniv.map((a, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: "1vw", fontSize: fs(20, 2.2, 60), fontWeight: 800, color: T.texto }}>
              <span>🎉</span><span>{a.nome}</span>
              <span style={{ color: T.azulClaro, fontWeight: 900 }}>dia {a.dia}</span>
            </div>
          ))}
        </div>
      )}
    </Tela>
  );
}

// 9) Avisos -------------------------------------------------------------------
function TelaAvisos({ snap }) {
  const msg = snap?.mensagem_especial;
  return (
    <Tela titulo="Avisos" icone="📣">
      {msg && (msg.titulo || msg.texto) ? (
        <Aviso nivel="info" titulo={msg.titulo || "Comunicado"} texto={msg.texto} />
      ) : (
        <div style={{ color: T.textoMudo, fontSize: fs(16, 1.6, 40) }}>Nenhum aviso ativo no momento.</div>
      )}
    </Tela>
  );
}

// 10) Modo Fechamento ---------------------------------------------------------
function TelaFechamento({ snap }) {
  const p = snap?.proj || {};
  const st = statusRitmo(Number(p.proj_honorarios || 0), Number(p.meta || 0));
  return (
    <Tela titulo="Modo Fechamento" icone="🏁">
      <MensagemInstitucional
        badge="Projeção de fechamento"
        titulo={moeda(p.proj_honorarios)}
        texto={`Recuperação projetada: ${moeda(p.proj_recuperado)} · ${p.dias_restantes} dia(s) úteis restantes`}
      />
      <div style={{ ...layout.selo, fontSize: fs(18, 2, 48), color: st.cor, borderColor: st.cor, padding: "1vh 2.4vw" }}>{st.label}</div>
    </Tela>
  );
}

// Catálogo do carrossel (ordem de exibição) ----------------------------------
export const CATALOGO_TELAS = [
  { id: "hoje", nome: "Hoje na Operação", Comp: TelaHoje },
  { id: "resultado", nome: "Resultado do Mês", Comp: TelaResultadoMes },
  { id: "metas", nome: "Metas", Comp: TelaMetas },
  { id: "rankings", nome: "Rankings e Destaques", Comp: TelaRankings },
  { id: "hall", nome: "Hall da Fama", Comp: TelaHallFama },
  { id: "treinamento", nome: "Treinamento", Comp: TelaTreinamento },
  { id: "reconhecimento", nome: "Reconhecimento", Comp: TelaReconhecimento },
  { id: "aniversariantes", nome: "Aniversariantes", Comp: TelaAniversariantes },
  { id: "avisos", nome: "Avisos", Comp: TelaAvisos },
  { id: "fechamento", nome: "Modo Fechamento", Comp: TelaFechamento },
];
