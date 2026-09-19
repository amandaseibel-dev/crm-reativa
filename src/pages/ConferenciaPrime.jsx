import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import { S as A } from "../ui/estilosFila";
import Aluno from "./Aluno";
import DadosAcademicos from "../components/DadosAcademicos";

// Conferência Prime: títulos que SAÍRAM DA COBRANÇA e esperam decisão humana.
//
// Só chega aqui o que a detecção do grupo A colocou em EM_CONFIRMACAO:
// liquidação real na Prime (depois do vencimento + 30 e da importação), o
// próprio boleto no portador 195, CPF coerente, sem conflito, e corroboração
// independente -- pagamento ReATIVA no dia ou valor pago acima do bruto. A data
// crua da Prime, sozinha, nunca mais traz título para esta tela.
//
// Premissa 6: nada aqui é automático. Cada decisão é um clique de gente e fica
// registrada. As três saídas:
//   - CONFIRMAR A1 (sem acordo na janela) -> baixa oficial; a evidência é
//     conferida de novo no momento do clique.
//   - CONFIRMAR A2 que o acordo cobre -> VÍNCULO ao acordo existente. Sem baixa
//     independente: a dívida fica só nas parcelas do acordo.
//   - REJEITAR -> o título volta a ser cobrado (ABERTO). A mesma evidência não
//     o traz de volta para cá; só fato novo.
// A2 inconclusivo ou que o acordo não cobre, e aluno com acordo cancelado no
// histórico, exigem motivo escrito.
//
// REGRA DE ENTRADA (18/09/2026): toda liquidação NOVA da Prime chega por
// classificação de origem, nunca pela data. "Prime liquidado" não é pagamento.
//   - A_PAGAMENTO_COMPROVADO / B_ACORDO_COMPROVADO -> a ação é VINCULAR ao
//     acordo comprovado (acordo QUITADO só vira PAGO com dinheiro real).
//   - C_SEM_PROVA -> LIQUIDAÇÃO SEM ORIGEM COMPROVADA: o padrão é manter em
//     confirmação. Com acordo perto da data, vincular com motivo; com
//     pagamento identificado, seguir o pagamento (o motor conclui). Nunca há
//     "Confirmar PAGO" aqui.

const SUBGRUPO = {
  A1: { rotulo: "sem acordo na janela", dica: "A Prime liquidou e não há acordo vivo perto da data: confirmar = baixa oficial (só com pagamento ReATIVA no dia)." },
  A2_COBRE: { rotulo: "acordo cobre", dica: "O acordo feito na data da liquidação cobre este título: confirmar = vincular ao acordo." },
  A2_NAO_COBRE: { rotulo: "acordo não cobre", dica: "Há acordo perto da data, mas ele não cobre este título. Decida com motivo." },
  A2_INCONCLUSIVO: { rotulo: "inconclusivo", dica: "Há acordo perto da data e não dá para afirmar se cobre este título. Decida com motivo." },
  A_PAGAMENTO_COMPROVADO: { rotulo: "pagamento comprovado", dica: "O boleto está na composição de um acordo quitado com pagamentos baixados que cobrem o acordo: vincular deixa o título pago." },
  B_ACORDO_COMPROVADO: { rotulo: "acordo comprovado", dica: "O boleto está na composição de um acordo ativo do aluno: vincular deixa o título negociado (a dívida fica nas parcelas)." },
  C_SEM_PROVA: { rotulo: "LIQUIDAÇÃO SEM ORIGEM COMPROVADA", dica: "A Prime liquidou, mas não há pagamento ReATIVA que cubra o título nem acordo comprovado. Padrão: manter em confirmação." },
};

const CORROBORACAO = {
  PAGAMENTO_REATIVA: "pagamento ReATIVA no dia",
  VALOR_PAGO_ACIMA_DO_BRUTO: "valor pago acima do bruto (não é caixa)",
  NENHUMA: "sem corroboração",
};

