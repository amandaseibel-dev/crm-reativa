import { useRef, useState } from "react";
import { supabase } from "../services/supabase";
import { rotuloMotivo } from "../utils/motivosAcaoMassiva";

// ============================================================================
// COBERTURA DO MÊS POR ANO + DRILL-DOWN. Só leitura. Backend:
// acoes_massivas_cobertura_por_ano / acoes_massivas_drilldown (gestão).
// O painel usa os mesmos filtros de população/operação da tela de ação; o filtro
// de ano é ignorado (o painel mostra todos os anos). Cada número clicável abre o
// drill-down, cujo total deve bater com o número clicado.
// ============================================================================

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const AZUL = "var(--rv-azul-texto)";
const POR_PAGINA = 50;

const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dataBR = (iso) => { if (!iso) return "—"; try { return new Date(iso).toLocaleDateString("pt-BR"); } catch { return "—"; } };

const CANAIS = { WHATSAPP: "WhatsApp", EMAIL: "E-mail" };

// Nomes explícitos: "Disponíveis" sempre diz PARA QUÊ (canal) e sobre QUAL universo.
// Não é outra conta: são os mesmos números da RPC, só com o nome do que representam.
function nomesDisponibilidade(canal) {
  return {
    disp: canal ? `Disponíveis para ${canal}` : "Disponíveis nos filtros atuais",
    indisp: canal ? `Indisponíveis para ${canal}` : "Indisponíveis nos filtros atuais",
  };
}

function tituloIndicador(ind, canal) {
  const { disp, indisp } = nomesDisponibilidade(canal);
  return {
    base: "Base",
    acionados: "Acionados no mês",
    sem_acionamento: "Sem acionamento no mês",
    disponiveis_sem_acionamento: `${disp} — sem acionamento no mês`,
    disponiveis: `${disp} — total da seleção atual (inclui quem já foi acionado no mês)`,
    indisponiveis: `${indisp} — sem acionamento no mês`,
    indisponiveis_total: `${indisp} — total da seleção atual`,
  }[ind];
}

