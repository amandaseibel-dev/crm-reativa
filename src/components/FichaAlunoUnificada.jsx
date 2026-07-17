import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { podeVerTudo } from "../utils/operadores";
import AlterarOperadorResponsavel from "./AlterarOperadorResponsavel";
import EmailAlunoUnificado from "./EmailAlunoUnificado";
import TelefonesAluno from "./TelefonesAluno";

/*
  FichaAlunoUnificada
  -------------------
  Ficha ÚNICA do aluno, usada por todas as filas (Minha Carteira, Alunos,
  Confirmação de Pagamento e Fila de Baixa). Sempre carregada por aluno_id a
  partir de uma fonte de dados única: public.alunos + acordos/parcelas/
  aluno_movimentacoes. Abas: Resumo, Negociação, Financeiro, Histórico.

  NÃO cria formulários financeiros novos nem altera regras financeiras: as
  ações específicas de cada fila (confirmar/rejeitar, baixar/divergência,
  construtor de acordo, tabular, etc.) são injetadas via `acoesContexto`, que
  cada tela passa conforme seu perfil/contexto. Entrar em fila administrativa
  NÃO transfere responsabilidade — a troca só acontece no bloco explícito
  "Alterar operador responsável" (visível só para Amanda/Fernanda master).

  Props:
    alunoId       -> uuid do aluno (obrigatório se não passar `aluno`)
    aluno         -> registro já carregado (opcional; evita 1 query)
    abaInicial    -> "resumo" | "negociacao" | "financeiro" | "historico"
    acoesContexto -> nó React com as ações da fila (render dentro do Resumo)
    onFechar      -> callback opcional (botão fechar)
    onAlterado    -> callback opcional após trocar responsável
*/

function moeda(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function data(v) {
  if (!v) return "-";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [a, m, d] = v.split("-");
    return `${d}/${m}/${a}`;
  }
  try { return new Date(v).toLocaleDateString("pt-BR"); } catch { return "-"; }
}
function dataHora(v) {
  if (!v) return "-";
  try { return new Date(v).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }); } catch { return "-"; }
}
function nomeAluno(a) {
  return a?.nome || a?.nome_aluno || a?.aluno || a?.nome_completo || "Aluno sem nome";
}

