import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "../utils/operadores";

const STATUS_LABEL = {
  AGUARDANDO_CONFIRMACAO: "Aguardando confirmação",
  PAGAMENTO_CONFIRMADO: "Pagamento confirmado (baixado)",
  PAGAMENTO_REJEITADO: "Pagamento rejeitado (não identificado)",
};

// Tipos controlados (mesmo CHECK do banco). Sem texto livre.
const TIPOS_PAGAMENTO = [
  { v: "PARCELA", label: "Parcela" },
  { v: "ENTRADA", label: "Entrada" },
  { v: "ACORDO", label: "Acordo" },
  { v: "MENSALIDADE", label: "Mensalidade/título" },
  { v: "QUITACAO_TOTAL", label: "Possível quitação total" },
];

function traduzirStatus(status) {
  return STATUS_LABEL[status] || status || "-";
}

function corStatus(status) {
  if (status === "PAGAMENTO_CONFIRMADO") return { background: "#d1e7dd", color: "#0f5132", border: "1px solid #badbcc" };
  if (status === "PAGAMENTO_REJEITADO") return { background: "#f8d7da", color: "#842029", border: "1px solid #f5c2c7" };
  return { background: "#fff3cd", color: "#664d03", border: "1px solid #ffe69c" };
}

function formatarData(data) {
  if (!data) return "-";
  try {
    return new Date(data).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

function formatarMoeda(valor) {
  if (valor === null || valor === undefined || valor === "") return "-";
  const n = Number(valor);
  if (Number.isNaN(n)) return "-";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function valorTitulo(t) {
  return Number(t.valor_em_aberto ?? t.saldo_corrigido ?? t.valor_original ?? 0);
}

function pegarNomeAluno(aluno) {
  return aluno?.nome || aluno?.nome_aluno || aluno?.aluno || aluno?.nome_completo || "-";
}

function pegarCpfAluno(aluno) {
  return aluno?.cpf || aluno?.CPF || aluno?.cpf_mascarado || "-";
}

export default function ConfirmarPagamento({ aluno, tipoInicial = "", onSucesso }) {
  const [motivo, setMotivo] = useState("");
  // Valor NAO e mais pre-preenchido por uma fonte externa (casos.total_em_aberto
  // era stale/incorreto). A sugestao passa a vir da divida selecionada.
  const [valorInformado, setValorInformado] = useState("");
  const [tipo, setTipo] = useState(tipoInicial || "");
  const [dataPagamento, setDataPagamento] = useState("");
  const [alvo, setAlvo] = useState(""); // "PARCELA:<id>" | "TITULO:<id>" | "ACORDO:<id>"
  const [comprovanteLinkId, setComprovanteLinkId] = useState("");
  // Composicao financeira (principal vem da divida; encargos informados por
  // Amanda/Fernanda). total_negociado = principal + juros + multa + honorarios.
  const [juros, setJuros] = useState("");
  const [multa, setMulta] = useState("");
  const [honorarios, setHonorarios] = useState("");
  const [composicaoConferida, setComposicaoConferida] = useState(false);
  // Somente usuarios financeiros (pode_gerir_confirmacao_pagamento) compoem e
  // validam juros/multa/honorarios. O operador informa apenas o basico.
  const [podeCompor, setPodeCompor] = useState(false);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const email = data?.user?.email;
      if (!email) return;
      const { data: u } = await supabase
        .from("usuarios")
        .select("pode_gerir_confirmacao_pagamento")
        .eq("email", email)
        .eq("ativo", true)
        .maybeSingle();
      if (ativo) setPodeCompor(!!u?.pode_gerir_confirmacao_pagamento);
    })();
    return () => { ativo = false; };
  }, []);

  const [enviando, setEnviando] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [solicitacoes, setSolicitacoes] = useState([]);

  // Dividas abertas do aluno (para identificacao minima).
  const [parcelasAbertas, setParcelasAbertas] = useState([]);
  const [titulosAbertos, setTitulosAbertos] = useState([]);
  const [acordosAtivos, setAcordosAtivos] = useState([]);
  const [comprovantesDisponiveis, setComprovantesDisponiveis] = useState([]);
  const [carregandoDividas, setCarregandoDividas] = useState(false);

  const alunoId = aluno?.id ? String(aluno.id) : "";

  useEffect(() => {
    if (alunoId) {
      carregarSolicitacoes();
      carregarDividas();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alunoId]);

  async function carregarSolicitacoes() {
    if (!alunoId) return;
    setCarregando(true);
    const { data, error } = await supabase
      .from("solicitacoes_confirmacao_pagamento")
      .select("*")
      .eq("aluno_id", alunoId)
      .order("criado_em", { ascending: false });
    if (error) {
      console.error("Erro ao carregar solicitações de confirmação de pagamento:", error);
      setCarregando(false);
      return;
    }
    setSolicitacoes(data || []);
    setCarregando(false);
  }

  // Carrega SOMENTE dividas abertas, sem N+1 (3 consultas fixas):
  // parcelas A_VENCER/VENCIDA de acordos ATIVO; titulos em_aberto (nao
  // vinculados, ja excluidos pelo status); acordos ATIVO. Nada pago/quitado.
  async function carregarDividas() {
    if (!alunoId) return;
    setCarregandoDividas(true);
    try {
      const [{ data: parc }, { data: tit }, { data: acs }, { data: comp }] = await Promise.all([
        supabase
          .from("parcelas")
          .select("id, numero, valor, vencimento, status, acordos!inner(id, aluno_id, status)")
          .eq("acordos.aluno_id", alunoId)
          .eq("acordos.status", "ATIVO")
          .in("status", ["A_VENCER", "VENCIDA"])
          .order("vencimento", { ascending: true }),
        supabase
          .from("acordos_titulos")
          .select("id, documento, vencimento, valor_original, saldo_corrigido, valor_em_aberto, status")
          .eq("aluno_id", alunoId)
          .eq("status", "em_aberto")
          .order("vencimento", { ascending: true }),
        supabase
          .from("acordos")
          .select("id, status")
          .eq("aluno_id", alunoId)
          .eq("status", "ATIVO"),
        supabase
          .from("links_pagamento")
          .select("id, comprovante_nome, comprovante_anexado_em, comprovante_url")
          .eq("aluno_id", alunoId)
          .not("comprovante_url", "is", null)
          .order("comprovante_anexado_em", { ascending: false }),
      ]);
      setParcelasAbertas(parc || []);
      setTitulosAbertos(tit || []);
      setAcordosAtivos(acs || []);
      setComprovantesDisponiveis(comp || []);
    } catch (e) {
      console.error("Erro ao carregar dívidas abertas:", e);
    } finally {
      setCarregandoDividas(false);
    }
  }

  const ultimaSolicitacao = useMemo(() => (solicitacoes.length ? solicitacoes[0] : null), [solicitacoes]);
  const temPendente = useMemo(() => solicitacoes.some((s) => s.status === "AGUARDANDO_CONFIRMACAO"), [solicitacoes]);

  const valorNum = Number(String(valorInformado).replace(",", ".")) || 0;
  const [alvoTipo, alvoId] = alvo ? alvo.split(":") : ["", ""];

  // Fonte oficial da sugestao: sempre a divida detalhada (nunca casos.total_em_aberto).
  const sumParcelas = parcelasAbertas.reduce((s, p) => s + Number(p.valor || 0), 0);
  const sumTitulos = titulosAbertos.reduce((s, t) => s + valorTitulo(t), 0);
  const consolidado = sumParcelas + sumTitulos; // sem duplicidade (titulos vinculada ja excluidos)
  const somaParcelasAcordo = (acordoId) =>
    parcelasAbertas.filter((p) => p.acordos?.id === acordoId).reduce((s, p) => s + Number(p.valor || 0), 0);
  const valorDaDivida = () => {
    if (alvoTipo === "PARCELA") { const p = parcelasAbertas.find((x) => x.id === alvoId); return p ? Number(p.valor || 0) : 0; }
    if (alvoTipo === "TITULO") { const t = titulosAbertos.find((x) => x.id === alvoId); return t ? valorTitulo(t) : 0; }
    if (alvoTipo === "ACORDO") return somaParcelasAcordo(alvoId);
    return 0;
  };
  // Composicao financeira. Principal = da divida (item ou consolidado p/ quitacao
  // total). NAO representa o valor final: o aluno paga principal + encargos.
  const num = (v) => Number(String(v).replace(",", ".")) || 0;
  const jurosNum = num(juros);
  const multaNum = num(multa);
  const honorariosNum = num(honorarios);
  const principalNum = tipo === "QUITACAO_TOTAL" ? consolidado : valorDaDivida();
  const totalNegociado = principalNum + jurosNum + multaNum + honorariosNum;
  const diferenca = valorNum - totalNegociado; // valor pago - total negociado

  // Bloqueio da composicao SO se aplica ao financeiro (podeCompor). O operador
  // cria a solicitacao sem composicao (fica p/ o financeiro validar depois).
  const totalDivergente = totalNegociado > 0 && Math.abs(diferenca) > 0.005;
  const quitacaoBloqueada =
    podeCompor && tipo === "QUITACAO_TOTAL" && (!composicaoConferida || totalNegociado <= 0 || totalDivergente);

  // Sugere valor pago = total negociado ao compor (so financeiro). No fluxo do
  // operador, o valor pago e o que ele informa (nao e sobrescrito).
  useEffect(() => {
    if (podeCompor && totalNegociado > 0) setValorInformado(totalNegociado.toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podeCompor, tipo, alvo, juros, multa, honorarios, parcelasAbertas, titulosAbertos]);

  const podeEnviar =
    !!tipo && valorNum > 0 && !!dataPagamento && !!alvoTipo && !!alvoId &&
    motivo.trim().length > 0 && !quitacaoBloqueada;

  async function enviarParaConfirmacao() {
    if (!aluno?.id) return alert("Aluno não localizado.");
    if (temPendente) return alert("Este aluno já está na fila aguardando confirmação de pagamento.");

    // Identificacao minima obrigatoria (nao permite envio sem valor/dívida).
    if (!tipo) return alert("Selecione o tipo do pagamento.");
    if (valorNum <= 0) return alert("Informe o valor pago (maior que zero).");
    if (!dataPagamento) return alert("Informe a data do pagamento.");
    if (!alvoTipo || !alvoId) return alert("Selecione a dívida correspondente (parcela, título ou acordo).");
    // observacao nao e obrigatoria na confirmacao de pagamento
    if (podeCompor && tipo === "QUITACAO_TOTAL") {
      if (totalNegociado <= 0)
        return alert("Preencha a composição (principal + encargos) da quitação total.");
      if (!composicaoConferida)
        return alert("Confira a composição financeira (marque a conferência) antes de enviar a quitação total.");
      if (totalDivergente)
        return alert("O valor pago não corresponde ao total negociado (principal + juros + multa + honorários).");
    }

    setEnviando(true);

    const { data: userData } = await supabase.auth.getUser();
    const emailOperador = userData?.user?.email || "";
    if (!emailOperador) {
      setEnviando(false);
      return alert("Operador não autenticado.");
    }
    const nomeOperador = nomeOperadorPorEmail(emailOperador);

    const { error } = await supabase.from("solicitacoes_confirmacao_pagamento").insert({
      aluno_id: String(aluno.id),
      aluno_nome: pegarNomeAluno(aluno),
      aluno_cpf: pegarCpfAluno(aluno),
      operador_email: emailOperador,
      operador_nome: nomeOperador,
      tipo_pagamento: tipo,
      valor_informado: valorNum,
      data_pagamento: dataPagamento,
      parcela_id: alvoTipo === "PARCELA" ? alvoId : null,
      titulo_id: alvoTipo === "TITULO" ? alvoId : null,
      acordo_id: alvoTipo === "ACORDO" ? alvoId : null,
      comprovante_link_id: comprovanteLinkId || null,
      principal_referencia: podeCompor ? principalNum || null : null,
      juros: podeCompor ? jurosNum || null : null,
      multa: podeCompor ? multaNum || null : null,
      honorarios: podeCompor ? honorariosNum || null : null,
      total_negociado: podeCompor ? totalNegociado || null : null,
      composicao_validada_em: podeCompor && composicaoConferida ? new Date().toISOString() : null,
      composicao_validada_por_email: podeCompor && composicaoConferida ? emailOperador : null,
      motivo: motivo.trim(),
      status: "AGUARDANDO_CONFIRMACAO",
    });

    if (error) {
      alert("Erro ao enviar para confirmação de pagamento: " + error.message);
      setEnviando(false);
      return;
    }

    // Aluno vai para AGUARDANDO_BAIXA -- isto NAO representa baixa financeira,
    // apenas sinaliza que aguarda conferencia da Amanda/Fernanda.
    const agora = new Date().toISOString();
    await supabase
      .from("alunos")
      .update({
        status_jornada: "AGUARDANDO_BAIXA",
        status_atual: "AGUARDANDO_BAIXA",
        status_acionamento: "Aguardando confirmação de pagamento",
        data_ultimo_acionamento: agora,
      })
      .eq("id", aluno.id);

    alert("Enviado para a fila de confirmação de pagamento.");
    setMotivo("");
    setValorInformado("");
    setTipo("");
    setDataPagamento("");
    setAlvo("");
    setComprovanteLinkId("");
    setJuros("");
    setMulta("");
    setHonorarios("");
    setComposicaoConferida(false);
    setEnviando(false);
    carregarSolicitacoes();
    if (onSucesso) onSucesso();
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.titulo}>Tabulação — Confirmar pagamento</h2>
          <p style={styles.texto}>
            Use quando o aluno informar que já pagou. Identifique a dívida, o valor e a data.
            O caso vai para a fila de confirmação; a baixa financeira é feita pela Amanda/Fernanda.
          </p>
        </div>
        {ultimaSolicitacao && (
          <span style={{ ...styles.status, ...corStatus(ultimaSolicitacao.status) }}>
            {traduzirStatus(ultimaSolicitacao.status)}
          </span>
        )}
      </div>

      {temPendente ? (
        <div style={styles.alertaPendente}>Este aluno já está na fila de confirmação de pagamento.</div>
      ) : (
        <>
          <div style={styles.bloco}>
            <label style={styles.label}>Tipo do pagamento *</label>
            <select style={styles.input} value={tipo} onChange={(e) => setTipo(e.target.value)}>
              <option value="">Selecione…</option>
              {TIPOS_PAGAMENTO.map((t) => (
                <option key={t.v} value={t.v}>{t.label}</option>
              ))}
            </select>
            {tipo === "QUITACAO_TOTAL" && (
              <p style={styles.aviso}>
                "Possível quitação total" apenas informa a intenção. Não baixa parcelas, não
                quita títulos e não altera saldo — a confirmação financeira é feita depois pela Amanda/Fernanda.
              </p>
            )}
          </div>

          <div style={styles.linha2}>
            <div style={{ flex: 1 }}>
              <label style={styles.label}>Valor pago *</label>
              <input style={styles.input} placeholder="Ex: 350,00" value={valorInformado} onChange={(e) => setValorInformado(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={styles.label}>Data do pagamento *</label>
              <input type="date" style={styles.input} value={dataPagamento} onChange={(e) => setDataPagamento(e.target.value)} />
            </div>
          </div>

          {!podeCompor && (alvoTipo || tipo === "QUITACAO_TOTAL") && (
            <p style={styles.aviso}>
              A composição de juros, multa e honorários será validada pelo financeiro.
            </p>
          )}

          {podeCompor && (alvoTipo || tipo === "QUITACAO_TOTAL") && (
            <div style={styles.consol}>
              <div style={styles.consolTitulo}>Composição financeira</div>
              <div style={styles.consolLinha}>
                <span>Principal em aberto</span>
                <span>{formatarMoeda(principalNum)}</span>
              </div>
              <p style={styles.avisoLeve}>O principal não é o valor final: o aluno paga principal + juros + multa + honorários.</p>
              <div style={styles.linha3}>
                <div style={{ flex: 1 }}>
                  <label style={styles.labelPeq}>Juros</label>
                  <input style={styles.input} placeholder="0,00" value={juros} onChange={(e) => setJuros(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={styles.labelPeq}>Multa</label>
                  <input style={styles.input} placeholder="0,00" value={multa} onChange={(e) => setMulta(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={styles.labelPeq}>Honorários</label>
                  <input style={styles.input} placeholder="0,00" value={honorarios} onChange={(e) => setHonorarios(e.target.value)} />
                </div>
              </div>
              <div style={styles.consolLinha}><strong>Total negociado</strong><strong>{formatarMoeda(totalNegociado)}</strong></div>
              <div style={styles.consolLinha}><span>Valor pago</span><span>{formatarMoeda(valorNum)}</span></div>
              <div style={styles.consolLinha}><span>Diferença</span><span>{formatarMoeda(diferenca)}</span></div>
              {tipo === "QUITACAO_TOTAL" && (
                <>
                  {totalDivergente && (
                    <div style={styles.erroConsol}>O valor pago não corresponde ao total negociado</div>
                  )}
                  <label style={styles.conferir}>
                    <input type="checkbox" checked={composicaoConferida} onChange={(e) => setComposicaoConferida(e.target.checked)} />
                    <span>&nbsp;Conferi a composição (principal + juros + multa + honorários) para a quitação total.</span>
                  </label>
                </>
              )}
            </div>
          )}

          <div style={styles.bloco}>
            <label style={styles.label}>Dívida correspondente *</label>
            {carregandoDividas ? (
              <p style={styles.texto}>Carregando dívidas abertas…</p>
            ) : (
              <select style={styles.input} value={alvo} onChange={(e) => setAlvo(e.target.value)}>
                <option value="">Selecione parcela, título ou acordo…</option>
                {parcelasAbertas.length > 0 && (
                  <optgroup label="Parcelas em aberto">
                    {parcelasAbertas.map((p) => (
                      <option key={p.id} value={`PARCELA:${p.id}`}>
                        Parcela {p.numero} · venc. {p.vencimento} · {formatarMoeda(p.valor)}
                      </option>
                    ))}
                  </optgroup>
                )}
                {titulosAbertos.length > 0 && (
                  <optgroup label="Títulos/mensalidades em aberto">
                    {titulosAbertos.map((t) => (
                      <option key={t.id} value={`TITULO:${t.id}`}>
                        {t.documento || "Título"} · venc. {t.vencimento} · {formatarMoeda(valorTitulo(t))}
                      </option>
                    ))}
                  </optgroup>
                )}
                {acordosAtivos.length > 0 && (
                  <optgroup label="Acordos ativos">
                    {acordosAtivos.map((a) => (
                      <option key={a.id} value={`ACORDO:${a.id}`}>Acordo {String(a.id).slice(0, 8)}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            )}
            {!carregandoDividas &&
              parcelasAbertas.length === 0 &&
              titulosAbertos.length === 0 &&
              acordosAtivos.length === 0 && (
                <p style={styles.aviso}>
                  Nenhuma dívida aberta localizada para este aluno. Sem identificação da dívida
                  não é possível enviar para confirmação.
                </p>
              )}
          </div>

          {comprovantesDisponiveis.length > 0 && (
            <div style={styles.bloco}>
              <label style={styles.label}>Comprovante (opcional)</label>
              <select style={styles.input} value={comprovanteLinkId} onChange={(e) => setComprovanteLinkId(e.target.value)}>
                <option value="">Sem comprovante vinculado</option>
                {comprovantesDisponiveis.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.comprovante_nome || "comprovante"} · {formatarData(c.comprovante_anexado_em)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div style={styles.bloco}>
            <label style={styles.label}>Observação *</label>
            <textarea
              style={styles.textarea}
              placeholder="Exemplo: aluno mandou comprovante por WhatsApp, pagou via Pix."
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          </div>

          <button
            style={{
              ...styles.botao,
              ...(podeEnviar ? {} : styles.botaoDesabilitado),
            }}
            onClick={enviarParaConfirmacao}
            disabled={enviando || !podeEnviar}
            title={podeEnviar ? "" : "Preencha tipo, valor, data, dívida e observação."}
          >
            {enviando ? "Enviando..." : "Enviar para confirmação de pagamento"}
          </button>
        </>
      )}

      <div style={styles.historico}>
        <h3 style={styles.subtitulo}>Histórico deste aluno</h3>
        {carregando && <p style={styles.texto}>Carregando histórico...</p>}
        {!carregando && solicitacoes.length === 0 && <p style={styles.texto}>Nenhuma solicitação enviada ainda.</p>}
        {!carregando &&
          solicitacoes.map((s) => (
            <div key={s.id} style={styles.itemHistorico}>
              <div style={styles.linhaHistorico}>
                <strong>{traduzirStatus(s.status)}</strong>
                <span style={styles.dataHistorico}>{formatarData(s.criado_em)}</span>
              </div>
              <p style={styles.paragrafo}><strong>Operador:</strong> {s.operador_nome || s.operador_email || "-"}</p>
              {s.tipo_pagamento && <p style={styles.paragrafo}><strong>Tipo:</strong> {s.tipo_pagamento}</p>}
              {s.valor_informado != null && (
                <p style={styles.paragrafo}><strong>Valor informado:</strong> {formatarMoeda(s.valor_informado)}</p>
              )}
              {s.data_pagamento && <p style={styles.paragrafo}><strong>Data do pagamento:</strong> {s.data_pagamento}</p>}
              <p style={styles.paragrafo}><strong>Observação:</strong> {s.motivo || "-"}</p>
              {s.observacao_adm && (
                <p style={styles.paragrafo}><strong>Observação de quem confirmou:</strong> {s.observacao_adm}</p>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

const styles = {
  card: { background: "#fff", borderRadius: "14px", padding: "22px", marginTop: "24px", marginBottom: "24px", boxShadow: "0 2px 10px rgba(0,0,0,0.08)", borderLeft: "6px solid #0ea5e9" },
  header: { display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start", marginBottom: "16px" },
  titulo: { margin: 0, marginBottom: "8px", color: "#1f2937" },
  subtitulo: { marginTop: 0, marginBottom: "12px", color: "#1f2937" },
  texto: { color: "#555", margin: 0, lineHeight: 1.5 },
  status: { padding: "8px 12px", borderRadius: "999px", fontWeight: "bold", fontSize: "13px", whiteSpace: "nowrap" },
  alertaPendente: { background: "#fff3cd", color: "#664d03", border: "1px solid #ffecb5", borderRadius: "10px", padding: "12px", marginBottom: "16px" },
  bloco: { marginTop: "14px" },
  linha2: { display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "14px" },
  label: { display: "block", fontWeight: "bold", marginBottom: "6px", color: "#111827" },
  input: { width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #ccc", boxSizing: "border-box", fontFamily: "Arial, sans-serif" },
  textarea: { width: "100%", minHeight: "80px", padding: "10px", borderRadius: "8px", border: "1px solid #ccc", resize: "vertical", boxSizing: "border-box", fontFamily: "Arial, sans-serif" },
  aviso: { marginTop: "8px", color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "8px", padding: "8px 10px", fontSize: "12px" },
  consol: { marginTop: "10px", background: "#eef6ff", border: "1px solid #cfe0f5", borderRadius: "8px", padding: "10px 12px" },
  consolTitulo: { fontWeight: "bold", color: "#1e3a5f", marginBottom: "4px" },
  consolLinha: { display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "13px", color: "#1e3a5f", padding: "3px 0" },
  avisoLeve: { margin: "2px 0 8px", fontSize: "11.5px", color: "#64748b" },
  linha3: { display: "flex", gap: "8px", flexWrap: "wrap", margin: "6px 0" },
  labelPeq: { display: "block", fontSize: "12px", color: "#475569", marginBottom: "3px" },
  conferir: { display: "flex", alignItems: "flex-start", gap: "6px", marginTop: "8px", fontSize: "12.5px", color: "#1e3a5f", cursor: "pointer" },
  erroConsol: { marginTop: "6px", color: "#842029", background: "#f8d7da", border: "1px solid #f5c2c7", borderRadius: "6px", padding: "6px 8px", fontSize: "12px", fontWeight: "bold" },
  botao: { marginTop: "16px", background: "#0ea5e9", color: "#fff", border: "none", padding: "12px 18px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoDesabilitado: { background: "#cbd5e1", color: "#64748b", cursor: "not-allowed" },
  historico: { marginTop: "24px", borderTop: "1px solid #e5e7eb", paddingTop: "18px" },
  itemHistorico: { background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "12px", marginBottom: "10px" },
  linhaHistorico: { display: "flex", justifyContent: "space-between", gap: "10px", marginBottom: "8px" },
  dataHistorico: { fontSize: "12px", color: "#6b7280" },
  paragrafo: { margin: "6px 0", color: "#374151", lineHeight: 1.4 },
};
