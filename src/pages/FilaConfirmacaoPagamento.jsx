import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { podeGerirFinanceiro, nomeOperadorPorEmail } from "../utils/operadores";

const STATUS_LABEL = {
  AGUARDANDO_CONFIRMACAO: "Aguardando confirmação",
  PAGAMENTO_CONFIRMADO: "Pagamento confirmado (baixado)",
  PAGAMENTO_REJEITADO: "Pagamento rejeitado (não identificado)",
};

function traduzStatus(status) {
  return STATUS_LABEL[status] || status || "-";
}

function formatarData(data) {
  if (!data) return "-";

  try {
    return new Date(data).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

function hojeISO() {
  const d = new Date();
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function somarMeses(dataISO, meses) {
  const [ano, mes, dia] = dataISO.split("-").map(Number);
  const totalMeses = mes - 1 + meses;
  const anoFinal = ano + Math.floor(totalMeses / 12);
  const mesFinal = (totalMeses % 12) + 1;
  const ultimoDiaMes = new Date(anoFinal, mesFinal, 0).getDate();
  const diaFinal = Math.min(dia, ultimoDiaMes);
  return `${anoFinal}-${String(mesFinal).padStart(2, "0")}-${String(diaFinal).padStart(2, "0")}`;
}

function converterValor(valorDigitado) {
  let texto = String(valorDigitado || "")
    .replace("R$", "")
    .replace(/\s/g, "")
    .trim();

  const temVirgula = texto.includes(",");
  const temPonto = texto.includes(".");

  if (temVirgula && temPonto) {
    texto = texto.replace(/\./g, "").replace(",", ".");
  } else if (temVirgula) {
    texto = texto.replace(",", ".");
  } else if (temPonto) {
    const partes = texto.split(".");
    const ultimaParte = partes[partes.length - 1];

    if (partes.length === 2 && ultimaParte.length === 2) {
      // mantém, já é decimal
    } else {
      texto = texto.replace(/\./g, "");
    }
  }

  return Number(texto);
}

function formatarMoeda(valor) {
  if (valor === null || valor === undefined || valor === "") return "-";
  const numero = Number(valor);
  if (Number.isNaN(numero)) return "-";
  return numero.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function corStatus(status) {
  if (status === "PAGAMENTO_CONFIRMADO") {
    return {
      background: "#d1e7dd",
      color: "#0f5132",
      border: "1px solid #badbcc",
    };
  }

  if (status === "PAGAMENTO_REJEITADO") {
    return {
      background: "#f8d7da",
      color: "#842029",
      border: "1px solid #f5c2c7",
    };
  }

  return {
    background: "#fff3cd",
    color: "#664d03",
    border: "1px solid #ffe69c",
  };
}

export default function FilaConfirmacaoPagamento() {
  const [usuario, setUsuario] = useState(null);
  const [solicitacoes, setSolicitacoes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [observacoes, setObservacoes] = useState({});
  const [filtro, setFiltro] = useState("PENDENTES");
  const [construtor, setConstrutor] = useState({});
  const [parcelasAbertasPorAluno, setParcelasAbertasPorAluno] = useState({});
  const [titulosAbertosPorAluno, setTitulosAbertosPorAluno] = useState({});

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

  async function carregarParcelasAbertas(alunoId) {
    if (!alunoId) return;

    const { data, error } = await supabase
      .from("parcelas")
      .select("id, numero, valor, vencimento, status, acordos!inner(id, aluno_id)")
      .eq("acordos.aluno_id", String(alunoId))
      .in("status", ["A_VENCER", "VENCIDA"])
      .order("vencimento", { ascending: true });

    if (error) {
      console.error("Erro ao carregar parcelas em aberto:", error);
      return;
    }

    setParcelasAbertasPorAluno((atual) => ({ ...atual, [alunoId]: data || [] }));
  }

  // Titulos/mensalidades em aberto do aluno (borderos) que ainda nao estao
  // vinculados a nenhum acordo, para escolher quais entram neste acordo.
  async function carregarTitulosAbertos(alunoId, cpf) {
    if (!alunoId && !cpf) return;

    let query = supabase
      .from("acordos_titulos")
      .select("id, documento, vencimento, valor_original, saldo_corrigido, valor_em_aberto, status")
      .eq("status", "em_aberto")
      .order("vencimento", { ascending: true });

    query = alunoId ? query.eq("aluno_id", String(alunoId)) : query.eq("cpf", cpf);

    const { data, error } = await query;

    if (error) {
      console.error("Erro ao carregar titulos em aberto:", error);
      return;
    }

    setTitulosAbertosPorAluno((atual) => ({ ...atual, [alunoId]: data || [] }));
  }

  function valorTitulo(t) {
    return Number(t.valor_em_aberto ?? t.saldo_corrigido ?? t.valor_original ?? 0);
  }

  function abrirConstrutor(s) {
    setConstrutor((atual) => ({
      ...atual,
      [s.id]: atual[s.id] || {
        tipo: "PARCELADO",
        valorTotal: s.valor_informado != null ? String(s.valor_informado) : "",
        qtdParcelas: "1",
        temEntrada: false,
        valorEntrada: "",
        entradaPercentual: "",
        entradaPaga: true,
        honorarios: "",
        titulosSelecionados: [],
        parcelas: [],
      },
    }));

    carregarParcelasAbertas(s.aluno_id);
    carregarTitulosAbertos(s.aluno_id, s.aluno_cpf);
  }

  function fecharConstrutor(sId) {
    setConstrutor((atual) => {
      const copia = { ...atual };
      delete copia[sId];
      return copia;
    });
  }

  function atualizarCampoConstrutor(sId, campo, valor) {
    setConstrutor((atual) => ({
      ...atual,
      [sId]: { ...atual[sId], [campo]: valor },
    }));
  }

  // Entrada em R$ preenche o % automaticamente
  function atualizarEntradaRs(sId, valor) {
    setConstrutor((atual) => {
      const cfg = atual[sId];
      if (!cfg) return atual;
      const total = converterValor(cfg.valorTotal);
      const rs = converterValor(valor);
      const pct = total > 0 ? ((rs / total) * 100).toFixed(1) : "";
      return { ...atual, [sId]: { ...cfg, valorEntrada: valor, entradaPercentual: pct } };
    });
  }

  // Entrada em % preenche o R$ automaticamente
  function atualizarEntradaPct(sId, valor) {
    setConstrutor((atual) => {
      const cfg = atual[sId];
      if (!cfg) return atual;
      const total = converterValor(cfg.valorTotal);
      const pct = Number(String(valor).replace(",", ".")) || 0;
      const rs = total > 0 ? ((total * pct) / 100).toFixed(2) : "";
      return { ...atual, [sId]: { ...cfg, entradaPercentual: valor, valorEntrada: rs } };
    });
  }

  function alternarTitulo(sId, tituloId) {
    setConstrutor((atual) => {
      const cfg = atual[sId];
      if (!cfg) return atual;
      const jaTem = cfg.titulosSelecionados.includes(tituloId);
      const titulosSelecionados = jaTem
        ? cfg.titulosSelecionados.filter((id) => id !== tituloId)
        : [...cfg.titulosSelecionados, tituloId];
      return { ...atual, [sId]: { ...cfg, titulosSelecionados } };
    });
  }

  function usarSomaTitulos(sId, alunoId) {
    setConstrutor((atual) => {
      const cfg = atual[sId];
      if (!cfg) return atual;
      const titulos = titulosAbertosPorAluno[alunoId] || [];
      const soma = titulos
        .filter((t) => cfg.titulosSelecionados.includes(t.id))
        .reduce((acc, t) => acc + valorTitulo(t), 0);
      return { ...atual, [sId]: { ...cfg, valorTotal: soma.toFixed(2) } };
    });
  }

  function gerarParcelas(sId) {
    const cfg = construtor[sId];
    if (!cfg) return;

    const valorTotal = converterValor(cfg.valorTotal);

    if (!valorTotal || valorTotal <= 0) {
      alert("Informe o valor total do acordo.");
      return;
    }

    const honorariosTotal = converterValor(cfg.honorarios) || 0;

    if (cfg.tipo === "QUITACAO") {
      setConstrutor((atual) => ({
        ...atual,
        [sId]: {
          ...atual[sId],
          parcelas: [
            {
              numero: 1,
              vencimento: hojeISO(),
              valor: valorTotal.toFixed(2),
              honorarios: honorariosTotal.toFixed(2),
              status: "PAGO",
            },
          ],
        },
      }));
      return;
    }

    const qtd = Math.max(1, Number(cfg.qtdParcelas) || 1);
    const valorEntrada = cfg.temEntrada ? converterValor(cfg.valorEntrada) || 0 : 0;
    const valorRestante = Math.max(0, valorTotal - valorEntrada);
    const valorCada = qtd > 0 ? valorRestante / qtd : valorRestante;

    // Honorarios: parte proporcional na entrada, restante rateado nas parcelas
    const honEntrada = valorTotal > 0 ? honorariosTotal * (valorEntrada / valorTotal) : 0;
    const honSaldo = Math.max(0, honorariosTotal - honEntrada);
    const honCada = qtd > 0 ? honSaldo / qtd : honSaldo;

    const novasParcelas = [];
    for (let numero = 1; numero <= qtd; numero++) {
      novasParcelas.push({
        numero,
        vencimento: somarMeses(hojeISO(), numero - 1),
        valor: valorCada.toFixed(2),
        honorarios: honCada.toFixed(2),
        status: "A_VENCER",
      });
    }

    setConstrutor((atual) => ({
      ...atual,
      [sId]: { ...atual[sId], parcelas: novasParcelas },
    }));
  }

  function atualizarParcela(sId, index, campo, valor) {
    setConstrutor((atual) => {
      const cfg = atual[sId];
      if (!cfg) return atual;
      const parcelas = cfg.parcelas.map((p, i) => (i === index ? { ...p, [campo]: valor } : p));
      return { ...atual, [sId]: { ...cfg, parcelas } };
    });
  }

  async function finalizarSolicitacao(s, observacaoExtra) {
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

    fecharConstrutor(s.id);
    alert("Pagamento confirmado e baixado no sistema.");
    carregarSolicitacoes();
  }

  async function baixarParcelaExistente(s, parcela) {
    try {
      await supabase.auth.getSession();
    } catch {
      // Segue e deixa o erro real da próxima chamada aparecer.
    }

    const emailConfirmando = usuario?.email || "";
    const agora = new Date().toISOString();

    const { error: erroParcela } = await supabase
      .from("parcelas")
      .update({
        status: "PAGO",
        pago_em: agora,
        confirmado_por_email: emailConfirmando,
        solicitacao_confirmacao_id: s.id,
        atualizado_em: agora,
      })
      .eq("id", parcela.id);

    if (erroParcela) {
      alert("Erro ao dar baixa na parcela: " + erroParcela.message);
      return;
    }

    await finalizarSolicitacao(s, `Baixa na parcela ${parcela.numero} do acordo já existente.`);
  }

  async function salvarAcordoMontado(s) {
    const cfg = construtor[s.id];
    if (!cfg) return;

    if (!cfg.parcelas || cfg.parcelas.length === 0) {
      alert('Clique em "Gerar parcelas" antes de salvar.');
      return;
    }

    const valorTotal = converterValor(cfg.valorTotal);

    if (!valorTotal || valorTotal <= 0) {
      alert("Informe o valor total do acordo.");
      return;
    }

    try {
      await supabase.auth.getSession();
    } catch {
      // Segue e deixa o erro real da próxima chamada aparecer.
    }

    const valorEntrada = cfg.temEntrada ? converterValor(cfg.valorEntrada) || 0 : 0;
    const entradaPercentual =
      valorTotal > 0 && cfg.temEntrada ? Number(((valorEntrada / valorTotal) * 100).toFixed(2)) : null;
    const honorariosTotal = converterValor(cfg.honorarios) || 0;
    const saldo = Math.max(0, valorTotal - valorEntrada);
    const emailConfirmando = usuario?.email || "";
    const agora = new Date().toISOString();

    const { data: acordoCriado, error: erroAcordo } = await supabase
      .from("acordos")
      .insert({
        aluno_id: s.aluno_id,
        cpf: s.aluno_cpf,
        tipo: "ACORDO",
        forma_pagamento: cfg.tipo === "QUITACAO" ? "A_VISTA" : "PARCELADO",
        valor_total: valorTotal,
        qtd_parcelas: cfg.parcelas.length,
        valor_entrada: cfg.temEntrada ? valorEntrada : null,
        entrada_percentual: entradaPercentual,
        entrada_paga: cfg.temEntrada ? Boolean(cfg.entradaPaga) : null,
        data_entrada: cfg.temEntrada && cfg.entradaPaga ? hojeISO() : null,
        honorarios_valor: honorariosTotal || null,
        saldo: saldo,
        status: "ATIVO",
        observacao: s.motivo || null,
        criado_por_nome: nomeOperadorPorEmail(s.operador_email),
        criado_por_email: s.operador_email,
        confirmado_por_email: emailConfirmando,
        confirmado_em: agora,
      })
      .select()
      .single();

    if (erroAcordo) {
      alert("Erro ao criar acordo: " + erroAcordo.message);
      return;
    }

    const parcelasParaCriar = cfg.parcelas.map((p) => ({
      acordo_id: acordoCriado.id,
      numero: p.numero,
      valor: converterValor(p.valor),
      honorarios: p.honorarios != null ? converterValor(p.honorarios) : null,
      vencimento: p.vencimento,
      status: p.status,
      pago_em: p.status === "PAGO" ? agora : null,
      confirmado_por_email: p.status === "PAGO" ? emailConfirmando : null,
      solicitacao_confirmacao_id: p.status === "PAGO" ? s.id : null,
    }));

    const { error: erroParcelas } = await supabase.from("parcelas").insert(parcelasParaCriar);

    if (erroParcelas) {
      alert("Acordo criado, mas houve erro ao gerar as parcelas: " + erroParcelas.message);
      return;
    }

    // Vincula os titulos selecionados ao acordo e marca como vinculados.
    const titulosSelecionados = cfg.titulosSelecionados || [];
    if (titulosSelecionados.length > 0) {
      const vinculos = titulosSelecionados.map((tituloId) => ({
        acordo_id: acordoCriado.id,
        titulo_id: tituloId,
        ativo: true,
        vinculado_por: emailConfirmando,
      }));

      const { error: erroVinculo } = await supabase
        .from("acordo_titulo_vinculo")
        .insert(vinculos);

      if (erroVinculo) {
        console.error("Erro ao vincular titulos:", erroVinculo);
        alert("Acordo criado, mas houve erro ao vincular os títulos: " + erroVinculo.message);
      } else {
        await supabase
          .from("acordos_titulos")
          .update({ status: "vinculada", atualizado_em: agora })
          .in("id", titulosSelecionados);
      }
    }

    await finalizarSolicitacao(s, "Acordo criado pela ADM ao confirmar.");
  }

  async function rejeitarPagamento(solicitacao) {
    try {
      await supabase.auth.getSession();
    } catch {
      // Segue e deixa o erro real da próxima chamada aparecer.
    }

    const motivo = observacoes[solicitacao.id] || "";

    if (!motivo.trim()) {
      alert("Escreva o motivo da rejeição no campo de observação antes de rejeitar (ex: não identificado no extrato).");
      return;
    }

    const agora = new Date().toISOString();

    const { error } = await supabase
      .from("solicitacoes_confirmacao_pagamento")
      .update({
        status: "PAGAMENTO_REJEITADO",
        observacao_adm: motivo,
        confirmado_por: usuario?.email || "",
        confirmado_em: agora,
        atualizado_em: agora,
      })
      .eq("id", solicitacao.id);

    if (error) {
      alert("Erro ao rejeitar: " + error.message);
      return;
    }

    // Volta pro operador com prioridade máxima, igual link/termo, com o
    // motivo da rejeição explicado no status.
    if (solicitacao.aluno_id) {
      await supabase
        .from("alunos")
        .update({
          nivel_criticidade: "URGENTE",
          status_acionamento: "Pagamento não confirmado: " + motivo,
        })
        .eq("id", solicitacao.aluno_id);
    }

    alert("Pagamento rejeitado. O caso volta pro topo da fila do operador com o motivo.");
    carregarSolicitacoes();
  }

  const emailUsuario = usuario?.email || "";
  // Amanda ADM e Fernanda (supervisão) também precisam confirmar pagamento,
  // não só a Amanda gestora -- mesma regra de quem já mexe no financeiro.
  const podeUsar = podeGerirFinanceiro(emailUsuario);

  const contadores = useMemo(() => {
    return {
      pendentes: solicitacoes.filter((s) => s.status === "AGUARDANDO_CONFIRMACAO").length,
      confirmados: solicitacoes.filter((s) => s.status === "PAGAMENTO_CONFIRMADO").length,
      todos: solicitacoes.length,
    };
  }, [solicitacoes]);

  const solicitacoesFiltradas = useMemo(() => {
    if (filtro === "PENDENTES") {
      return solicitacoes.filter((s) => s.status === "AGUARDANDO_CONFIRMACAO");
    }

    if (filtro === "CONFIRMADOS") {
      return solicitacoes.filter((s) => s.status === "PAGAMENTO_CONFIRMADO");
    }

    return solicitacoes;
  }, [solicitacoes, filtro]);

  if (carregando) {
    return <div style={styles.container}>Carregando fila de confirmação de pagamento...</div>;
  }

  if (!podeUsar) {
    return (
      <div style={styles.container}>
        <h1 style={styles.titulo}>Fila de Confirmação de Pagamento</h1>

        <div style={styles.alerta}>
          Seu usuário não tem permissão para acessar esta fila.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.cabecalho}>
        <div>
          <h1 style={styles.titulo}>Fila de Confirmação de Pagamento</h1>
          <p style={styles.subtitulo}>
            Casos enviados pela operação (tabulação "Confirmar pagamento") aguardando baixa.
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
        <button
          style={filtro === "PENDENTES" ? styles.filtroAtivo : styles.filtro}
          onClick={() => setFiltro("PENDENTES")}
        >
          Aguardando confirmação
        </button>

        <button
          style={filtro === "CONFIRMADOS" ? styles.filtroAtivo : styles.filtro}
          onClick={() => setFiltro("CONFIRMADOS")}
        >
          Confirmados
        </button>

        <button
          style={filtro === "TODOS" ? styles.filtroAtivo : styles.filtro}
          onClick={() => setFiltro("TODOS")}
        >
          Todos
        </button>
      </div>

      {solicitacoesFiltradas.length === 0 && (
        <div style={styles.vazio}>Nenhuma solicitação neste filtro.</div>
      )}

      {solicitacoesFiltradas.map((s) => {
        const pendente = s.status === "AGUARDANDO_CONFIRMACAO";

        return (
          <div key={s.id} style={styles.card}>
            <div style={styles.topoCard}>
              <div>
                <h2 style={styles.nome}>{s.aluno_nome || "Aluno sem nome"}</h2>

                <p style={styles.info}>
                  <strong>CPF:</strong> {s.aluno_cpf || "Não informado"}
                </p>

                <p style={styles.info}>
                  <strong>Operador:</strong>{" "}
                  {s.operador_nome || s.operador_email || "Não informado"}
                </p>

                {s.valor_informado != null && (
                  <p style={styles.info}>
                    <strong>Valor informado:</strong>{" "}
                    {Number(s.valor_informado).toLocaleString("pt-BR", {
                      style: "currency",
                      currency: "BRL",
                    })}
                  </p>
                )}

                <p style={styles.info}>
                  <strong>Enviado em:</strong> {formatarData(s.criado_em)}
                </p>
              </div>

              <span style={{ ...styles.status, ...corStatus(s.status) }}>
                {traduzStatus(s.status)}
              </span>
            </div>

            <div style={styles.bloco}>
              <strong>Observação do operador:</strong>
              <p style={styles.paragrafo}>{s.motivo || "Sem observação."}</p>
            </div>

            {s.observacao_adm && (
              <div style={styles.blocoRetorno}>
                <strong>Observação de quem confirmou:</strong>
                <p style={styles.paragrafo}>{s.observacao_adm}</p>

                <p style={styles.info}>
                  <strong>Confirmado por:</strong> {s.confirmado_por || "-"}
                </p>

                <p style={styles.info}>
                  <strong>Confirmado em:</strong> {formatarData(s.confirmado_em)}
                </p>
              </div>
            )}

            {pendente && (
              <>
                <div style={styles.bloco}>
                  <label style={styles.label}>Observação (opcional)</label>
                  <textarea
                    style={styles.textarea}
                    placeholder="Exemplo: comprovante conferido no extrato do dia 01/07. Obrigatório se for rejeitar (ex: não identificado no extrato)."
                    value={observacoes[s.id] || ""}
                    onChange={(e) =>
                      setObservacoes({ ...observacoes, [s.id]: e.target.value })
                    }
                  />
                </div>

                <div style={styles.acoes}>
                  <button style={styles.botaoConfirmar} onClick={() => finalizarSolicitacao(s)}>
                    Confirmar (baixa já feita na ficha financeira do aluno)
                  </button>

                  <button style={styles.botaoRejeitar} onClick={() => rejeitarPagamento(s)}>
                    Rejeitar (não está pago)
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

const styles = {
  container: {
    padding: "24px",
    fontFamily: "Arial, sans-serif",
    background: "#f4f6f8",
    minHeight: "100vh",
  },
  cabecalho: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "flex-start",
    marginBottom: "18px",
  },
  titulo: {
    margin: 0,
    marginBottom: "6px",
    color: "#111827",
  },
  subtitulo: {
    margin: 0,
    color: "#4b5563",
  },
  botaoAtualizar: {
    background: "#111827",
    color: "#fff",
    border: "none",
    padding: "10px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
    height: "fit-content",
  },
  cardsIndicadores: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: "12px",
    marginBottom: "18px",
  },
  indicador: {
    background: "#fff",
    borderRadius: "12px",
    padding: "16px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  numero: {
    fontSize: "26px",
    fontWeight: "bold",
    color: "#111827",
  },
  descricao: {
    fontSize: "13px",
    color: "#6b7280",
  },
  filtros: {
    display: "flex",
    gap: "10px",
    marginBottom: "18px",
    flexWrap: "wrap",
  },
  filtro: {
    background: "#fff",
    border: "1px solid #d1d5db",
    color: "#374151",
    padding: "8px 14px",
    borderRadius: "999px",
    cursor: "pointer",
    fontSize: "13px",
  },
  filtroAtivo: {
    background: "#0ea5e9",
    border: "1px solid #0ea5e9",
    color: "#fff",
    padding: "8px 14px",
    borderRadius: "999px",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: "bold",
  },
  vazio: {
    background: "#fff",
    borderRadius: "12px",
    padding: "20px",
    textAlign: "center",
    color: "#6b7280",
  },
  card: {
    background: "#fff",
    borderRadius: "14px",
    padding: "20px",
    marginBottom: "14px",
    boxShadow: "0 2px 10px rgba(0,0,0,0.06)",
  },
  topoCard: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "flex-start",
    marginBottom: "10px",
  },
  nome: {
    margin: 0,
    marginBottom: "6px",
    color: "#111827",
  },
  info: {
    margin: "4px 0",
    color: "#374151",
    fontSize: "14px",
  },
  status: {
    padding: "8px 12px",
    borderRadius: "999px",
    fontWeight: "bold",
    fontSize: "13px",
    whiteSpace: "nowrap",
  },
  bloco: {
    marginTop: "12px",
  },
  blocoRetorno: {
    marginTop: "12px",
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "12px",
  },
  paragrafo: {
    margin: "6px 0",
    color: "#374151",
    lineHeight: 1.4,
  },
  label: {
    display: "block",
    fontWeight: "bold",
    marginBottom: "6px",
    color: "#111827",
    fontSize: "13px",
  },
  textarea: {
    width: "100%",
    minHeight: "70px",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    resize: "vertical",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
  },
  acoes: {
    marginTop: "12px",
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
  },
  botaoConfirmar: {
    background: "#198754",
    color: "#fff",
    border: "none",
    padding: "12px 18px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoRejeitar: {
    background: "#dc3545",
    color: "#fff",
    border: "none",
    padding: "12px 18px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoCancelar: {
    background: "#e5e7eb",
    color: "#374151",
    border: "none",
    padding: "12px 18px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  input: {
    width: "100%",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
    marginBottom: "10px",
  },
  construtor: {
    marginTop: "14px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  blocoConstrutor: {
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "14px",
  },
  blocoTitulos: {
    background: "#eef6ff",
    border: "1px solid #cfe0f5",
    borderRadius: "10px",
    padding: "12px",
    marginBottom: "12px",
  },
  linhaTitulo: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "6px 0",
    borderTop: "1px solid #dbeafe",
    fontSize: "13px",
    color: "#1e3a5f",
  },
  linhaEntrada: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
  },
  linhaParcelaExistente: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "10px",
    padding: "8px 0",
    borderTop: "1px solid #e5e7eb",
    fontSize: "13px",
    flexWrap: "wrap",
  },
  botaoPequeno: {
    background: "#0ea5e9",
    color: "#fff",
    border: "none",
    padding: "8px 14px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: "13px",
  },
  botaoPequenoVerde: {
    background: "#198754",
    color: "#fff",
    border: "none",
    padding: "6px 12px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: "12px",
    whiteSpace: "nowrap",
  },
  tabelaParcelas: {
    marginTop: "12px",
    border: "1px solid #e5e7eb",
    borderRadius: "8px",
    overflow: "hidden",
  },
  linhaTabelaCabecalho: {
    display: "grid",
    gridTemplateColumns: "40px 1fr 1fr 1fr 1fr",
    gap: "8px",
    background: "#f1f5f9",
    padding: "8px 10px",
    fontSize: "12px",
    fontWeight: "bold",
    color: "#475569",
  },
  linhaTabelaParcela: {
    display: "grid",
    gridTemplateColumns: "40px 1fr 1fr 1fr 1fr",
    gap: "8px",
    padding: "6px 10px",
    alignItems: "center",
    borderTop: "1px solid #e5e7eb",
    fontSize: "13px",
  },
  inputTabela: {
    width: "100%",
    padding: "6px",
    borderRadius: "6px",
    border: "1px solid #ccc",
    boxSizing: "border-box",
    fontSize: "12px",
  },
  alerta: {
    background: "#fff3cd",
    color: "#664d03",
    border: "1px solid #ffecb5",
    borderRadius: "10px",
    padding: "16px",
  },
};