// Situação/saúde do caso — mesma leitura da Minha Carteira.
function diasSemContato(a) {
  const base = a?.data_ultimo_acionamento || a?.ultimo_contato || a?.responsavel_atual_em || null;
  if (!base) return null;
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function statusPrazo(a) {
  const sit = a?.status_atual || "";
  if (sit === "JURIDICO") return { label: "Jurídico", cor: "#7c3aed" };
  if (["ACORDO_FECHADO", "AGUARDANDO_BAIXA", "AGUARDANDO_COMPROVANTE", "SOLICITADO_LINK", "LINK_ENVIADO_AO_ALUNO"].includes(sit))
    return { label: "Aguardando pgto", cor: "#2563eb" };
  if (sit === "BAIXA_REALIZADA") return { label: "Pago", cor: "#16a34a" };
  if (["CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA"].includes(sit)) return { label: "Cancelado", cor: "#6b7280" };
  const dias = diasSemContato(a);
  if (dias === null) return { label: "Novo", cor: "#94a3b8" };
  if (dias <= 7) return { label: "Dentro do prazo", cor: "#16a34a" };
  if (dias === 8) return { label: "Atenção", cor: "#f59e0b" };
  if (dias <= 10) return { label: "Crítico", cor: "#dc2626" };
  return { label: "Perdendo o caso", cor: "#991b1b" };
}

const ABAS = [
  ["resumo", "Resumo"],
  ["negociacao", "Negociação"],
  ["financeiro", "Financeiro"],
  ["email", "E-mail"],
  ["historico", "Histórico"],
];

export default function FichaAlunoUnificada({
  alunoId,
  aluno: alunoProp = null,
  abaInicial = "resumo",
  acoesContexto = null,
  onFechar,
  onAlterado,
}) {
  const [aluno, setAluno] = useState(alunoProp);
  const [acordos, setAcordos] = useState([]);
  const [parcelas, setParcelas] = useState([]);
  const [movimentacoes, setMovimentacoes] = useState([]);
  const [aba, setAba] = useState(abaInicial);
  const [carregando, setCarregando] = useState(false);
  const [emailUsuario, setEmailUsuario] = useState("");

  const id = alunoId || alunoProp?.id;

  useEffect(() => {
    supabase.auth.getUser().then(({ data: d }) => setEmailUsuario(d?.user?.email || ""));
  }, []);

  useEffect(() => {
    if (!id) return;
    let ativo = true;
    (async () => {
      setCarregando(true);
      try {
        // 1) Aluno (fonte única). Se já veio por prop, recarrega mesmo assim
        //    para garantir dados frescos ao abrir a ficha.
        const { data: a } = await supabase.from("alunos").select("*").eq("id", id).maybeSingle();
        if (!ativo) return;
        const registro = a || alunoProp;
        setAluno(registro);

        const cpf = registro?.cpf;

        // 2) Acordos do aluno (por aluno_id e/ou cpf).
        let qAc = supabase.from("acordos").select("*");
        qAc = cpf ? qAc.or(`aluno_id.eq.${id},cpf.eq.${cpf}`) : qAc.eq("aluno_id", id);
        const { data: acs } = await qAc.order("criado_em", { ascending: false });
        if (!ativo) return;
        setAcordos(acs || []);

        // 3) Parcelas dos acordos.
        const ids = (acs || []).map((x) => x.id);
        if (ids.length) {
          const { data: ps } = await supabase
            .from("parcelas")
            .select("*")
            .in("acordo_id", ids)
            .order("numero", { ascending: true });
          if (!ativo) return;
          setParcelas(ps || []);
        } else {
          setParcelas([]);
        }

        // 4) Histórico (movimentações do aluno).
        const { data: mov } = await supabase
          .from("aluno_movimentacoes")
          .select("id,tipo,descricao,status_novo,registrado_por_nome,registrado_em")
          .eq("aluno_id", String(id))
          .order("registrado_em", { ascending: false })
          .limit(50);
        if (!ativo) return;
        setMovimentacoes(mov || []);
      } finally {
        if (ativo) setCarregando(false);
      }
    })();
    return () => { ativo = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const master = podeVerTudo(emailUsuario);

  // Responsável do acordo = do acordo mais recente que tenha responsável.
  const respAcordo = useMemo(() => {
    const comResp = acordos.find((a) => a.operador_responsavel_nome || a.operador_responsavel_email);
    if (!comResp) return null;
    return comResp.operador_responsavel_nome || comResp.operador_responsavel_email;
  }, [acordos]);

  const totais = useMemo(() => {
    const honorarios = acordos.reduce((s, a) => s + (Number(a.honorarios_valor) || 0), 0);
    const pagas = parcelas.filter((p) => p.status === "PAGO");
    const aVencer = parcelas.filter((p) => p.status !== "PAGO");
    return {
      honorarios,
      totalPago: pagas.reduce((s, p) => s + (Number(p.valor) || 0), 0),
      totalAberto: aVencer.reduce((s, p) => s + (Number(p.valor) || 0), 0),
      qtdPagas: pagas.length,
      qtdAVencer: aVencer.length,
    };
  }, [acordos, parcelas]);

  if (!id) return <div style={S.vazio}>Selecione um registro para ver a ficha.</div>;

  const sp = aluno ? statusPrazo(aluno) : null;

  return (
    <div style={S.ficha}>
      <div style={S.topo}>
        <div style={{ minWidth: 0 }}>
          <h2 style={S.nome}>{nomeAluno(aluno)}</h2>
          <div style={S.subTopo}>
            {aluno?.cpf ? <span>CPF: {aluno.cpf}</span> : null}
            {sp ? (
              <span style={{ ...S.badgeStatus, color: sp.cor }}>
                <span style={{ ...S.bolinha, background: sp.cor }} /> {sp.label}
              </span>
            ) : null}
          </div>
        </div>
        {onFechar ? (
          <button style={S.btnFechar} onClick={onFechar}>✕</button>
        ) : null}
      </div>

      <div style={S.abas}>
        {ABAS.map(([chave, rot]) => (
          <button
            key={chave}
            onClick={() => setAba(chave)}
            style={aba === chave ? S.abaAtiva : S.abaInativa}
          >
            {rot}
          </button>
        ))}
      </div>

      {carregando && <p style={S.carregando}>Carregando ficha...</p>}

      {aba === "resumo" && (
        <div>
          <div style={S.grid}>
            <Info rot="Responsável (mensalidades)" val={aluno?.responsavel_atual_nome || "-"} />
            <Info rot="Responsável do acordo" val={respAcordo || "—"} />
            <Info rot="Telefone" val={aluno?.telefone || "-"} />
            <Info rot="Situação" val={aluno?.status_atual || aluno?.status_jornada || "-"} />
            <Info rot="Último contato" val={data(aluno?.data_ultimo_acionamento || aluno?.ultimo_contato)} />
            <Info rot="Próximo contato" val={`${data(aluno?.data_retorno)}${aluno?.hora_retorno ? " " + aluno.hora_retorno : ""}`} />
            <Info rot="Valor em aberto" val={moeda(aluno?.valor_em_aberto)} />
            <Info rot="Honorários" val={moeda(totais.honorarios)} />
          </div>

          {aluno?.observacao ? (
            <div style={S.obs}><strong>Observação:</strong> {aluno.observacao}</div>
          ) : null}

          {/* Ações específicas da fila (contexto/perfil) */}
          {acoesContexto ? <div style={S.contexto}>{acoesContexto}</div> : null}

          {/* Troca de responsável — só master; entrar em fila NÃO transfere. */}
          <TelefonesAluno aluno={aluno} />

        {master && aluno?.id ? (
            <AlterarOperadorResponsavel
              aluno={aluno}
              origem="ficha_unificada"
              onAlterado={onAlterado}
            />
          ) : null}
        </div>
      )}

      {aba === "negociacao" && (
        <div>
          {acordos.length === 0 && <p style={S.subInfo}>Nenhum acordo registrado para este aluno.</p>}
          {acordos.map((ac) => {
            const ps = parcelas.filter((p) => p.acordo_id === ac.id);
            return (
              <div key={ac.id} style={S.blocoAcordo}>
                <div style={S.acordoTopo}>
                  <strong>Acordo #{ac.numero_acordo ?? "-"}</strong>
                  <span style={S.badgeSituacao}>{ac.status || "-"}</span>
                </div>
                <div style={S.grid}>
                  <Info rot="Tipo / Forma" val={`${ac.tipo || "-"} / ${ac.forma_pagamento || "-"}`} />
                  <Info rot="Valor total" val={moeda(ac.valor_total)} />
                  <Info rot="Parcelas" val={ac.qtd_parcelas ?? "-"} />
                  <Info rot="Entrada" val={ac.valor_entrada != null ? moeda(ac.valor_entrada) : "-"} />
                  <Info rot="Honorários" val={moeda(ac.honorarios_valor)} />
                  <Info rot="Responsável do acordo" val={ac.operador_responsavel_nome || ac.operador_responsavel_email || "—"} />
                </div>
                {ps.length > 0 && (
                  <div style={S.tabelaParc}>
                    {ps.map((p) => (
                      <div key={p.id} style={S.linhaParc}>
                        <span style={S.parcNum}>{p.numero}ª</span>
                        <span>{data(p.vencimento)}</span>
                        <span>{moeda(p.valor)}</span>
                        <span style={{ color: p.status === "PAGO" ? "#16a34a" : "#64748b", fontWeight: 600 }}>
                          {p.status || "-"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {aba === "financeiro" && (
        <div>
          <div style={S.grid}>
            <Info rot="Valor em aberto (ficha)" val={moeda(aluno?.valor_em_aberto)} />
            <Info rot="Honorários (acordos)" val={moeda(totais.honorarios)} />
            <Info rot="Total pago (parcelas)" val={moeda(totais.totalPago)} />
            <Info rot="Total a vencer (parcelas)" val={moeda(totais.totalAberto)} />
            <Info rot="Parcelas pagas" val={totais.qtdPagas} />
            <Info rot="Parcelas a vencer" val={totais.qtdAVencer} />
          </div>
          <p style={S.subInfo}>
            Dados financeiros somente leitura aqui. As baixas e a montagem de acordo
            continuam nas ações da fila (não há formulário paralelo).
          </p>
        </div>
      )}

      {aba === "email" && (
        <div style={{ paddingTop: 4 }}>
          <EmailAlunoUnificado aluno={aluno} />
        </div>
      )}

      {aba === "historico" && (
        <div style={S.historico}>
          {movimentacoes.length === 0 && <p style={S.subInfo}>Sem movimentações registradas.</p>}
          {movimentacoes.map((h) => (
            <div key={h.id} style={S.itemHist}>
              <div style={S.histData}>{dataHora(h.registrado_em)}</div>
              <div style={S.histDesc}>{h.descricao || h.tipo || h.status_novo || "Movimentação"}</div>
              {h.registrado_por_nome && <div style={S.histAutor}>por {h.registrado_por_nome}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Info({ rot, val }) {
  return (
    <div style={S.linhaInfo}>
      <span style={S.rot}>{rot}</span>
      <span style={S.val}>{val}</span>
    </div>
  );
}

const S = {
  ficha: { background: "#fff", borderRadius: 14, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" },
  vazio: { color: "#94a3b8", padding: 20 },
  topo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, borderBottom: "1px solid #f1f5f9", paddingBottom: 12, marginBottom: 12 },
  nome: { margin: 0, fontSize: 18, color: "#0f172a" },
  subTopo: { display: "flex", gap: 14, alignItems: "center", marginTop: 6, fontSize: 13, color: "#64748b" },
  badgeStatus: { display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 },
  bolinha: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
  btnFechar: { border: "none", background: "#f1f5f9", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 14, color: "#475569" },
  abas: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, borderBottom: "1px solid #e2e8f0", paddingBottom: 10 },
  abaAtiva: { border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", background: "#2563eb", color: "#fff" },
  abaInativa: { border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", background: "#eef2f7", color: "#475569" },
  carregando: { color: "#64748b", fontSize: 13 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "4px 16px", marginBottom: 10 },
  linhaInfo: { display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0", fontSize: 13.5, borderBottom: "1px dashed #f1f5f9" },
  rot: { color: "#64748b" },
  val: { color: "#0f172a", fontWeight: 600, textAlign: "right" },
  obs: { marginTop: 10, background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, color: "#374151", fontSize: 13.5 },
  contexto: { marginTop: 14, borderTop: "1px solid #f1f5f9", paddingTop: 14 },
  subInfo: { color: "#94a3b8", fontSize: 13, marginTop: 10 },
  blocoAcordo: { border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, marginBottom: 12 },
  acordoTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  badgeSituacao: { display: "inline-block", padding: "3px 9px", borderRadius: 999, background: "#e0edff", color: "#1d4ed8", fontSize: 12, fontWeight: 600 },
  tabelaParc: { marginTop: 10, borderTop: "1px solid #f1f5f9" },
  linhaParc: { display: "grid", gridTemplateColumns: "40px 1fr 1fr 1fr", gap: 8, padding: "6px 0", fontSize: 13, borderBottom: "1px solid #f8fafc", alignItems: "center" },
  parcNum: { fontWeight: 700, color: "#475569" },
  historico: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 420, overflowY: "auto" },
  itemHist: { borderLeft: "2px solid #e2e8f0", paddingLeft: 10 },
  histData: { fontSize: 11.5, color: "#94a3b8" },
  histDesc: { fontSize: 13, color: "#334155" },
  histAutor: { fontSize: 11.5, color: "#94a3b8" },
};
