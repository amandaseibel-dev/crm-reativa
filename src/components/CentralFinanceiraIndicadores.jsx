// CENTRAL FINANCEIRA -- OS DOIS INDICADORES, LADO A LADO E SEM MISTURAR.
//
// ORDEM DA GESTAO, 20/10/2026, literal: "Na Central Financeira, mantenha dois
// indicadores distintos: conciliacao no CRM e baixa oficial no titulo/parcela.
// Nao considere status BAIXADO como prova suficiente de pagamento ou baixa
// oficial. Use essa distincao para desenhar a tela de conferencia." E tambem:
// "Nao implemente baixa automatica sem validacao oficial."
//
// ESTE PAINEL E SOMENTE LEITURA. Nenhum botao que escreve, nenhuma RPC, nenhum
// insert/update/delete, nenhuma baixa automatica. As unicas interacoes sao
// recarregar, mudar o periodo e filtrar por classe.
//
// POR QUE AS DUAS COLUNAS SAO VISUALMENTE DIFERENTES: as duas vinham sendo
// lidas como se fossem o mesmo numero. Sao fontes distintas --
// `pagamentos.status_conciliacao` (a opiniao do motor de importacao) e
// `baixas_pagamento` (a baixa com responsavel e data). A medicao de 20/10/2026
// mostra o tamanho do engano: na janela de 30 dias, 912 pagamentos estao
// BAIXADO no CRM e NAO tem baixa oficial viva -- R$ 726.945,72. Dar a mesma
// cor, a mesma coluna ou o mesmo rotulo para as duas e o que produzia esse erro.
//
// A TERCEIRA COLUNA, discreta de proposito: o estado da PARCELA. Em 1.235
// daqueles casos a parcela ja esta PAGO, baixada pelo gatilho de importacao --
// ou seja, o dinheiro chegou na obrigacao, mas ninguem assinou a baixa. E
// informacao de contexto, nao e a baixa oficial, e por isso nao disputa
// atencao com as duas colunas principais.
//
// SO PARA OS TRES E-MAILS DA GESTAO FINANCEIRA, pelo mesmo motivo do portao em
// FinanceiroHub: as views usam `security_invoker`, entao respeitam a RLS de
// quem consulta. Um operador pode ver o pagamento dele e NAO ver a parcela nem
// a baixa -- a coluna de baixa oficial leria "nao existe" por falta de
// visibilidade, e nao por falta de baixa. Mostrar isso a um operador seria
// fabricar exatamente a confusao que este painel existe para desfazer.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { buscarTudo } from "../utils/paginado";

const GESTAO_FINANCEIRA = [
  "amanda.seibel@aelbra.com.br",
  "cobranca04@aelbra.com.br",
  "cobranca07@aelbra.com.br",
];

const VISAO_INDICADORES = "vw_central_financeira_pagamento_indicadores";
const VISAO_EXCECOES = "vw_central_financeira_pagamento_excecoes";

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const curta = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "—");
const curtoHora = (d) => (d ? `${curta(d)} ${String(d).slice(11, 16)}` : "—");
const iso = (d) => d.toISOString().slice(0, 10);

// Janela padrao: os ultimos 30 dias. E a mesma janela da medicao que originou
// a frente, entao o numero da tela pode ser conferido contra o documento.
function janelaPadrao() {
  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { de: iso(inicio), ate: iso(hoje) };
}