const REGRA_NOVA = new Set(["A_PAGAMENTO_COMPROVADO", "B_ACORDO_COMPROVADO", "C_SEM_PROVA"]);
const VINCULA_DIRETO = new Set(["A2_COBRE", "A_PAGAMENTO_COMPROVADO", "B_ACORDO_COMPROVADO"]);

// Os 37 do recorte D2 (18/09) entraram sem subgrupo, antes do CHECK aceitar
// C_SEM_PROVA; o motivo de entrada diz o que eles são.
function subgrupoEfetivo(t) {
  if (t.subgrupo) return t.subgrupo;
  return /^PRIME_LIQUIDA/.test(String(t.motivo_entrada || "")) ? "C_SEM_PROVA" : t.subgrupo;
}

// As evidências que a regra de entrada guardou para o título (item 13):
// pagamento, acordo, portador, data, valor, ou a ausência de cada um.
function evidencias(t) {
  const ev = t.evidencia || {};
  const prime = ev.prime || {};
  const itens = [];
  itens.push({ ok: null, texto: `Prime: liquidado em ${dia(prime.liquidado_em || t.liquidado_em)} · portador ${prime.portador ?? t.portador ?? "-"} · bruto ${moeda(prime.valor_bruto)} · "pago" ${moeda(prime.valor_pago)} (dívida corrigida, não caixa)` });
  if (prime.cpf_confere === false) itens.push({ ok: false, texto: "CPF do boleto na Prime não confere com a ficha" });
  if (ev.pagamento_candidato_id) {
    itens.push({ ok: true, texto: `pagamento ReATIVA próximo (${ev.pagamento_candidato_status || "sem conciliação"})${ev.pagamento_cobre_o_titulo ? ", cobre o título" : ", NÃO cobre o título"}` });
  } else {
    itens.push({ ok: false, texto: "nenhum pagamento ReATIVA até 10 dias da liquidação" });
  }
  if (ev.acordo_composicao) {
    const a = ev.acordo_composicao;
    itens.push({ ok: true, texto: `boleto na composição do acordo ${a.numero} (${a.status})${a.status === "QUITADO" ? (a.pago_de_verdade?.suficiente ? ", pago de verdade" : ", SEM pagamentos que cubram") : ""}` });
  } else if (ev.acordo_candidato) {
    const a = ev.acordo_candidato;
    itens.push({ ok: null, texto: `acordo ${a.numero} (${a.status}) criado em ${dia(a.criado_em)}, sem composição que cite o boleto` });
  } else {
    itens.push({ ok: false, texto: "nenhum acordo no CRM perto da data" });
  }
  if (ev.no_portador_166 === true) itens.push({ ok: null, texto: "CPF listado no portador 166 (só indica que negociou algum dia; não prova este título)" });
  if (ev.acordo_cancelado_no_historico) itens.push({ ok: null, texto: "aluno tem acordo cancelado no histórico" });
  return itens;
}

