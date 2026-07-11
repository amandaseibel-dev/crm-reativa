import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { podeGerirFinanceiro, nomeOperadorPorEmail } from "../utils/operadores";

const STATUS_LABEL = {
  AGUARDANDO_CONFIRMACAO: "Aguardando confirmação",
  PAGAMENTO_CONFIRMADO: "Pagamento confirmado (baixado)",
  PAGAMENTO_REJEITADO: "Pagamento rejeitado (não identificado)",
};

// Tipos de pagamento informado (forma_pagamento) -> rotulo curto na fila.
const TIPO_LABEL = {
  A_VISTA: "Quitação/à vista",
  QUITACAO: "Quitação",
  PARCELADO: "Acordo parcelado",
  ENTRADA: "Entrada",
  PARCELA: "Parcela",
};

function traduzStatus(status) {
  return STATUS_LABEL[status] || status || "-";
}

function traduzTipo(forma) {
  if (!forma) return "Não informado";
  return TIPO_LABEL[forma] || forma;
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
  const numero = Number(valor);
  if (Number.isNaN(numero)) return "-";
  return numero.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function valorTitulo(t) {
  return Number(t.valor_em_aberto ?? t.saldo_corrigido ?? t.valor_original ?? 0);
}

function corStatus(status) {
  if (status === "PAGAMENTO_CONFIRMADO") {
    return { background: "#d1e7dd", color: "#0f5132", border: "1px solid #badbcc" };
  }
  if (status === "PAGAMENTO_REJEITADO") {
    return { background: "#f8d7da", color: "#842029", border: "1px solid #f5c2c7" };
  }
  return { background: "#fff3cd", color: "#664d03", border: "1px solid #ffe69c" };
}

export default function FilaConfirmacaoPagamento() {
  const [usuario, setUsuario] = useState(null);
  const [solicitacoes, setSolicitacoes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [observacoes, setObservacoes] = useState({});
  const [filtro, setFiltro] = useState("PENDENTES");

  // Ficha do aluno (modal leve reaproveitando as pecas ja existentes:
  // financeiro em aberto, historico de movimentacoes e comprovante).
  const [detalhe, setDetalhe] = useState(null); // solicitacao selecionada
  const [abaFicha, setAbaFicha] = useState("resumo");
  const [historico, setHistorico] = useState([]);
  const [parcelasAbertas, setParcelasAbertas] = useState([]);
  const [titulosAbertos, setTitulosAbertos] = useState([]);
  const [comprovante, setComprovante] = useState(null);
  const [comprovantesDisponiveis, setComprovantesDisponiveis] = useState([]);
  const [carregandoFicha, setCarregandoFicha] = useState(false);
  const [motivoRejeicao, setMotivoRejeicao] = useState("");

  // "Vincular dados" (so identificacao financeira; nao baixa/quita/altera saldo).
  const [vinculando, setVinculando] = useState(false);
  const [salvandoVinc, setSalvandoVinc] = useState(false);
  const [vinc, setVinc] = useState(null); // { tipo, valor, data, alvoTipo, alvoId, comprovanteLinkId }

  useEffect(() => {
    carregarUsuario();
    carregarSolicitacoes();
  }, []);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarSolicitacoes() {
    setCarregando(true);
    const { data, error } = await supabase
      .from("solicitacoes_confirmacao_pagamento")
      .select("*")
      .order("criado_em", { ascending: false });

    if (error) {
      alert("Erro ao carregar fila de confirmação de pagamento: " + error.message);
      setCarregando(false);
      return;
    }
    setSolicitacoes(data || []);
    setCarregando(false);
  }

  // ---- Ficha do aluno (abre no clique, sem sair da pagina) ----
  async function abrirFicha(s) {
    setDetalhe(s);
    setAbaFicha("resumo");
    setMotivoRejeicao(observacoes[s.id] || "");
    setHistorico([]);
    setParcelasAbertas([]);
    setTitulosAbertos([]);
    setComprovante(null);
    setComprovantesDisponiveis([]);
    setVinculando(false);
    setVinc({
      tipo: s.tipo_pagamento || "",
      valor: s.valor_informado != null ? String(s.valor_informado) : "",
      data: s.data_pagamento || "",
      alvoTipo: s.parcela_id ? "PARCELA" : s.titulo_id ? "TITULO" : s.acordo_id ? "ACORDO" : "",
      alvoId: s.parcela_id || s.titulo_id || s.acordo_id || "",
      comprovanteLinkId: s.comprovante_link_id || "",
    });
    setCarregandoFicha(true);
    try {
      // Historico do aluno.
      if (s.aluno_id) {
        const { data: mov } = await supabase
          .from("aluno_movimentacoes")
          .select("id,tipo,descricao,status_anterior,status_novo,registrado_por_nome,registrado_em,valor_movimentacao")
          .eq("aluno_id", String(s.aluno_id))
          .order("registrado_em", { ascending: false })
          .limit(40);
        setHistorico(mov || []);

        // Parcelas em aberto (mesma consulta ja usada nesta tela).
        const { data: parc } = await supabase
          .from("parcelas")
          .select("id, numero, valor, honorarios, vencimento, status, acordos!inner(id, aluno_id)")
          .eq("acordos.aluno_id", String(s.aluno_id))
          .in("status", ["A_VENCER", "VENCIDA"])
          .order("vencimento", { ascending: true });
        setParcelasAbertas(parc || []);

        // Titulos/mensalidades importados em aberto.
        let qTit = supabase
          .from("acordos_titulos")
          .select("id, documento, vencimento, valor_original, saldo_corrigido, valor_em_aberto, status")
          .eq("status", "em_aberto")
          .order("vencimento", { ascending: true });
        qTit = s.aluno_id ? qTit.eq("aluno_id", String(s.aluno_id)) : qTit.eq("cpf", s.aluno_cpf);
        const { data: tit } = await qTit;
        setTitulosAbertos(tit || []);

        // Comprovante: procura o mais recente vinculado ao aluno (fluxo de
        // links/baixas). So exibe se existir; nao cria nada.
        const { data: linksComp } = await supabase
          .from("links_pagamento")
          .select("id, comprovante_url, comprovante_nome, comprovante_anexado_em, observacao_comprovante, status")
          .eq("aluno_id", String(s.aluno_id))
          .not("comprovante_url", "is", null)
          .order("comprovante_anexado_em", { ascending: false });
        if (linksComp && linksComp.length) {
          setComprovante(linksComp[0]);
          setComprovantesDisponiveis(linksComp);
        }
      }
    } catch (e) {
      console.error("Erro ao carregar ficha:", e);
    } finally {
      setCarregandoFicha(false);
    }
  }

  function fecharFicha() {
    setDetalhe(null);
  }

  const totalAbertoParcelas = useMemo(
    () => parcelasAbertas.reduce((s, p) => s + Number(p.valor || 0), 0),
    [parcelasAbertas]
  );
  const totalAbertoTitulos = useMemo(
    () => titulosAbertos.reduce((s, t) => s + valorTitulo(t), 0),
    [titulosAbertos]
  );

  // Dados minimos para permitir a confirmacao definitiva.
  function dadosMinimosOk(s) {
    if (!s) return false;
    const temValor = Number(s.valor_informado) > 0;
    const temData = !!s.data_pagamento;
    const temTipo = !!s.tipo_pagamento;
    const temAlvo = !!(s.parcela_id || s.acordo_id || s.titulo_id);
    const temOperador = !!s.operador_email;
    return temValor && temData && temTipo && temAlvo && temOperador;
  }

  // Confirmacao definitiva exige composicao VALIDADA (auditoria) e valor pago
  // igual ao total negociado. Sem baixa/quitacao nesta etapa.
  function composicaoValidadaOk(s) {
    if (!s) return false;
    const validada = !!s.composicao_validada_em && !!s.composicao_validada_por_email;
    const bate =
      s.total_negociado != null &&
      Math.abs(Number(s.valor_informado || 0) - Number(s.total_negociado || 0)) < 0.005;
    return validada && bate;
  }

  const saldoAtual = totalAbertoParcelas + totalAbertoTitulos;
  const valorVinc = vinc ? Number(String(vinc.valor).replace(",", ".")) || 0 : 0;
  const saldoApos = Math.max(0, saldoAtual - valorVinc);

  // ---- Vincular dados (SOMENTE identificacao financeira) ----
  // Nao baixa parcela, nao quita titulo, nao altera saldo, nao muda o aluno
  // para BAIXA_REALIZADA e nao remove a solicitacao da fila.
  async function salvarVinculo() {
    const s = detalhe;
    if (!s) return;
    if (!vinc.tipo) return alert("Selecione o tipo do pagamento.");
    if (valorVinc <= 0) return alert("Informe o valor pago (maior que zero).");
    if (!vinc.data) return alert("Informe a data do pagamento.");
    if (!vinc.alvoTipo || !vinc.alvoId) return alert("Selecione a dívida correspondente (parcela, título ou acordo).");

    setSalvandoVinc(true);
    try {
      const agora = new Date().toISOString();
      const upd = {
        tipo_pagamento: vinc.tipo,
        valor_informado: valorVinc,
        data_pagamento: vinc.data,
        parcela_id: vinc.alvoTipo === "PARCELA" ? vinc.alvoId : null,
        titulo_id: vinc.alvoTipo === "TITULO" ? vinc.alvoId : null,
        acordo_id: vinc.alvoTipo === "ACORDO" ? vinc.alvoId : null,
        comprovante_link_id: vinc.comprovanteLinkId || null,
        dados_vinculados_em: agora,
        dados_vinculados_por_email: usuario?.email || "",
        atualizado_em: agora,
        // NAO altera status, aluno, saldo, parcelas nem tira da fila.
      };
      const { error } = await supabase
        .from("solicitacoes_confirmacao_pagamento")
        .update(upd)
        .eq("id", s.id);
      if (error) {
        alert("Erro ao vincular dados: " + error.message);
        return;
      }
      alert("Dados financeiros vinculados. (Isso não confirma o pagamento nem baixa a dívida.)");
      const atualizado = { ...s, ...upd };
      setDetalhe(atualizado);
      setVinculando(false);
      setSolicitacoes((prev) => prev.map((x) => (x.id === s.id ? { ...x, ...upd } : x)));
    } finally {
      setSalvandoVinc(false);
    }
  }

  // ---- Confirmar (fluxo atual preservado) ----
  async function finalizarSolicitacao(s, observacaoExtra) {
    if (!dadosMinimosOk(s) || !composicaoValidadaOk(s)) {
      return alert(
        "Confirmação bloqueada: exige composição validada (data e e-mail do financeiro) e valor pago igual ao total negociado."
      );
    }
    const emailConfirmando = usuario?.email || "";
    const agora = new Date().toISOString();
    const observacaoAdm = [observacoes[s.id], observacaoExtra].filter(Boolean).join(" — ");

    const { error } = await supabase
      .from("solicitacoes_confirmacao_pagamento")
      .update({
        status: "PAGAMENTO_CONFIRMADO",
        observacao_adm: observacaoAdm || null,
        confirmado_por: emailConfirmando,
        confirmado_em: agora,
        atualizado_em: agora,
      })
      .eq("id", s.id);

    if (error) {
      alert("Erro ao confirmar pagamento: " + error.message);
      return;
    }

    if (s.aluno_id) {
      await supabase
        .from("alunos")
        .update({
          status_jornada: "BAIXA_REALIZADA",
          status_atual: "BAIXA_REALIZADA",
          status_acionamento: "BAIXA_REALIZADA",
          data_ultimo_acionamento: agora,
        })
        .eq("id", s.aluno_id);
    }

    alert("Pagamento confirmado e baixado no sistema.");
    fecharFicha();
    carregarSolicitacoes();
  }

  // ---- Rejeitar / devolver para correcao (motivo obrigatorio) ----
  async function rejeitarPagamento(s, motivoTexto) {
    try {
      await supabase.auth.getSession();
    } catch {
      // Segue e deixa o erro real aparecer.
    }

    const motivo = (motivoTexto ?? observacoes[s.id] ?? "").trim();
    if (!motivo) {
      alert("Escreva o motivo da rejeição antes de devolver (ex: comprovante ilegível, valor divergente, CPF divergente, pagamento não localizado).");
      return;
    }

    const agora = new Date().toISOString();
    const emailConfirmando = usuario?.email || "";

    const { error } = await supabase
      .from("solicitacoes_confirmacao_pagamento")
      .update({
        status: "PAGAMENTO_REJEITADO",
        observacao_adm: motivo,
        confirmado_por: emailConfirmando,
        confirmado_em: agora,
        atualizado_em: agora,
      })
      .eq("id", s.id);

    if (error) {
      alert("Erro ao rejeitar: " + error.message);
      return;
    }

    // Volta pro operador com prioridade e alerta visivel na Minha Carteira.
    if (s.aluno_id) {
      await supabase
        .from("alunos")
        .update({
          nivel_criticidade: "URGENTE",
          status_acionamento: "Pagamento não confirmado: " + motivo,
        })
        .eq("id", s.aluno_id);

      // Registra o motivo no historico do aluno (nao conta como acionamento).
      await supabase.from("aluno_movimentacoes").insert({
        aluno_id: String(s.aluno_id),
        tipo: "PAGAMENTO_REJEITADO",
        descricao: "Confirmação de pagamento rejeitada/devolvida. Motivo: " + motivo,
        registrado_por_nome: nomeOperadorPorEmail(emailConfirmando),
        registrado_por_email: emailConfirmando,
        registrado_em: agora,
      });
    }

    alert("Pagamento devolvido ao operador com o motivo. O caso volta pro topo da fila dele.");
    fecharFicha();
    carregarSolicitacoes();
  }

  const emailUsuario = usuario?.email || "";
  const podeUsar = podeGerirFinanceiro(emailUsuario);

  const contadores = useMemo(() => {
    return {
      pendentes: solicitacoes.filter((s) => s.status === "AGUARDANDO_CONFIRMACAO").length,
      confirmados: solicitacoes.filter((s) => s.status === "PAGAMENTO_CONFIRMADO").length,
      todos: solicitacoes.length,
    };
  }, [solicitacoes]);

  // Ordenacao: (1) data/hora do envio (criado_em) mais recente primeiro;
  // (2) desempate por ultima atualizacao; (3) desempate por nome do aluno.
  const solicitacoesFiltradas = useMemo(() => {
    let base;
    if (filtro === "PENDENTES") base = solicitacoes.filter((s) => s.status === "AGUARDANDO_CONFIRMACAO");
    else if (filtro === "CONFIRMADOS") base = solicitacoes.filter((s) => s.status === "PAGAMENTO_CONFIRMADO");
    else base = solicitacoes;

    const ts = (v) => {
      const t = v ? new Date(v).getTime() : 0;
      return Number.isNaN(t) ? 0 : t;
    };
    return [...base].sort((a, b) => {
      const d = ts(b.criado_em) - ts(a.criado_em);
      if (d !== 0) return d;
      const u = ts(b.atualizado_em) - ts(a.atualizado_em);
      if (u !== 0) return u;
      return String(a.aluno_nome || "").localeCompare(String(b.aluno_nome || ""), "pt-BR");
    });
  }, [solicitacoes, filtro]);

  if (carregando) {
    return <div style={styles.container}>Carregando fila de confirmação de pagamento...</div>;
  }

  if (!podeUsar) {
    return (
      <div style={styles.container}>
        <h1 style={styles.titulo}>Fila de Confirmação de Pagamento</h1>
        <div style={styles.alerta}>Seu usuário não tem permissão para acessar esta fila.</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.cabecalho}>
        <div>
          <h1 style={styles.titulo}>Fila de Confirmação de Pagamento</h1>
          <p style={styles.subtitulo}>
            Casos enviados pela operação (tabulação "Confirmar pagamento"), do mais recente para o mais antigo.
            Clique numa linha para abrir a ficha do aluno.
          </p>
        </div>
        <button style={styles.botaoAtualizar} onClick={carregarSolicitacoes}>
          Atualizar
        </button>
      </div>

      <div style={styles.cardsIndicadores}>
        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.pendentes}</span>
          <span style={styles.descricao}>Aguardando confirmação</span>
        </div>
        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.confirmados}</span>
          <span style={styles.descricao}>Confirmados</span>
        </div>
        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.todos}</span>
          <span style={styles.descricao}>Total</span>
        </div>
      </div>

      <div style={styles.filtros}>
        <button style={filtro === "PENDENTES" ? styles.filtroAtivo : styles.filtro} onClick={() => setFiltro("PENDENTES")}>
          Aguardando confirmação
        </button>
        <button style={filtro === "CONFIRMADOS" ? styles.filtroAtivo : styles.filtro} onClick={() => setFiltro("CONFIRMADOS")}>
          Confirmados
        </button>
        <button style={filtro === "TODOS" ? styles.filtroAtivo : styles.filtro} onClick={() => setFiltro("TODOS")}>
          Todos
        </button>
      </div>

      {solicitacoesFiltradas.length === 0 && (
        <div style={styles.vazio}>Nenhuma solicitação neste filtro.</div>
      )}

      {solicitacoesFiltradas.length > 0 && (
        <div style={styles.tabelaWrap}>
          <table style={styles.tabela}>
            <thead>
              <tr>
                <th style={styles.th}>Aluno</th>
                <th style={styles.th}>CPF</th>
                <th style={styles.th}>Operador que informou</th>
                <th style={styles.th}>Enviado em</th>
                <th style={styles.th}>Tipo informado</th>
                <th style={styles.thNum}>Valor informado</th>
                <th style={styles.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {solicitacoesFiltradas.map((s) => (
                <tr key={s.id} style={styles.tr} onClick={() => abrirFicha(s)} title="Abrir ficha do aluno">
                  <td style={styles.td}>{s.aluno_nome || "Aluno sem nome"}</td>
                  <td style={styles.td}>{s.aluno_cpf || "-"}</td>
                  <td style={styles.td}>{s.operador_nome || s.operador_email || "-"}</td>
                  <td style={styles.td}>{formatarData(s.criado_em)}</td>
                  <td style={styles.td}>{traduzTipo(s.forma_pagamento)}</td>
                  <td style={styles.tdNum}>{formatarMoeda(s.valor_informado)}</td>
                  <td style={styles.td}>
                    <span style={{ ...styles.status, ...corStatus(s.status) }}>{traduzStatus(s.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Ficha do aluno (modal) ---- */}
      {detalhe && (
        <div style={styles.overlay} onClick={fecharFicha}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalTopo}>
              <div>
                <h2 style={styles.modalNome}>{detalhe.aluno_nome || "Aluno sem nome"}</h2>
                <span style={styles.modalCpf}>CPF: {detalhe.aluno_cpf || "-"}</span>
              </div>
              <span style={{ ...styles.status, ...corStatus(detalhe.status) }}>{traduzStatus(detalhe.status)}</span>
              <button style={styles.fechar} onClick={fecharFicha}>✕</button>
            </div>

            <div style={styles.abas}>
              {["resumo", "financeiro", "historico", "comprovante"].map((a) => (
                <button
                  key={a}
                  style={abaFicha === a ? styles.abaAtiva : styles.aba}
                  onClick={() => setAbaFicha(a)}
                >
                  {a === "resumo" ? "Resumo" : a === "financeiro" ? "Financeiro" : a === "historico" ? "Histórico" : "Comprovante"}
                </button>
              ))}
            </div>

            <div style={styles.modalCorpo}>
              {carregandoFicha && <p style={styles.info}>Carregando ficha...</p>}

              {abaFicha === "resumo" && (
                <div>
                  <p style={styles.info}><strong>Operador que informou:</strong> {detalhe.operador_nome || detalhe.operador_email || "-"}</p>
                  <p style={styles.info}><strong>Enviado em:</strong> {formatarData(detalhe.criado_em)}</p>
                  <p style={styles.info}><strong>Última atualização:</strong> {formatarData(detalhe.atualizado_em)}</p>
                  <p style={styles.info}><strong>Tipo informado:</strong> {traduzTipo(detalhe.forma_pagamento)}</p>
                  <p style={styles.info}><strong>Valor informado:</strong> {formatarMoeda(detalhe.valor_informado)}</p>
                  <div style={styles.bloco}>
                    <strong>Observação do operador:</strong>
                    <p style={styles.paragrafo}>{detalhe.motivo || "Sem observação."}</p>
                  </div>
                  {detalhe.observacao_adm && (
                    <div style={styles.blocoRetorno}>
                      <strong>Observação de quem confirmou:</strong>
                      <p style={styles.paragrafo}>{detalhe.observacao_adm}</p>
                      <p style={styles.info}><strong>Por:</strong> {detalhe.confirmado_por || "-"} · {formatarData(detalhe.confirmado_em)}</p>
                    </div>
                  )}
                </div>
              )}

              {abaFicha === "financeiro" && (
                <div>
                  <p style={styles.info}>
                    <strong>Saldo em aberto (parcelas + títulos):</strong>{" "}
                    {formatarMoeda(totalAbertoParcelas + totalAbertoTitulos)}
                  </p>
                  <h4 style={styles.subttl}>Parcelas em aberto ({parcelasAbertas.length})</h4>
                  {parcelasAbertas.length === 0 ? (
                    <p style={styles.info}>Nenhuma parcela A_VENCER/VENCIDA.</p>
                  ) : (
                    parcelasAbertas.map((p) => (
                      <div key={p.id} style={styles.linhaFin}>
                        <span>Parcela {p.numero} · venc. {p.vencimento}</span>
                        <span>{p.status}</span>
                        <span>{formatarMoeda(p.valor)}</span>
                      </div>
                    ))
                  )}
                  <h4 style={styles.subttl}>Títulos/mensalidades em aberto ({titulosAbertos.length})</h4>
                  {titulosAbertos.length === 0 ? (
                    <p style={styles.info}>Nenhum título em aberto.</p>
                  ) : (
                    titulosAbertos.map((t) => (
                      <div key={t.id} style={styles.linhaFin}>
                        <span>{t.documento || "Título"} · venc. {t.vencimento}</span>
                        <span>{t.status}</span>
                        <span>{formatarMoeda(valorTitulo(t))}</span>
                      </div>
                    ))
                  )}
                </div>
              )}

              {abaFicha === "historico" && (
                <div>
                  {historico.length === 0 ? (
                    <p style={styles.info}>Sem histórico.</p>
                  ) : (
                    historico.map((h) => (
                      <div key={h.id} style={styles.linhaHist}>
                        <div style={styles.histTopo}>
                          <strong>{h.tipo}</strong>
                          <span style={styles.histData}>{formatarData(h.registrado_em)}</span>
                        </div>
                        {h.descricao && <p style={styles.paragrafo}>{h.descricao}</p>}
                        <span style={styles.histQuem}>{h.registrado_por_nome || "-"}</span>
                      </div>
                    ))
                  )}
                </div>
              )}

              {abaFicha === "comprovante" && (
                <div>
                  {comprovante ? (
                    <div>
                      <p style={styles.info}><strong>Arquivo:</strong> {comprovante.comprovante_nome || "comprovante"}</p>
                      <p style={styles.info}><strong>Anexado em:</strong> {formatarData(comprovante.comprovante_anexado_em)}</p>
                      {comprovante.observacao_comprovante && (
                        <p style={styles.info}><strong>Observação:</strong> {comprovante.observacao_comprovante}</p>
                      )}
                      <a href={comprovante.comprovante_url} target="_blank" rel="noreferrer" style={styles.botaoPequeno}>
                        Abrir comprovante
                      </a>
                    </div>
                  ) : (
                    <p style={styles.info}>Nenhum comprovante anexado a este aluno.</p>
                  )}
                </div>
              )}
            </div>

            {detalhe.status === "AGUARDANDO_CONFIRMACAO" && (() => {
              const completos = dadosMinimosOk(detalhe);
              const composValidada = composicaoValidadaOk(detalhe);
              const confirmavel = completos && composValidada;
              const acordoOptions = [
                ...new Map(parcelasAbertas.map((p) => [p.acordos?.id, p.acordos?.id])).keys(),
              ].filter(Boolean);
              return (
                <div style={styles.modalAcoes}>
                  {!completos && (
                    <div style={styles.incompleto}>
                      Dados financeiros incompletos — falta valor, data, tipo e/ou a
                      identificação da dívida (parcela, título ou acordo). A confirmação
                      definitiva fica bloqueada até vincular os dados.
                    </div>
                  )}

                  {/* Vincular dados (só identificação; não confirma, não baixa) */}
                  {vinculando ? (
                    <div style={styles.vincBox}>
                      <strong>Vincular dados do pagamento</strong>
                      <p style={styles.avisoLeve}>Vincular ≠ confirmar. Isto só salva a identificação financeira.</p>

                      <label style={styles.label}>Tipo do pagamento</label>
                      <select style={styles.input} value={vinc.tipo} onChange={(e) => setVinc({ ...vinc, tipo: e.target.value })}>
                        <option value="">Selecione…</option>
                        <option value="PARCELA">Parcela</option>
                        <option value="ENTRADA">Entrada</option>
                        <option value="ACORDO">Acordo</option>
                        <option value="MENSALIDADE">Mensalidade/título</option>
                        <option value="QUITACAO_TOTAL">Possível quitação total</option>
                      </select>

                      <div style={styles.linha2}>
                        <div style={{ flex: 1 }}>
                          <label style={styles.label}>Valor pago</label>
                          <input style={styles.input} placeholder="Ex.: 350,00" value={vinc.valor} onChange={(e) => setVinc({ ...vinc, valor: e.target.value })} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={styles.label}>Data do pagamento</label>
                          <input type="date" style={styles.input} value={vinc.data} onChange={(e) => setVinc({ ...vinc, data: e.target.value })} />
                        </div>
                      </div>

                      <label style={styles.label}>Dívida correspondente</label>
                      <select
                        style={styles.input}
                        value={vinc.alvoTipo && vinc.alvoId ? `${vinc.alvoTipo}:${vinc.alvoId}` : ""}
                        onChange={(e) => {
                          const [t, id] = e.target.value.split(":");
                          setVinc({ ...vinc, alvoTipo: t || "", alvoId: id || "" });
                        }}
                      >
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
                        {acordoOptions.length > 0 && (
                          <optgroup label="Acordos ativos">
                            {acordoOptions.map((id) => (
                              <option key={id} value={`ACORDO:${id}`}>Acordo {String(id).slice(0, 8)}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>

                      <label style={styles.label}>Comprovante (opcional, reaproveita o já anexado)</label>
                      <select style={styles.input} value={vinc.comprovanteLinkId} onChange={(e) => setVinc({ ...vinc, comprovanteLinkId: e.target.value })}>
                        <option value="">Sem comprovante vinculado</option>
                        {comprovantesDisponiveis.map((c) => (
                          <option key={c.id} value={c.id}>{c.comprovante_nome || "comprovante"} · {formatarData(c.comprovante_anexado_em)}</option>
                        ))}
                      </select>

                      <div style={styles.preview}>
                        <strong>Prévia</strong>
                        <p style={styles.info}>{detalhe.aluno_nome} · CPF {detalhe.aluno_cpf || "-"}</p>
                        <p style={styles.info}>Valor selecionado: {formatarMoeda(valorVinc)}</p>
                        <p style={styles.info}>Saldo atual (parcelas + títulos): {formatarMoeda(saldoAtual)}</p>
                        <p style={styles.info}>Saldo estimado após (referência): {formatarMoeda(saldoApos)}</p>
                      </div>

                      <div style={styles.acoes}>
                        <button style={styles.botaoConfirmar} disabled={salvandoVinc} onClick={salvarVinculo}>
                          {salvandoVinc ? "Salvando…" : "Salvar vínculo (não confirma)"}
                        </button>
                        <button style={styles.botaoCancelar} onClick={() => setVinculando(false)}>Cancelar</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={styles.bloco}>
                        <label style={styles.label}>Motivo (obrigatório para rejeitar/devolver)</label>
                        <textarea
                          style={styles.textarea}
                          placeholder="Ex.: comprovante ilegível, valor divergente, CPF divergente, pagamento não localizado, parcela incorreta, documento incompleto."
                          value={motivoRejeicao}
                          onChange={(e) => {
                            setMotivoRejeicao(e.target.value);
                            setObservacoes({ ...observacoes, [detalhe.id]: e.target.value });
                          }}
                        />
                      </div>
                      {completos && !composValidada && (
                        <div style={styles.incompleto}>
                          Confirmação definitiva bloqueada: exige composição validada (data e e-mail
                          do financeiro) e valor pago igual ao total negociado. Use "Vincular dados".
                        </div>
                      )}
                      <div style={styles.acoes}>
                        <button
                          style={confirmavel ? styles.botaoConfirmar : styles.botaoDesabilitado}
                          disabled={!confirmavel}
                          title={confirmavel ? "" : "Composição não validada ou valor ≠ total negociado"}
                          onClick={() => confirmavel && finalizarSolicitacao(detalhe)}
                        >
                          Confirmar pagamento
                        </button>
                        <button style={styles.botaoVincular} onClick={() => setVinculando(true)}>
                          Vincular dados
                        </button>
                        <button style={styles.botaoRejeitar} onClick={() => rejeitarPagamento(detalhe, motivoRejeicao)}>
                          Rejeitar / devolver
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: { padding: "24px", fontFamily: "Arial, sans-serif", background: "#f4f6f8", minHeight: "100vh" },
  cabecalho: { display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start", marginBottom: "18px" },
  titulo: { margin: 0, marginBottom: "6px", color: "#111827" },
  subtitulo: { margin: 0, color: "#4b5563" },
  botaoAtualizar: { background: "#111827", color: "#fff", border: "none", padding: "10px 16px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold", height: "fit-content" },
  cardsIndicadores: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px", marginBottom: "18px" },
  indicador: { background: "#fff", borderRadius: "12px", padding: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", gap: "4px" },
  numero: { fontSize: "26px", fontWeight: "bold", color: "#111827" },
  descricao: { fontSize: "13px", color: "#6b7280" },
  filtros: { display: "flex", gap: "10px", marginBottom: "18px", flexWrap: "wrap" },
  filtro: { background: "#fff", border: "1px solid #d1d5db", color: "#374151", padding: "8px 14px", borderRadius: "999px", cursor: "pointer", fontSize: "13px" },
  filtroAtivo: { background: "#0ea5e9", border: "1px solid #0ea5e9", color: "#fff", padding: "8px 14px", borderRadius: "999px", cursor: "pointer", fontSize: "13px", fontWeight: "bold" },
  vazio: { background: "#fff", borderRadius: "12px", padding: "20px", textAlign: "center", color: "#6b7280" },
  tabelaWrap: { background: "#fff", borderRadius: "14px", overflow: "hidden", boxShadow: "0 2px 10px rgba(0,0,0,0.06)" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: "14px" },
  th: { textAlign: "left", padding: "12px 10px", background: "#f1f5f9", color: "#475569", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.3px" },
  thNum: { textAlign: "right", padding: "12px 10px", background: "#f1f5f9", color: "#475569", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.3px" },
  tr: { cursor: "pointer", borderTop: "1px solid #eef2f7" },
  td: { padding: "12px 10px", color: "#374151" },
  tdNum: { padding: "12px 10px", color: "#111827", textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" },
  status: { padding: "6px 10px", borderRadius: "999px", fontWeight: "bold", fontSize: "12px", whiteSpace: "nowrap" },
  overlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "40px 16px", zIndex: 50, overflowY: "auto" },
  modal: { background: "#fff", borderRadius: "16px", width: "100%", maxWidth: "760px", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" },
  modalTopo: { display: "flex", alignItems: "center", gap: "14px", padding: "18px 20px", borderBottom: "1px solid #eef2f7" },
  modalNome: { margin: 0, color: "#111827", fontSize: "20px" },
  modalCpf: { color: "#6b7280", fontSize: "13px" },
  fechar: { marginLeft: "auto", background: "transparent", border: "none", fontSize: "18px", cursor: "pointer", color: "#6b7280" },
  abas: { display: "flex", gap: "8px", padding: "12px 20px 0", flexWrap: "wrap" },
  aba: { background: "#f1f5f9", border: "none", color: "#475569", padding: "8px 14px", borderRadius: "8px 8px 0 0", cursor: "pointer", fontSize: "13px" },
  abaAtiva: { background: "#0ea5e9", border: "none", color: "#fff", padding: "8px 14px", borderRadius: "8px 8px 0 0", cursor: "pointer", fontSize: "13px", fontWeight: "bold" },
  modalCorpo: { padding: "18px 20px", maxHeight: "50vh", overflowY: "auto" },
  subttl: { margin: "14px 0 6px", color: "#111827", fontSize: "14px" },
  info: { margin: "4px 0", color: "#374151", fontSize: "14px" },
  bloco: { marginTop: "12px" },
  blocoRetorno: { marginTop: "12px", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "12px" },
  paragrafo: { margin: "6px 0", color: "#374151", lineHeight: 1.4 },
  linhaFin: { display: "flex", justifyContent: "space-between", gap: "10px", padding: "8px 0", borderTop: "1px solid #eef2f7", fontSize: "13px", color: "#374151" },
  linhaHist: { padding: "10px 0", borderTop: "1px solid #eef2f7" },
  histTopo: { display: "flex", justifyContent: "space-between", gap: "10px" },
  histData: { color: "#94a3b8", fontSize: "12px" },
  histQuem: { color: "#94a3b8", fontSize: "12px" },
  modalAcoes: { padding: "16px 20px", borderTop: "1px solid #eef2f7" },
  label: { display: "block", fontWeight: "bold", marginBottom: "6px", color: "#111827", fontSize: "13px" },
  textarea: { width: "100%", minHeight: "70px", padding: "10px", borderRadius: "8px", border: "1px solid #ccc", resize: "vertical", boxSizing: "border-box", fontFamily: "Arial, sans-serif" },
  acoes: { marginTop: "12px", display: "flex", gap: "10px", flexWrap: "wrap" },
  botaoConfirmar: { background: "#198754", color: "#fff", border: "none", padding: "12px 18px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoRejeitar: { background: "#dc3545", color: "#fff", border: "none", padding: "12px 18px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoDesabilitado: { background: "#cbd5e1", color: "#64748b", border: "none", padding: "12px 18px", borderRadius: "8px", cursor: "not-allowed", fontWeight: "bold" },
  botaoVincular: { background: "#0ea5e9", color: "#fff", border: "none", padding: "12px 18px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  botaoCancelar: { background: "#e5e7eb", color: "#374151", border: "none", padding: "12px 18px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  incompleto: { background: "#fff7ed", color: "#9a3412", border: "1px solid #fed7aa", borderRadius: "8px", padding: "10px 12px", fontSize: "13px", marginBottom: "12px" },
  vincBox: { background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "14px" },
  avisoLeve: { color: "#64748b", fontSize: "12px", margin: "4px 0 10px" },
  linha2: { display: "flex", gap: "10px", flexWrap: "wrap" },
  preview: { background: "#eef6ff", border: "1px solid #cfe0f5", borderRadius: "8px", padding: "10px 12px", marginTop: "10px", marginBottom: "6px" },
  botaoPequeno: { display: "inline-block", marginTop: "8px", background: "#0ea5e9", color: "#fff", textDecoration: "none", padding: "8px 14px", borderRadius: "8px", fontWeight: "bold", fontSize: "13px" },
  aviso: { marginTop: "10px", color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "8px", padding: "8px 10px", fontSize: "12px" },
  alerta: { background: "#fff3cd", color: "#664d03", border: "1px solid #ffecb5", borderRadius: "10px", padding: "16px" },
};