export default function CoberturaPorAno({ filtros }) {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [drill, setDrill] = useState(null); // { ano, anoLabel, indicador, motivo, motivos }
  const [drillData, setDrillData] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const emVoo = useRef(false);
  const canal = CANAIS[String(filtros?.canal || "").toUpperCase()] || null;
  const { disp: nomeDisp, indisp: nomeIndisp } = nomesDisponibilidade(canal);
  const ondeCanal = canal ? `, inclusive o canal (${canal})` : "";

  async function carregar() {
    if (emVoo.current) return;
    emVoo.current = true;
    setCarregando(true); setErro("");
    try {
      const { data, error } = await supabase.rpc("acoes_massivas_cobertura_por_ano", { p_filtros: filtros });
      if (error) throw error;
      setDados(data);
    } catch (e) { setErro(e.message || "Falha ao carregar."); }
    finally { emVoo.current = false; setCarregando(false); }
  }

  async function carregarDrill(d, off) {
    setDrillLoading(true);
    try {
      const { data, error } = await supabase.rpc("acoes_massivas_drilldown", {
        p_filtros: filtros, p_ano: d.ano, p_indicador: d.indicador, p_motivo: d.motivo || null,
        p_limit: POR_PAGINA, p_offset: off,
      });
      if (error) throw error;
      setDrillData(data);
    } catch (e) { setDrillData({ erro: e.message, itens: [], total: 0 }); }
    finally { setDrillLoading(false); }
  }

  function abrir(linha, indicador, motivo = null) {
    const d = { ano: linha.ano ?? null, anoLabel: linha.ano == null ? "TOTAL" : String(linha.ano), indicador, motivo, motivos: linha.motivos || {} };
    setDrill(d); setOffset(0); setDrillData(null);
    carregarDrill(d, 0);
  }
  function irPara(off) { setOffset(off); carregarDrill(drill, off); }

  const linhas = dados?.linhas || [];
  const total = dados?.total ? { ...dados.total, ano: null } : null;

  function renderLinha(l, rotulo, forte) {
    const cel = (v, ind) => (
      <button type="button" style={est.link} onClick={() => abrir(l, ind)} title="Ver os alunos">{num(v)}</button>
    );
    return (
      <tr key={rotulo} style={forte ? { background: "var(--rv-fundo-cartao)", fontWeight: 800 } : undefined}>
        <td style={est.tdb}>{rotulo}</td>
        <td style={est.tdn}>{cel(l.base, "base")}</td>
        <td style={est.tdn}>{cel(l.acionados, "acionados")}</td>
        <td style={est.tdn}>{cel(l.sem_acionamento, "sem_acionamento")}</td>
        <td style={est.tdn}>{Number(l.pct_acionado || 0).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</td>
        <td style={est.tdn}>{cel(l.disponiveis, "disponiveis_sem_acionamento")}</td>
        <td style={{ ...est.tdn, color: "var(--rv-texto-fraco)" }} title={`${nomeDisp}: total da seleção atual, inclui quem já foi acionado no mês`}>{cel(l.disponiveis_total, "disponiveis")}</td>
        <td style={est.tdn}>{cel(l.indisponiveis, "indisponiveis")}</td>
        <td style={est.td}>
          {l.reconcilia
            ? <span style={est.selo}>reconcilia ✓</span>
            : <span style={est.seloErro}>não reconcilia</span>}
        </td>
      </tr>
    );
  }

  const mostrarMotivos = drill?.indicador === "indisponiveis" && Object.keys(drill.motivos || {}).length > 0;

  return (
    <div>
      <p style={est.sub}>
        Cobertura do mês: quem já foi acionado neste mês e quem ainda está sem acionamento, por ano da dívida,
        com os mesmos filtros da tela de ação (o filtro de ano não se aplica). <strong>Base</strong>, <strong>Acionados</strong> e{" "}
        <strong>Sem acionamento</strong> não dependem de canal, operador nem valor. <strong>Disponibilidade</strong> depende dos
        filtros atuais{ondeCanal}: mudar o canal ou os filtros muda só os números de disponíveis e indisponíveis.
        Clique em qualquer número para ver os alunos.
      </p>
      <button style={est.btnPrim} onClick={carregar} disabled={carregando}>
        {carregando ? "Calculando…" : dados ? "Recalcular cobertura" : "Carregar cobertura"}
      </button>
      {erro && <div style={est.erro}>{erro}</div>}

      {dados && (
        <div style={{ overflowX: "auto", marginTop: 14 }}>
          <table style={est.tabela}>
            <thead><tr>
              <th style={est.th}>Ano</th><th style={est.thNum} title="Alunos com dívida ativa (CPF único no TOTAL)">Base</th>
              <th style={est.thNum} title="Alunos com pelo menos um acionamento válido no mês">Acionados no mês</th>
              <th style={est.thNum} title="Base menos acionados no mês. Não depende de canal nem de outros filtros de disponibilidade">Sem acionamento no mês</th>
              <th style={est.thNum}>% acionado</th>
              <th style={est.thNum} title={`${nomeDisp}, entre os que estão sem acionamento no mês. Considera os filtros atuais${ondeCanal}.`}>
                {nomeDisp}<div style={est.thSub}>sem acionamento no mês</div>
              </th>
              <th style={est.thNum} title={`${nomeDisp}: total da seleção atual, inclui quem já foi acionado no mês. Considera os filtros atuais${ondeCanal}.`}>
                {nomeDisp} — total<div style={est.thSub}>seleção atual, inclui já acionados</div>
              </th>
              <th style={est.thNum} title={`${nomeIndisp}, entre os que estão sem acionamento no mês (soma dos motivos). Sem acionamento = ${nomeDisp.toLowerCase()} + ${nomeIndisp.toLowerCase()}.`}>
                {nomeIndisp}<div style={est.thSub}>sem acionamento no mês</div>
              </th><th style={est.th}></th>
            </tr></thead>
            <tbody>
              {linhas.map((l) => renderLinha(l, String(l.ano), false))}
              {linhas.length === 0 && <tr><td colSpan={9} style={est.tdVazio}>Nenhum ano para os filtros atuais.</td></tr>}
              {total && renderLinha(total, "TOTAL", true)}
            </tbody>
          </table>
          <div style={{ fontSize: 11.5, color: "var(--rv-texto-fraco)", marginTop: 8 }} data-testid="legenda-disponibilidade">
            <strong>Conta que fecha:</strong> {nomeDisp} + {nomeIndisp} = Sem acionamento no mês (na mesma linha).
            {canal ? ` Quem não tem contato válido para ${canal} aparece como indisponível (“Sem contato válido para o canal”).` : ""}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--rv-texto-fraco)", marginTop: 4 }}>
            A linha TOTAL conta cada aluno uma só vez (não é a soma dos anos: um aluno pode ter dívida em mais de um ano).
            Mês de referência: {dados.mes_referencia || "—"}.
          </div>
        </div>
      )}

      {drill && (
        <div style={est.modalBg} onClick={() => setDrill(null)}>
          <div style={est.modal} role="dialog" aria-label="Alunos do indicador" onClick={(e) => e.stopPropagation()}>
            <div style={est.modalTopo}>
              <strong style={{ fontFamily: FONTE_TITULO, fontSize: 16 }}>
                {tituloIndicador(drill.indicador, canal)} — {drill.anoLabel === "TOTAL" ? "TOTAL" : `ano ${drill.anoLabel}`}
                {drill.motivo ? ` — ${rotuloMotivo(drill.motivo)}` : ""}
              </strong>
              <button type="button" style={est.fechar} aria-label="Fechar" onClick={() => setDrill(null)}>✕</button>
            </div>
            <div style={est.modalCorpo}>
              {mostrarMotivos && (
                <div style={est.chips}>
                  <button type="button" style={!drill.motivo ? est.chipAtivo : est.chip}
                    onClick={() => abrir({ ano: drill.ano, motivos: drill.motivos }, "indisponiveis", null)}>Todos os motivos</button>
                  {Object.entries(drill.motivos).map(([m, n]) => (
                    <button key={m} type="button" style={drill.motivo === m ? est.chipAtivo : est.chip}
                      onClick={() => abrir({ ano: drill.ano, motivos: drill.motivos }, "indisponiveis", m)}>
                      {rotuloMotivo(m)}: {num(n)}
                    </button>
                  ))}
                </div>
              )}
              {["disponiveis", "disponiveis_sem_acionamento", "indisponiveis", "indisponiveis_total"].includes(drill.indicador) && (
                <div style={{ fontSize: 12, color: "var(--rv-texto-fraco)", marginBottom: 8 }} data-testid="drill-aviso-filtros">
                  A disponibilidade considera os filtros atuais da tela{ondeCanal}. Com outro canal ou outros filtros, esta lista muda.
                </div>
              )}
              {drillLoading && <div style={est.vazio}>Carregando…</div>}
              {!drillLoading && drillData?.erro && <div style={est.erro}>{drillData.erro}</div>}
              {!drillLoading && drillData && !drillData.erro && (<>
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }} data-testid="drill-total">
                  {num(drillData.total)} alunos
                  <span style={{ fontWeight: 400, color: "var(--rv-texto-fraco)" }}>
                    {" "}· mostrando {num(offset + 1)}–{num(offset + (drillData.itens?.length || 0))}
                  </span>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={est.tabela}>
                    <thead><tr>
                      <th style={est.th}>Aluno</th><th style={est.th}>CPF (final)</th><th style={est.th}>Anos</th>
                      <th style={est.th}>Unidade</th><th style={est.th}>Curso</th><th style={est.th}>Situação</th>
                      <th style={est.th}>Responsável</th><th style={est.thNum}>Valor</th>
                      <th style={est.th}>Último acionamento</th><th style={est.th}>{canal ? `Disponibilidade (${canal})` : "Disponibilidade"}</th>
                    </tr></thead>
                    <tbody>
                      {(drillData.itens || []).map((it) => (
                        <tr key={it.aluno_id}>
                          <td style={est.td}>{it.nome}</td>
                          <td style={est.td}>{it.cpf_final || "—"}</td>
                          <td style={est.td}>{(it.anos || []).join(", ") || "—"}</td>
                          <td style={est.td}>{it.unidade || "—"}</td>
                          <td style={est.td}>{it.curso || "—"}</td>
                          <td style={est.td}>{it.situacao_academica || "—"}</td>
                          <td style={est.td}>{it.responsavel_email || "Sem responsável"}</td>
                          <td style={est.tdn}>{moeda(it.valor)}</td>
                          <td style={est.td}>{dataBR(it.ultimo_acionamento)}</td>
                          <td style={est.td}>{it.disponivel ? "Disponível" : (it.motivo_texto || rotuloMotivo(it.motivo) || "—")}</td>
                        </tr>
                      ))}
                      {(drillData.itens || []).length === 0 && <tr><td colSpan={10} style={est.tdVazio}>Nenhum aluno neste indicador.</td></tr>}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button type="button" style={est.btnSec} disabled={offset === 0} onClick={() => irPara(Math.max(0, offset - POR_PAGINA))}>Anterior</button>
                  <button type="button" style={est.btnSec} disabled={offset + POR_PAGINA >= Number(drillData.total || 0)} onClick={() => irPara(offset + POR_PAGINA)}>Próxima</button>
                </div>
              </>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const est = {
  sub: { margin: "0 0 12px", fontSize: 13, color: "var(--rv-texto-suave)", lineHeight: 1.5 },
  btnPrim: { padding: "10px 18px", borderRadius: 10, border: "none", background: AZUL, color: "#fff", fontWeight: 700, fontSize: 13.5, cursor: "pointer" },
  btnSec: { padding: "7px 14px", borderRadius: 10, border: "1px solid var(--rv-roxo-borda)", background: "var(--rv-roxo-fundo)", color: AZUL, fontWeight: 700, fontSize: 13, cursor: "pointer" },
  erro: { background: "var(--rv-vermelho-fundo)", border: "1px solid var(--rv-vermelho-borda)", color: "var(--rv-vermelho-texto)", padding: "10px 14px", borderRadius: 10, fontSize: 13, margin: "12px 0" },
  vazio: { padding: 18, textAlign: "center", color: "var(--rv-texto-fraco)", fontSize: 13 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "2px solid var(--rv-borda-suave)", color: "var(--rv-texto)", fontWeight: 700, whiteSpace: "nowrap" },
  thSub: { fontSize: 10.5, fontWeight: 400, color: "var(--rv-texto-fraco)", whiteSpace: "normal", lineHeight: 1.2 },
  thNum: { textAlign: "right", padding: "8px 10px", borderBottom: "2px solid var(--rv-borda-suave)", color: "var(--rv-texto)", fontWeight: 700, whiteSpace: "nowrap" },
  td: { padding: "7px 10px", borderBottom: "1px solid var(--rv-borda-suave)", whiteSpace: "nowrap" },
  tdb: { padding: "7px 10px", borderBottom: "1px solid var(--rv-borda-suave)", fontWeight: 700, whiteSpace: "nowrap" },
  tdn: { padding: "7px 10px", borderBottom: "1px solid var(--rv-borda-suave)", textAlign: "right", whiteSpace: "nowrap" },
  tdVazio: { padding: 16, textAlign: "center", color: "var(--rv-texto-fraco)" },
  link: { background: "none", border: "none", color: AZUL, fontWeight: 700, cursor: "pointer", fontSize: 12.5, padding: 0, textDecoration: "underline" },
  selo: { fontSize: 11, fontWeight: 800, color: "var(--rv-verde-ok-texto)", background: "var(--rv-verde-ok-fundo)", borderRadius: 6, padding: "1px 8px" },
  seloErro: { fontSize: 11, fontWeight: 800, color: "var(--rv-vermelho-texto)", background: "var(--rv-vermelho-fundo)", borderRadius: 6, padding: "1px 8px" },
  chips: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 },
  chip: { padding: "6px 11px", borderRadius: 999, border: "1px solid var(--rv-borda)", background: "var(--rv-superficie)", color: "var(--rv-texto)", fontWeight: 600, fontSize: 12, cursor: "pointer" },
  chipAtivo: { padding: "6px 11px", borderRadius: 999, border: "1px solid var(--rv-roxo-borda)", background: "var(--rv-roxo-fundo)", color: AZUL, fontWeight: 800, fontSize: 12, cursor: "pointer" },
  modalBg: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 },
  modal: { background: "var(--rv-superficie)", borderRadius: 16, width: "min(1250px, 97vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden" },
  modalTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: "1px solid var(--rv-borda-suave)" },
  fechar: { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "var(--rv-texto-suave)" },
  modalCorpo: { padding: 18, overflow: "auto" },
};