// Ordem de risco declarada pela view. O rotulo aqui so repete o que a coluna
// `classe_rotulo` traz do banco -- a classificacao e do banco, nao da tela.
const CLASSES = [
  { chave: "BAIXADO_SEM_BAIXA_OFICIAL", rotulo: "BAIXADO no CRM, sem baixa oficial", risco: "CRITICO",
    dica: "O CRM diz que acabou e nao existe baixa oficial viva no titulo/parcela." },
  { chave: "BAIXA_DEVOLVIDA_SEM_NOVA", rotulo: "Baixa devolvida, sem baixa nova", risco: "ALTO",
    dica: "A baixa foi estornada e ninguem registrou outra depois." },
  { chave: "PARCELA_JA_PAGA", rotulo: "Parcela ja estava paga", risco: "ALTO",
    dica: "A conciliacao recusou porque a parcela ja constava paga: pode ser pagamento em duplicidade." },
  { chave: "AGUARDANDO_ACORDO_PARADO", rotulo: "Aguardando acordo ha mais de 7 dias", risco: "MEDIO",
    dica: "Dinheiro entrou e o acordo correspondente nunca apareceu." },
  { chave: "BAIXA_OFICIAL_SEM_CONCILIACAO_BAIXADO", rotulo: "Baixa oficial, conciliacao nao diz BAIXADO", risco: "BAIXO",
    dica: "As duas fontes discordam no sentido inverso: a baixa existe e o CRM nao registrou." },
];

const CORES_RISCO = {
  CRITICO: { fundo: "var(--rv-vermelho-fundo)", texto: "var(--rv-vermelho-texto)", borda: "var(--rv-vermelho-borda)" },
  ALTO: { fundo: "var(--rv-ambar-fundo)", texto: "var(--rv-ambar-texto)", borda: "var(--rv-ambar-borda)" },
  MEDIO: { fundo: "var(--rv-fundo-suave)", texto: "var(--rv-texto-forte)", borda: "var(--rv-borda)" },
  BAIXO: { fundo: "var(--rv-fundo-suave)", texto: "var(--rv-texto-suave)", borda: "var(--rv-borda-suave)" },
};

function somar(linhas) {
  return { n: linhas.length, valor: linhas.reduce((t, l) => t + Number(l.valor_pago || 0), 0) };
}