function moeda(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dia(v) {
  if (!v) return "-";
  // Data pura (YYYY-MM-DD) não pode passar por fuso: viraria o dia anterior.
  const [a, m, d] = String(v).slice(0, 10).split("-");
  return d && m && a ? `${d}/${m}/${a}` : "-";
}

function formatCpf(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length !== 11) return v || "-";
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

// Motivo obrigatório: pede de novo até ter o mínimo, ou devolve null se cancelar.
function pedirMotivo(texto, minimo, sugestao = "") {
  let atual = sugestao;
  for (;;) {
    const r = window.prompt(texto, atual);
    if (r === null) return null;
    if (r.trim().length >= minimo) return r.trim();
    alert(`Escreva o motivo (mínimo ${minimo} caracteres).`);
    atual = r;
  }
}

function exigeMotivo(t) {
  return t.revisao_obrigatoria || t.subgrupo === "A2_NAO_COBRE" || t.subgrupo === "A2_INCONCLUSIVO";
}

export default function ConferenciaPrime() {
  const [itens, setItens] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [semPermissao, setSemPermissao] = useState(false);
  const [grupo, setGrupo] = useState("TODOS");
  const [busca, setBusca] = useState("");
  const [processando, setProcessando] = useState({});
  const [nomeCopiado, setNomeCopiado] = useState("");
  // Ficha do aluno: conferir o caso antes de decidir é o que se pede aqui.
  const [fichaId, setFichaId] = useState(null);

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);
    setErro("");
    setSemPermissao(false);
    try {
      const { data: bruto, error } = await supabase.rpc("prime_conferencia_fila");
      const data = (bruto || []).map((i) => ({ ...i, subgrupo: subgrupoEfetivo(i) }));
      if (error) throw error;
      setItens(data || []);
    } catch (e) {
      // O portão está dentro da RPC: quem não é da gestão recebe 42501.
      if (e?.code === "42501") setSemPermissao(true);
      else setErro(e?.message || String(e));
      setItens([]);
    } finally {
      setCarregando(false);
    }
  }

  function marcar(chave, ligado) {
    setProcessando((p) => {
      const n = { ...p };
      if (ligado) n[chave] = true;
      else delete n[chave];
      return n;
    });
  }

  function tirarDaTela(ids) {
    const s = new Set(ids);
    setItens((prev) => prev.filter((x) => !s.has(x.titulo_id)));
  }

  async function confirmar(t) {
    const vinculo = VINCULA_DIRETO.has(t.subgrupo);
    const pergunta = vinculo
      ? `Vincular o boleto ${t.documento} ao acordo ${t.acordo_numero || "?"}?\n\n` +
        `Aluno: ${t.aluno_nome}\nValor do título: ${moeda(t.valor)}\n\n` +
        "O título passa a fazer parte do acordo: a dívida fica só nas parcelas dele. " +
        (t.acordo_status === "QUITADO"
          ? "O acordo está quitado com pagamentos reais: o título fica pago. "
          : "Acordo ativo: o título fica negociado. ") +
        "Nada é baixado por fora, nenhum acordo ou parcela é criado."
      : `Confirmar a liquidação do boleto ${t.documento}?\n\n` +
        `Aluno: ${t.aluno_nome}\nVencimento: ${dia(t.vencimento)}\nValor: ${moeda(t.valor)}\n` +
        `Liquidado na Prime em ${dia(t.liquidado_em)} (${CORROBORACAO[t.corroboracao] || t.corroboracao}).\n\n` +
        "O título fica como pago, com a origem registrada. A evidência é conferida de novo agora.";
    let obs = null;
    if (t.revisao_obrigatoria) {
      obs = pedirMotivo(
        pergunta + "\n\nEste aluno tem acordo cancelado no histórico: escreva o motivo da decisão.",
        10
      );
      if (obs === null) return;
    } else if (!window.confirm(pergunta)) {
      return;
    }
    if (processando[t.titulo_id]) return;
    marcar(t.titulo_id, true);
    try {
      const { error } = await supabase.rpc("prime_conferencia_confirmar", {
        p_titulo_id: t.titulo_id,
        p_observacao: obs,
      });
      if (error) throw error;
      tirarDaTela([t.titulo_id]);
    } catch (e) {
      alert("Não foi possível confirmar: " + (e?.message || String(e)));
    } finally {
      marcar(t.titulo_id, false);
    }
  }

  // A2 inconclusivo / que o acordo não cobre, e C sem prova com acordo perto
  // da data: gente decide, com motivo.
  async function vincularComMotivo(t, acordo = null) {
    const acordoId = acordo?.acordo_id || t.acordo_id;
    const numero = acordo?.numero || t.acordo_numero || "?";
    if (!acordoId) {
      alert("Nenhum acordo sugerido para este título. Vincule pela ficha do aluno ou mantenha em confirmação.");
      return;
    }
    const motivo = pedirMotivo(
      `Vincular o boleto ${t.documento} ao acordo ${numero}?\n\n` +
        `${SUBGRUPO[t.subgrupo]?.dica || ""}\n\nPor que este acordo cobre o título?`,
      10
    );
    if (motivo === null) return;
    marcar(t.titulo_id, true);
    try {
      const { error } = await supabase.rpc("prime_conferencia_vincular", {
        p_titulo_id: t.titulo_id,
        p_acordo_id: acordoId,
        p_observacao: motivo,
      });
      if (error) throw error;
      tirarDaTela([t.titulo_id]);
    } catch (e) {
      alert("Não foi possível vincular: " + (e?.message || String(e)));
    } finally {
      marcar(t.titulo_id, false);
    }
  }

  async function baixarComMotivo(t) {
    const motivo = pedirMotivo(
      `Dar baixa no boleto ${t.documento} sem vincular a acordo?\n\n` +
        `${SUBGRUPO[t.subgrupo]?.dica || ""}\n\nPor que a liquidação vale como pagamento deste título?`,
      10
    );
    if (motivo === null) return;
    marcar(t.titulo_id, true);
    try {
      const { error } = await supabase.rpc("prime_conferencia_baixar", {
        p_titulo_id: t.titulo_id,
        p_observacao: motivo,
      });
      if (error) throw error;
      tirarDaTela([t.titulo_id]);
    } catch (e) {
      alert("Não foi possível baixar: " + (e?.message || String(e)));
    } finally {
      marcar(t.titulo_id, false);
    }
  }

  // ROTA A pela tela: o pagamento está identificado mas ainda pendente no
  // motor. O título volta para o fluxo oficial, que conclui pela cadeia
  // pagamento -> acordo/parcela -> título. Nada é marcado pago aqui.
  async function seguirPagamento(t) {
    const ev = t.evidencia || {};
    const pg = (ev.pagamentos_proximos || [])[0];
    if (!ev.pagamento_candidato_id) {
      alert("Nenhum pagamento identificado para este título.");
      return;
    }
    const motivo = pedirMotivo(
      `Seguir o pagamento de ${dia(pg?.data)} (${moeda(pg?.valor)}, ${pg?.status_conciliacao || "sem conciliação"}) para o boleto ${t.documento}?\n\n` +
        "O título volta para o fluxo oficial de pagamento e sai desta fila; o motor conclui " +
        "(à vista quita; parcela de parcelado deixa negociado). Nada é marcado pago por aqui.\n\n" +
        "Por que este pagamento é deste título?",
      10
    );
    if (motivo === null) return;
    marcar(t.titulo_id, true);
    try {
      const { error } = await supabase.rpc("prime_conferencia_seguir_pagamento", {
        p_titulo_id: t.titulo_id,
        p_pagamento_id: ev.pagamento_candidato_id,
        p_motivo: motivo,
      });
      if (error) throw error;
      tirarDaTela([t.titulo_id]);
    } catch (e) {
      alert("Não foi possível seguir o pagamento: " + (e?.message || String(e)));
    } finally {
      marcar(t.titulo_id, false);
    }
  }

  // REJEITAR devolve o título para a cobrança. Não baixa nada.
  async function rejeitar(lista, descricao) {
    if (!lista.length) return;
    const total = lista.reduce((s, x) => s + (Number(x.valor) || 0), 0);
    const motivo = pedirMotivo(
      `Rejeitar ${lista.length} título(s) — ${descricao} — ${moeda(total)}.\n\n` +
        "O título volta a ser cobrado (em aberto) e sai desta fila. " +
        "A mesma evidência não o traz de volta.\n\nPor que a liquidação não vale?",
      5
    );
    if (motivo === null) return;
    const chave = lista.length === 1 ? lista[0].titulo_id : `lote:${descricao}`;
    marcar(chave, true);
    try {
      const { error } =
        lista.length === 1
          ? await supabase.rpc("prime_conferencia_rejeitar", { p_titulo_id: lista[0].titulo_id, p_motivo: motivo })
          : await supabase.rpc("prime_conferencia_rejeitar_lote", {
              p_titulo_ids: lista.map((x) => x.titulo_id),
              p_motivo: motivo,
            });
      if (error) throw error;
      tirarDaTela(lista.map((x) => x.titulo_id));
    } catch (e) {
      alert("Não foi possível rejeitar: " + (e?.message || String(e)));
      carregar();
    } finally {
      marcar(chave, false);
    }
  }

  function copiarNome(nome) {
    navigator.clipboard.writeText(nome || "").then(() => {
      setNomeCopiado(nome);
      setTimeout(() => setNomeCopiado(""), 1500);
    });
  }

  const filtrados = useMemo(() => {
    let lista = itens.filter((i) => {
      if (grupo === "TODOS") return true;
      if (grupo === "A2") return String(i.subgrupo || "").startsWith("A2");
      if (grupo === "REVISAO") return exigeMotivo(i);
      if (grupo === "COMPROVADOS") return i.subgrupo === "A_PAGAMENTO_COMPROVADO" || i.subgrupo === "B_ACORDO_COMPROVADO";
      return i.subgrupo === grupo;
    });
    const t = busca.trim().toLowerCase();
    if (t) {
      const digitos = t.replace(/\D/g, "");
      lista = lista.filter((i) => {
        const nomeOk = String(i.aluno_nome || "").toLowerCase().includes(t);
        const cpfOk = digitos && String(i.cpf || "").replace(/\D/g, "").includes(digitos);
        const docOk = digitos && String(i.documento || "").includes(digitos);
        return nomeOk || cpfOk || docOk;
      });
    }
    return lista;
  }, [itens, grupo, busca]);

  // 1 card por aluno, como nas outras filas. A2 primeiro: é onde mora o risco
  // de cobrar a mesma dívida duas vezes.
  const grupos = useMemo(() => {
    const mapa = new Map();
    for (const i of filtrados) {
      const chave = i.aluno_id || `SEM-${i.titulo_id}`;
      if (!mapa.has(chave)) {
        mapa.set(chave, {
          chave,
          alunoId: i.aluno_id,
          nome: i.aluno_nome,
          cpf: i.cpf,
          responsavel: i.operador_responsavel,
          outrasDividas: i.outras_dividas,
          titulos: [],
        });
      }
      mapa.get(chave).titulos.push(i);
    }
    const arr = Array.from(mapa.values());
    for (const g of arr) {
      g.total = g.titulos.reduce((s, t) => s + (Number(t.valor) || 0), 0);
      g.temA2 = g.titulos.some((t) => String(t.subgrupo || "").startsWith("A2"));
    }
    arr.sort((a, b) => Number(b.temA2) - Number(a.temA2) || b.total - a.total);
    return arr;
  }, [filtrados]);

  const contagens = useMemo(
    () => ({
      a1: itens.filter((i) => i.subgrupo === "A1").length,
      a2: itens.filter((i) => String(i.subgrupo || "").startsWith("A2")).length,
      revisao: itens.filter(exigeMotivo).length,
      semProva: itens.filter((i) => i.subgrupo === "C_SEM_PROVA").length,
      comprovados: itens.filter((i) => i.subgrupo === "A_PAGAMENTO_COMPROVADO" || i.subgrupo === "B_ACORDO_COMPROVADO").length,
    }),
    [itens]
  );

  const totalFiltrado = filtrados.reduce((s, i) => s + (Number(i.valor) || 0), 0);

  if (carregando) {
    return (
      <div style={A.wrap}>
        <Carregando texto="Carregando a Conferência Prime…" />
      </div>
    );
  }

  return (
    <div style={A.wrap}>
      <div style={A.topo}>
        <div>
          <h1 style={A.titulo}>Conferência Prime</h1>
          <p style={A.sub}>
            Títulos fora da cobrança por liquidação corroborada na Prime, aguardando sua decisão.
          </p>
        </div>
        <button type="button" style={A.btnGhost} onClick={carregar}>Atualizar</button>
      </div>

      {erro && <div style={A.erroBox}>⚠️ {erro}</div>}

      {semPermissao ? (
        <p style={A.muted}>A Conferência Prime é decisão da gestão.</p>
      ) : itens.length === 0 && !erro ? (
        <p style={A.muted}>Nenhum título aguardando decisão.</p>
      ) : (
        <>
          <div style={A.barra}>
            <select style={A.select} value={grupo} onChange={(e) => setGrupo(e.target.value)}>
              <option value="TODOS">Todos ({itens.length})</option>
              <option value="C_SEM_PROVA">Liquidação sem origem comprovada ({contagens.semProva})</option>
              <option value="COMPROVADOS">Pagamento/acordo comprovado — vincular ({contagens.comprovados})</option>
              <option value="A2">Histórico: com acordo na janela — A2 ({contagens.a2})</option>
              <option value="A1">Histórico: sem acordo na janela — A1 ({contagens.a1})</option>
              <option value="REVISAO">Exigem motivo ({contagens.revisao})</option>
            </select>
            <input
              style={A.input}
              placeholder="Buscar por nome, CPF ou boleto..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <div style={A.contadores}>
              <span style={A.contadorAlunos}>{grupos.length} alunos</span>
              <span style={A.contadorAcordos}>{filtrados.length} títulos</span>
              <span style={A.contadorValor}>{moeda(totalFiltrado)}</span>
            </div>
          </div>

          <div style={estilos.aviso}>
            Estes títulos <b>não estão sendo cobrados</b> e <b>não foram baixados</b>: o valor segue
            igual e o responsável continua o mesmo. <b>Liquidado na Prime não é pagamento</b>: sem
            pagamento ReATIVA ou acordo comprovado, o título fica em confirmação. Vincular usa o
            acordo comprovado; seguir pagamento devolve o título ao fluxo oficial; rejeitar devolve
            o título para a cobrança.
          </div>

          {grupos.length === 0 ? (
            <p style={A.muted}>Nenhum título neste filtro.</p>
          ) : (
            <div style={A.cards}>
              {grupos.map((g) => (
                <div key={g.chave} style={A.card}>
                  <div style={A.cardHead}>
                    <div style={A.cardHeadInfo}>
                      <span style={A.cardNome}>{g.nome || "-"}</span>
                      <button
                        type="button"
                        onClick={() => copiarNome(g.nome)}
                        style={estilos.btnCopiar}
                        title="Copiar o nome do aluno"
                      >
                        {nomeCopiado === g.nome ? "✓ Copiado" : "📋 Copiar"}
                      </button>
                      <span style={A.cardCpf}>CPF {formatCpf(g.cpf)}</span>
                      {g.outrasDividas ? (
                        <span style={estilos.seloAtencao} title="O aluno segue em cobrança pelas outras dívidas">
                          tem outras dívidas
                        </span>
                      ) : (
                        <span style={estilos.selo} title="Só este(s) título(s) em aberto: o caso não ocupa vaga enquanto espera">
                          só aguarda esta decisão
                        </span>
                      )}
                    </div>
                    <div style={A.cardHeadDir}>
                      <span style={A.cardResumo}>
                        {g.titulos.length} título{g.titulos.length > 1 ? "s" : ""} · {moeda(g.total)}
                      </span>
                      <span style={A.cardUnidade}>{g.responsavel}</span>
                      {g.titulos.length > 1 && (
                        <button
                          type="button"
                          style={{ ...estilos.btnRejeitar, ...(processando[`lote:${g.chave}`] ? A.btnBusy : {}) }}
                          disabled={!!processando[`lote:${g.chave}`]}
                          onClick={() => rejeitar(g.titulos, g.chave)}
                          title="Devolve todos os títulos deste aluno para a cobrança"
                        >
                          Rejeitar os {g.titulos.length}
                        </button>
                      )}
                      {g.alunoId && (
                        <button
                          type="button"
                          style={A.btnFicha}
                          onClick={() => setFichaId(g.alunoId)}
                          title="Abrir a ficha para conferir o caso antes de decidir"
                        >
                          Abrir ficha
                        </button>
                      )}
                    </div>
                  </div>

                  <table style={A.tabela}>
                    <thead>
                      <tr>
                        <th style={A.th}>Boleto</th>
                        <th style={A.th}>Vencimento</th>
                        <th style={A.th}>Liquidado na Prime</th>
                        <th style={A.th}>Classificação</th>
                        <th style={A.thNum}>Valor</th>
                        <th style={A.th}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.titulos.map((t) => {
                        const busy = !!processando[t.titulo_id];
                        const sub = SUBGRUPO[t.subgrupo] || { rotulo: t.subgrupo, dica: "" };
                        const decideComMotivo = t.subgrupo === "A2_NAO_COBRE" || t.subgrupo === "A2_INCONCLUSIVO";
                        const regraNova = REGRA_NOVA.has(t.subgrupo);
                        const semProva = t.subgrupo === "C_SEM_PROVA";
                        const ev = t.evidencia || {};
                        return (
                          <tr key={t.titulo_id}>
                            <td style={A.td}>{t.documento || "-"}</td>
                            <td style={A.td}>{dia(t.vencimento)}</td>
                            <td style={A.td}>
                              {dia(t.liquidado_em)}
                              {!regraNova && (
                                <span style={estilos.seloComDinheiro}>
                                  {CORROBORACAO[t.corroboracao] || t.corroboracao}
                                </span>
                              )}
                            </td>
                            <td style={A.td}>
                              <span
                                style={semProva ? estilos.seloAlerta : String(t.subgrupo || "").startsWith("A2") ? estilos.seloAtencao : estilos.selo}
                                title={sub.dica}
                              >
                                {sub.rotulo}
                                {t.acordo_numero ? ` · acordo ${t.acordo_numero}` : ""}
                              </span>
                              {regraNova && (
                                <ul style={estilos.evidencias} title="Evidências encontradas pela regra de entrada">
                                  {evidencias(t).map((e, i) => (
                                    <li key={i} style={e.ok === true ? estilos.evOk : e.ok === false ? estilos.evFalta : estilos.evNeutra}>
                                      {e.ok === true ? "✓ " : e.ok === false ? "✗ " : "· "}{e.texto}
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {t.revisao_obrigatoria && (
                                <span
                                  style={estilos.seloAlerta}
                                  title="O aluno tem acordo cancelado no histórico. Isso sozinho não impede a liquidação, mas a decisão exige motivo."
                                >
                                  acordo cancelado no histórico
                                </span>
                              )}
                            </td>
                            <td style={A.tdNum}>{moeda(t.valor)}</td>
                            <td style={A.td}>
                              <div style={A.acoes}>
                                {semProva ? (
                                  <>
                                    <span style={estilos.manter} title="Sem prova, o título fica em confirmação: não é pago, não é negociado, não é cobrado">
                                      mantido em confirmação
                                    </span>
                                    {ev.acordo_candidato && (
                                      <button
                                        type="button"
                                        style={{ ...A.btnConf, ...(busy ? A.btnBusy : {}) }}
                                        disabled={busy}
                                        onClick={() => vincularComMotivo(t, ev.acordo_candidato)}
                                        title={`Vincula ao acordo ${ev.acordo_candidato.numero}, com motivo`}
                                      >
                                        Vincular acordo {ev.acordo_candidato.numero}
                                      </button>
                                    )}
                                    {ev.pagamento_candidato_id && (
                                      <button
                                        type="button"
                                        style={{ ...A.btnConf, ...(busy ? A.btnBusy : {}) }}
                                        disabled={busy}
                                        onClick={() => seguirPagamento(t)}
                                        title="O título volta ao fluxo oficial de pagamento; o motor conclui"
                                      >
                                        Seguir pagamento
                                      </button>
                                    )}
                                  </>
                                ) : decideComMotivo ? (
                                  <>
                                    {t.acordo_id && (
                                      <button
                                        type="button"
                                        style={{ ...A.btnConf, ...(busy ? A.btnBusy : {}) }}
                                        disabled={busy}
                                        onClick={() => vincularComMotivo(t)}
                                        title="Vincula ao acordo sugerido, com motivo"
                                      >
                                        Vincular
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      style={{ ...A.btnConf, ...(busy ? A.btnBusy : {}) }}
                                      disabled={busy}
                                      onClick={() => baixarComMotivo(t)}
                                      title="Dá baixa sem vincular, com motivo"
                                    >
                                      Baixar
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    style={{ ...A.btnConf, ...(busy ? A.btnBusy : {}) }}
                                    disabled={busy}
                                    onClick={() => confirmar(t)}
                                    title={sub.dica}
                                  >
                                    {busy ? "Processando..." : VINCULA_DIRETO.has(t.subgrupo) ? "Vincular ao acordo" : "Confirmar"}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  style={{ ...estilos.btnRejeitar, ...(busy ? A.btnBusy : {}) }}
                                  disabled={busy}
                                  onClick={() => rejeitar([t], `boleto ${t.documento}`)}
                                  title="A liquidação não vale: o título volta a ser cobrado"
                                >
                                  Rejeitar
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {fichaId && (
        <div style={A.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={A.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <span style={A.modalTitulo}>Ficha do aluno</span>
              <button
                type="button"
                style={{ ...A.modalFechar, marginLeft: "auto" }}
                onClick={() => setFichaId(null)}
              >
                Fechar ✕
              </button>
            </div>
            <div style={{ padding: "0 16px" }}>
              <DadosAcademicos aluno={{ id: fichaId }} />
            </div>
            <div style={A.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const estilos = {
  // evidências da regra de entrada: o que foi encontrado e o que falta
  evidencias: { listStyle: "none", margin: "6px 0 0", padding: 0, fontSize: 11.5, lineHeight: 1.45, color: "var(--rv-texto-suave)" },
  evOk: { color: "var(--rv-verde-ok-texto)" },
  evFalta: { color: "var(--rv-vermelho-texto)" },
  evNeutra: { color: "var(--rv-texto-suave)" },
  manter: { fontSize: 11.5, fontWeight: 700, color: "var(--rv-texto-suave)", border: "1px dashed var(--rv-borda-forte)", borderRadius: 8, padding: "5px 10px", whiteSpace: "nowrap" },
  seloComDinheiro: { marginLeft: 6, fontSize: 11, fontWeight: 800, color: "var(--rv-verde-ok-texto)", background: "var(--rv-verde-ok-fundo)", border: "1px solid var(--rv-verde-ok-borda)", borderRadius: 999, padding: "2px 8px" },
  btnCopiar: { background: "var(--rv-superficie)", color: "var(--rv-texto)", border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "3px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  btnRejeitar: { background: "var(--rv-superficie)", color: "var(--rv-vermelho-texto)", border: "1px solid var(--rv-vermelho-borda)", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  aviso: {
    background: "var(--rv-ambar-fundo)",
    border: "1px solid var(--rv-ambar-borda)",
    color: "var(--rv-ambar-texto)",
    borderRadius: 10,
    padding: "12px 14px",
    fontSize: 13,
    lineHeight: 1.5,
    marginBottom: 14,
  },
  seloAlerta: {
    marginLeft: 6,
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    padding: "2px 10px",
    background: "var(--rv-vermelho-fundo)",
    color: "var(--rv-vermelho-texto)",
    border: "1px solid var(--rv-vermelho-borda)",
    whiteSpace: "nowrap",
  },
  seloAtencao: {
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    padding: "2px 10px",
    background: "var(--rv-ambar-fundo)",
    color: "var(--rv-ambar-texto)",
    border: "1px solid var(--rv-ambar-borda)",
    whiteSpace: "nowrap",
  },
  selo: {
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    padding: "2px 10px",
    background: "var(--rv-roxo-fundo)",
    color: "var(--rv-roxo-texto)",
    border: "1px solid var(--rv-roxo-borda)",
    whiteSpace: "nowrap",
  },
};