export default function CentralFinanceiraIndicadores() {
  const [email, setEmail] = useState(null);
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [{ de, ate }, setJanela] = useState(janelaPadrao);
  const [classe, setClasse] = useState(null);
  const [indicadores, setIndicadores] = useState([]);
  const [excecoes, setExcecoes] = useState([]);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(String(data?.user?.email || "").toLowerCase().trim());
    });
  }, []);

  const eGestaoFinanceira = email !== null && GESTAO_FINANCEIRA.includes(email);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro("");
    try {
      // Duas leituras, uma por view. A paginacao e obrigatoria: a API corta em
      // 1.000 linhas e responde 206, que e sucesso -- a janela de 30 dias tem
      // 1.240 pagamentos e 1.238 linhas de excecao.
      const [linhasInd, linhasExc] = await Promise.all([
        buscarTudo((p, q) => supabase
          .from(VISAO_INDICADORES)
          .select("pagamento_id,valor_pago,crm_status_conciliacao,baixa_oficial_existe,baixa_devolvida_qtd")
          .gte("data_pagamento", de).lte("data_pagamento", ate)
          .order("pagamento_id", { ascending: true })
          .range(p, q)),
        buscarTudo((p, q) => supabase
          .from(VISAO_EXCECOES)
          .select("*")
          .gte("data_pagamento", de).lte("data_pagamento", ate)
          .order("risco", { ascending: true })
          .order("valor_pago", { ascending: false })
          .order("pagamento_id", { ascending: true })
          .range(p, q)),
      ]);
      setIndicadores(linhasInd);
      setExcecoes(linhasExc);
    } catch (e) {
      setErro(e?.message || "Nao foi possivel ler os indicadores.");
      setIndicadores([]); setExcecoes([]);
    } finally {
      setCarregando(false);
    }
  }, [de, ate]);

  // O atraso curto nao e enfeite: `de`/`ate` sao inputs de data e disparam a
  // cada tecla, e ler producao a cada tecla seria uma leitura por digito.
  // Serve tambem para nao chamar setState dentro do corpo do efeito.
  useEffect(() => {
    if (!aberto || !eGestaoFinanceira) return undefined;
    const t = setTimeout(() => { carregar(); }, 200);
    return () => clearTimeout(t);
  }, [aberto, eGestaoFinanceira, carregar]);

  // INDICADOR 1 -- conciliacao no CRM. So olha crm_status_conciliacao.
  const conciliacao = useMemo(() => {
    const porStatus = new Map();
    for (const l of indicadores) {
      const k = l.crm_status_conciliacao || "(sem conciliacao)";
      if (!porStatus.has(k)) porStatus.set(k, []);
      porStatus.get(k).push(l);
    }
    return {
      total: somar(indicadores),
      linhas: [...porStatus.entries()]
        .map(([status, ls]) => ({ status, ...somar(ls) }))
        .sort((a, b) => b.n - a.n),
    };
  }, [indicadores]);

  // INDICADOR 2 -- baixa oficial. So olha baixas_pagamento.
  const baixaOficial = useMemo(() => ({
    viva: somar(indicadores.filter((l) => l.baixa_oficial_existe === true)),
    sem: somar(indicadores.filter((l) => l.baixa_oficial_existe !== true)),
    devolvida: somar(indicadores.filter((l) => Number(l.baixa_devolvida_qtd || 0) > 0)),
  }), [indicadores]);

  const porClasse = useMemo(() => {
    const m = new Map();
    for (const e of excecoes) {
      if (!m.has(e.classe)) m.set(e.classe, []);
      m.get(e.classe).push(e);
    }
    return m;
  }, [excecoes]);

  const lista = useMemo(
    () => (classe ? excecoes.filter((e) => e.classe === classe) : excecoes),
    [excecoes, classe],
  );

  if (email === null) return null;
  if (!eGestaoFinanceira) return null;

  if (!aberto) {
    return (
      <div style={est.caixaFechada}>
        <button type="button" style={est.botaoAbrir} onClick={() => setAberto(true)}>
          Conferência: conciliação no CRM × baixa oficial — somente leitura
        </button>
        <span style={est.dicaFechada}>
          Dois indicadores separados e a lista de exceções por risco. Nada aqui registra baixa.
        </span>
      </div>
    );
  }

  return (
    <section style={est.caixa} aria-label="Central Financeira: dois indicadores">
      <div style={est.cabecalho}>
        <div>
          <h2 style={est.titulo}>Conciliação no CRM × baixa oficial</h2>
          <p style={est.sub}>
            <b>Somente leitura.</b> São <b>duas fontes diferentes</b>: a conciliação é a opinião do
            motor de importação em <code>pagamentos.status_conciliacao</code>; a baixa oficial é a
            linha em <code>baixas_pagamento</code>, com responsável e data.
            <b> BAIXADO no CRM não prova baixa oficial</b> — por isso os dois números nunca aparecem
            somados nem na mesma coluna.
          </p>
        </div>
        <div style={est.cabecalhoDir}>
          <input type="date" value={de} style={est.data} aria-label="Pagamentos a partir desta data"
                 onChange={(e) => setJanela((j) => ({ ...j, de: e.target.value }))} />
          <span style={est.ate}>até</span>
          <input type="date" value={ate} style={est.data} aria-label="Pagamentos até esta data"
                 onChange={(e) => setJanela((j) => ({ ...j, ate: e.target.value }))} />
          <button type="button" style={est.botao} onClick={carregar} disabled={carregando}>
            {carregando ? "Lendo…" : "Atualizar"}
          </button>
          <button type="button" style={est.botaoFechar} onClick={() => setAberto(false)}>Fechar</button>
        </div>
      </div>

      {erro ? <div style={est.erro}>{erro}</div> : null}

      <div style={est.doisPaineis}>
        <div style={est.painelCrm}>
          <div style={est.painelTopo}>
            <span style={est.selo1}>Indicador 1</span>
            <h3 style={est.painelTitulo}>Conciliação no CRM</h3>
          </div>
          <p style={est.painelFonte}>fonte: <code>public.pagamentos</code></p>
          <table style={est.tabelaMini}>
            <tbody>
              {conciliacao.linhas.map((l) => (
                <tr key={l.status}>
                  <td style={est.miniChave}>{l.status}</td>
                  <td style={est.miniNum}>{l.n}</td>
                  <td style={est.miniValor}>{moeda(l.valor)}</td>
                </tr>
              ))}
              <tr>
                <td style={est.miniChaveTotal}>no período</td>
                <td style={est.miniNumTotal}>{conciliacao.total.n}</td>
                <td style={est.miniValorTotal}>{moeda(conciliacao.total.valor)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={est.painelBaixa}>
          <div style={est.painelTopo}>
            <span style={est.selo2}>Indicador 2</span>
            <h3 style={est.painelTitulo}>Baixa oficial no título/parcela</h3>
          </div>
          <p style={est.painelFonte}>
            fonte: <code>public.baixas_pagamento</code> — viva = <code>devolvido_em</code> nulo
          </p>
          <table style={est.tabelaMini}>
            <tbody>
              <tr>
                <td style={est.miniChave}>com baixa oficial viva</td>
                <td style={est.miniNum}>{baixaOficial.viva.n}</td>
                <td style={est.miniValor}>{moeda(baixaOficial.viva.valor)}</td>
              </tr>
              <tr>
                <td style={est.miniChave}>sem baixa oficial</td>
                <td style={est.miniNum}>{baixaOficial.sem.n}</td>
                <td style={est.miniValor}>{moeda(baixaOficial.sem.valor)}</td>
              </tr>
              <tr>
                <td style={est.miniChave}>com baixa devolvida no histórico</td>
                <td style={est.miniNum}>{baixaOficial.devolvida.n}</td>
                <td style={est.miniValor}>{moeda(baixaOficial.devolvida.valor)}</td>
              </tr>
              <tr>
                <td style={est.miniChaveTotal}>no período</td>
                <td style={est.miniNumTotal}>{conciliacao.total.n}</td>
                <td style={est.miniValorTotal}>{moeda(conciliacao.total.valor)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div style={est.chips}>
        <span style={est.rotuloGrupo}>Exceções por risco</span>
        <button type="button" onClick={() => setClasse(null)}
                style={{ ...est.chip, ...(classe === null ? est.chipOn : null) }} aria-pressed={classe === null}>
          Todas · {excecoes.length}
        </button>
        {CLASSES.map((c) => {
          const ls = porClasse.get(c.chave) || [];
          const s = somar(ls);
          const cor = CORES_RISCO[c.risco];
          return (
            <button
              key={c.chave} type="button" title={c.dica} aria-pressed={classe === c.chave}
              onClick={() => setClasse(classe === c.chave ? null : c.chave)}
              style={{
                ...est.chip, background: cor.fundo, color: cor.texto, borderColor: cor.borda,
                ...(classe === c.chave ? est.chipOn : null),
              }}
            >
              <b>{c.risco}</b> · {c.rotulo} · {s.n} · {moeda(s.valor)}
            </button>
          );
        })}
      </div>

      {carregando && !excecoes.length ? <p style={est.muted}>Lendo produção…</p> : null}
      {!carregando && !excecoes.length && !erro
        ? <p style={est.muted}>Nenhuma exceção no período.</p> : null}

      {lista.length ? (
        <div style={est.rolagem}>
          <table style={est.tabela}>
            <thead>
              <tr>
                <th style={est.th}>Risco</th>
                <th style={est.th}>Aluno</th>
                <th style={est.th}>Pagamento</th>
                <th style={est.thNum}>Valor pago</th>
                <th style={est.thCrm}>Indicador 1 — conciliação no CRM</th>
                <th style={est.thBaixa}>Indicador 2 — baixa oficial</th>
                <th style={est.th}>Parcela (contexto)</th>
                <th style={est.th}>Vínculo</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((e) => {
                const cor = CORES_RISCO[e.risco_rotulo] || CORES_RISCO.MEDIO;
                return (
                  <tr key={`${e.pagamento_id}-${e.classe}`}>
                    <td style={est.td}>
                      <span style={{ ...est.selo, background: cor.fundo, color: cor.texto, borderColor: cor.borda }}>
                        {e.risco_rotulo}
                      </span>
                      <div style={est.classeNome}>{e.classe_rotulo}</div>
                      <div style={est.classeMotivo}>{e.classe_motivo}</div>
                    </td>
                    <td style={est.td}>
                      <div style={est.nome}>{e.aluno_nome || "— sem nome —"}</div>
                      <div style={est.cpf}>{e.cpf || "sem CPF"}</div>
                    </td>
                    <td style={est.td}>
                      <div>{curta(e.data_pagamento)}</div>
                      <div style={est.cpf}>
                        título {e.titulo_numero || "—"} · parcela {e.numero_parcela_completo || "—"}
                      </div>
                    </td>
                    <td style={est.tdNum}>{moeda(e.valor_pago)}</td>

                    {/* INDICADOR 1 -- so pagamentos. */}
                    <td style={est.tdCrm}>
                      <div style={est.valorForte}>{e.crm_status_conciliacao || "(sem conciliação)"}</div>
                      <div style={est.cpf}>{e.crm_conciliacao_motivo || "sem motivo registrado"}</div>
                      <div style={est.cpf}>
                        {e.crm_conciliacao_em ? `em ${curtoHora(e.crm_conciliacao_em)}` : "nunca conciliado"}
                        {" · "}{e.crm_dias_parado} dia(s) parado
                      </div>
                    </td>

                    {/* INDICADOR 2 -- so baixas_pagamento. */}
                    <td style={est.tdBaixa}>
                      <div style={est.valorForte}>
                        {e.baixa_oficial_existe ? "baixa oficial viva" : "sem baixa oficial"}
                      </div>
                      {e.baixa_oficial_existe ? (
                        <div style={est.cpf}>
                          {e.baixa_oficial_status_baixa || "sem status"} · {curtoHora(e.baixa_oficial_em)}
                          <br />por {e.baixa_oficial_por_email || "origem não registrada"}
                          {e.baixa_oficial_valor_pago != null
                            ? <> · baixado {moeda(e.baixa_oficial_valor_pago)}</> : null}
                        </div>
                      ) : null}
                      {Number(e.baixa_devolvida_qtd || 0) > 0 ? (
                        <div style={est.devolvida}>
                          {e.baixa_devolvida_qtd} devolvida(s) · última {curtoHora(e.baixa_devolvida_ultima_em)}
                          {e.baixa_devolvida_motivo ? <> · {e.baixa_devolvida_motivo}</> : null}
                        </div>
                      ) : null}
                      {!e.baixa_oficial_existe && Number(e.baixa_candidata_fraca_qtd || 0) > 0 ? (
                        <div style={est.cpf}>
                          {e.baixa_candidata_fraca_qtd} baixa(s) com mesmo CPF, data e valor —{" "}
                          <b>não é vínculo</b>, só pista para conferir
                        </div>
                      ) : null}
                    </td>

                    {/* FONTE C -- contexto, deliberadamente discreto. */}
                    <td style={est.tdParcela}>
                      <div>{e.parcela_status || "sem parcela vinculada"}</div>
                      {e.parcela_origem_baixa ? (
                        <div style={est.cpf}>baixada por {e.parcela_origem_baixa}</div>
                      ) : null}
                    </td>

                    <td style={est.td}>
                      <div style={est.cpf}>{e.vinculo_parcela_confianca}</div>
                      <div style={est.cpf}>{e.crm_origem_vinculo || "—"}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <p style={est.rodape}>
        Esta tela não registra baixa, não conclui conciliação e não dispara nada. A fila de pagamento
        em parcela ou acordo <b>cancelado</b> não está aqui: é outra frente, ainda em decisão da gestão.
      </p>
    </section>
  );
}

const CRM = { fundo: "var(--rv-azul-fundo)", borda: "var(--rv-azul-borda)", texto: "var(--rv-azul-texto)" };
const BAIXA = { fundo: "var(--rv-roxo-fundo)", borda: "var(--rv-roxo-borda)", texto: "var(--rv-roxo-texto)" };

const est = {
  caixaFechada: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 },
  botaoAbrir: {
    background: "var(--rv-superficie)", color: "var(--rv-tinta)", border: "1px dashed var(--rv-borda-forte)",
    borderRadius: 10, padding: "9px 16px", fontSize: 13, fontWeight: 800, cursor: "pointer",
  },
  dicaFechada: { fontSize: 12, color: "var(--rv-texto-fraco)" },

  caixa: {
    background: "var(--rv-superficie)", border: "1px solid var(--rv-borda)", borderRadius: 14,
    padding: "16px 18px 12px", marginBottom: 18,
  },
  cabecalho: { display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start" },
  cabecalhoDir: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  titulo: { margin: 0, fontFamily: "'Sora', Inter, sans-serif", fontSize: 18, fontWeight: 800, color: "var(--rv-tinta)" },
  sub: { margin: "6px 0 0", maxWidth: 760, fontSize: 12.5, lineHeight: 1.55, color: "var(--rv-texto)" },
  data: {
    border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "6px 10px", fontSize: 12.5,
    background: "var(--rv-superficie)", color: "var(--rv-tinta)",
  },
  ate: { fontSize: 12, color: "var(--rv-texto-fraco)" },
  botao: {
    background: "#1e40af", color: "#fff", border: "none", borderRadius: 8,
    padding: "7px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer",
  },
  botaoFechar: {
    background: "var(--rv-fundo-suave)", color: "var(--rv-texto-forte)", border: "1px solid var(--rv-borda)",
    borderRadius: 8, padding: "7px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer",
  },
  erro: {
    background: "var(--rv-vermelho-fundo)", color: "var(--rv-vermelho-texto)",
    border: "1px solid var(--rv-vermelho-borda)", borderRadius: 10, padding: "9px 12px",
    fontSize: 12.5, fontWeight: 600, margin: "12px 0 0",
  },

  doisPaineis: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, margin: "14px 0 4px" },
  painelCrm: { background: CRM.fundo, border: `1px solid ${CRM.borda}`, borderLeft: `4px solid ${CRM.texto}`, borderRadius: 12, padding: "12px 14px" },
  painelBaixa: { background: BAIXA.fundo, border: `1px solid ${BAIXA.borda}`, borderLeft: `4px solid ${BAIXA.texto}`, borderRadius: 12, padding: "12px 14px" },
  painelTopo: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  selo1: { fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: CRM.texto, border: `1px solid ${CRM.borda}`, borderRadius: 999, padding: "2px 8px" },
  selo2: { fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: BAIXA.texto, border: `1px solid ${BAIXA.borda}`, borderRadius: 999, padding: "2px 8px" },
  painelTitulo: { margin: 0, fontSize: 14.5, fontWeight: 800, color: "var(--rv-tinta)" },
  painelFonte: { margin: "4px 0 8px", fontSize: 11.5, color: "var(--rv-texto-suave)" },
  tabelaMini: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  miniChave: { padding: "3px 0", color: "var(--rv-texto-forte)" },
  miniNum: { padding: "3px 8px", textAlign: "right", fontWeight: 800, color: "var(--rv-tinta)", whiteSpace: "nowrap" },
  miniValor: { padding: "3px 0", textAlign: "right", color: "var(--rv-texto)", whiteSpace: "nowrap" },
  miniChaveTotal: { padding: "7px 0 0", borderTop: "1px solid var(--rv-borda-suave)", fontWeight: 800, color: "var(--rv-texto-suave)", fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em" },
  miniNumTotal: { padding: "7px 8px 0", borderTop: "1px solid var(--rv-borda-suave)", textAlign: "right", fontWeight: 800, color: "var(--rv-tinta)" },
  miniValorTotal: { padding: "7px 0 0", borderTop: "1px solid var(--rv-borda-suave)", textAlign: "right", fontWeight: 800, color: "var(--rv-tinta)", whiteSpace: "nowrap" },

  chips: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "14px 0 10px" },
  rotuloGrupo: { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)" },
  chip: {
    background: "var(--rv-superficie)", color: "var(--rv-texto-forte)", border: "1px solid var(--rv-borda)",
    borderRadius: 999, padding: "5px 12px", fontSize: 11.5, fontWeight: 600, cursor: "pointer",
  },
  chipOn: { outline: "2px solid var(--rv-tinta)", outlineOffset: 1 },

  rolagem: { overflowX: "auto", border: "1px solid var(--rv-borda-suave)", borderRadius: 10 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 12.5, background: "var(--rv-superficie)" },
  th: { textAlign: "left", padding: "8px 12px", fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)", borderBottom: "1px solid var(--rv-borda-suave)", verticalAlign: "bottom" },
  thNum: { textAlign: "right", padding: "8px 12px", fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)", borderBottom: "1px solid var(--rv-borda-suave)", verticalAlign: "bottom" },
  thCrm: { textAlign: "left", padding: "8px 12px", fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: CRM.texto, background: CRM.fundo, borderBottom: `2px solid ${CRM.texto}`, verticalAlign: "bottom" },
  thBaixa: { textAlign: "left", padding: "8px 12px", fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: BAIXA.texto, background: BAIXA.fundo, borderBottom: `2px solid ${BAIXA.texto}`, verticalAlign: "bottom" },
  td: { padding: "9px 12px", borderBottom: "1px solid var(--rv-borda-suave)", color: "var(--rv-texto-forte)", verticalAlign: "top" },
  tdNum: { padding: "9px 12px", borderBottom: "1px solid var(--rv-borda-suave)", textAlign: "right", fontWeight: 800, color: "var(--rv-tinta)", verticalAlign: "top", whiteSpace: "nowrap" },
  tdCrm: { padding: "9px 12px", borderBottom: "1px solid var(--rv-borda-suave)", borderLeft: `3px solid ${CRM.borda}`, background: CRM.fundo, color: "var(--rv-texto-forte)", verticalAlign: "top", minWidth: 210 },
  tdBaixa: { padding: "9px 12px", borderBottom: "1px solid var(--rv-borda-suave)", borderLeft: `3px solid ${BAIXA.borda}`, background: BAIXA.fundo, color: "var(--rv-texto-forte)", verticalAlign: "top", minWidth: 230 },
  tdParcela: { padding: "9px 12px", borderBottom: "1px solid var(--rv-borda-suave)", color: "var(--rv-texto-suave)", fontSize: 12, verticalAlign: "top" },
  selo: { display: "inline-block", border: "1px solid", borderRadius: 999, padding: "2px 8px", fontSize: 10, fontWeight: 800, letterSpacing: "0.04em" },
  classeNome: { marginTop: 4, fontSize: 11.5, fontWeight: 700, color: "var(--rv-texto-forte)", maxWidth: 230 },
  classeMotivo: { marginTop: 2, fontSize: 11, color: "var(--rv-texto-suave)", maxWidth: 230, lineHeight: 1.4 },
  nome: { fontWeight: 700, color: "var(--rv-tinta)" },
  cpf: { fontSize: 11.5, color: "var(--rv-texto-suave)", lineHeight: 1.45 },
  valorForte: { fontWeight: 800, color: "var(--rv-tinta)" },
  devolvida: { marginTop: 3, fontSize: 11.5, color: "var(--rv-ambar-texto)", fontWeight: 600, lineHeight: 1.45 },
  muted: { color: "var(--rv-texto-suave)", fontSize: 13, margin: "10px 0" },
  rodape: { margin: "12px 0 0", fontSize: 11.5, color: "var(--rv-texto-fraco)", lineHeight: 1.5 },
};
