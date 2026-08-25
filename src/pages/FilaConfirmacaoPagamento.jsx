import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import { urlComprovanteLink, abrirDocumento } from "../utils/documentoFinanceiro";
import Alunos from "./Aluno";
import FinanceiroAluno from "../components/FinanceiroAluno";
import DadosAcademicos from "../components/DadosAcademicos";
import { podeGerirFinanceiro, nomeOperadorPorEmail } from "../utils/operadores";
import {
  STATUS_AGUARDANDO_CONFIRMACAO,
  STATUS_AGUARDANDO_VINCULO,
  STATUS_CONFIRMACAO_ABERTOS,
  isConfirmacaoAberta,
} from "../utils/confirmacaoPagamento";
import PagamentosNaoIdentificados from "../components/PagamentosNaoIdentificados";
import CasosSemValor from "../components/CasosSemValor";
import ConfirmacoesSemValor from "../components/ConfirmacoesSemValor";
import CasosSemTelefone from "../components/CasosSemTelefone";
import FilaAcordosConfirmar from "./FilaAcordosConfirmar";
import { S as A } from "../ui/estilosFila";

// A tela é a MESMA da fila de acordos: 1 card por aluno, tabela dos pagamentos
// dele e a ação de confirmar no próprio card (sem precisar abrir o modal).
// Os estilos vêm importados de lá justamente pra não divergirem com o tempo.

// Teto da API: cada requisicao devolve no maximo 1000 linhas.
const PAGE_SIZE = 1000;

const STATUS_LABEL = {
  AGUARDANDO_CONFIRMACAO: "Aguardando confirmação",
  [STATUS_AGUARDANDO_VINCULO]: "Recebido, aguardando vínculo",
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

// De onde vem a divida do caso (coluna origem_divida, carimbada no banco a
// partir do saldo real do aluno). Nao e o que o operador informou -- isso
// continua sendo tipo_pagamento.
const ORIGEM_LABEL = {
  ACORDO: "Acordo",
  MENSALIDADE: "Mensalidade",
  ACORDO_E_MENSALIDADE: "Acordo + mensalidade",
  SEM_SALDO: "Sem saldo em aberto",
};

function traduzOrigem(origem) {
  if (!origem) return "-";
  return ORIGEM_LABEL[origem] || origem;
}


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

// CPF só dígitos, 11 posições -- chave do agrupamento por aluno (igual acordos).
function normCpf(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (!d) return "";
  return d.length >= 11 ? d.slice(-11) : d.padStart(11, "0");
}

function formatCpf(v) {
  const d = normCpf(v);
  if (d.length !== 11) return v || "-";
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function ts(v) {
  const t = v ? new Date(v).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

function formatarDia(v) {
  if (!v) return "-";
  try {
    return new Date(v).toLocaleDateString("pt-BR");
  } catch {
    return "-";
  }
}

// Chip de status no padrão da fila de acordos (mesma pílula, mesmas cores).
function chipStatus(status) {
  if (status === "PAGAMENTO_CONFIRMADO") return A.chipOk;
  if (status === "PAGAMENTO_REJEITADO") return A.chipRej;
  if (status === STATUS_AGUARDANDO_VINCULO) {
    return { background: "#f5f3ff", color: "#5b21b6", border: "1px solid #ddd6fe" };
  }
  return A.chipPend;
}


// Quem pode quitar e encerrar direto da fila (espelha crm_usuario_pode_quitar_baixar no banco)
const EMAILS_PODE_QUITAR = [
  "amanda.seibel@aelbra.com.br",
  "cobranca04@aelbra.com.br", // Fernanda
  "cobranca07@aelbra.com.br", // Amanda ADM
];
function podeQuitar(email) {
  return EMAILS_PODE_QUITAR.includes(String(email || "").toLowerCase().trim());
}

export default function FilaConfirmacaoPagamento() {
  const [usuario, setUsuario] = useState(null);
  const [solicitacoes, setSolicitacoes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [observacoes, setObservacoes] = useState({});
  const [filtro, setFiltro] = useState("PENDENTES");
  // Ordenacao da lista: data de envio (padrao) ou valor informado.
  const [ordem, setOrdem] = useState("DATA_DESC");
  // Escopo do trabalho: pagamentos, acordos importados e as listas auxiliares
  // (nao identificados / sem valor / sem telefone), que antes eram "filtros" e
  // nao filtravam nada -- trocavam a tela inteira. Agora sao abas de verdade.
  const [escopo, setEscopo] = useState("PAGAMENTOS");
  const [busca, setBusca] = useState("");
  const [qtdSemValor, setQtdSemValor] = useState(null);
  const [qtdAcordoSemValor, setQtdAcordoSemValor] = useState(null);
  const [qtdSemTelefone, setQtdSemTelefone] = useState(null);

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

  // Trava por id (solicitacao) ou por card (`grp:<cpf>`): confirmar direto no
  // card e uma acao por linha, entao a trava tambem tem que ser por linha --
  // um botao ocupado nao pode desabilitar os outros da tela.
  const [processando, setProcessando] = useState({});
  // Contagens por status, vindas do banco (nao do que a tela carregou).
  const [contadores, setContadores] = useState({ pendentes: 0, aguardandoVinculo: 0, confirmados: 0, todos: 0 });

  // Aba "Acordo / Baixa": embute o FinanceiroAluno (mesmas acoes de sempre).
  const [alunoFin, setAlunoFin] = useState(null);
  const [carregandoAlunoFin, setCarregandoAlunoFin] = useState(false);

  useEffect(() => {
    let ativo = true;
    if (abaFicha !== "acordo" || !detalhe?.aluno_id) return;
    if (alunoFin && String(alunoFin.id) === String(detalhe.aluno_id)) return;
    (async () => {
      setCarregandoAlunoFin(true);
      const { data } = await supabase
        .from("alunos")
        .select("id, cpf, nome, matricula, unidade, responsavel_atual_email, responsavel_atual_nome")
        .eq("id", String(detalhe.aluno_id))
        .maybeSingle();
      if (!ativo) return;
      // fallback: monta objeto minimo a partir da solicitacao se a linha nao vier
      setAlunoFin(
        data || {
          id: detalhe.aluno_id,
          cpf: detalhe.aluno_cpf,
          nome: detalhe.aluno_nome,
        }
      );
      setCarregandoAlunoFin(false);
    })();
    return () => {
      ativo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abaFicha, detalhe?.aluno_id]);

  // Cada aba de status busca so o que precisa, entao a troca de aba recarrega.
  // O carregamento inicial tambem passa por aqui (o efeito roda na montagem).
  useEffect(() => {
    carregarSolicitacoes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtro]);

  useEffect(() => {
    carregarUsuario();
    // A origem da divida e carimbada quando a solicitacao nasce, mas o saldo do
    // aluno muda enquanto o caso espera (ele fecha acordo, paga mensalidade).
    // Recarimba os ABERTOS uma vez ao abrir a tela; se algo mudou, recarrega.
    // Falha aqui nao atrapalha a fila -- so deixa a classificacao desatualizada.
    supabase
      .rpc("recarimbar_origem_divida_pendentes", { p_limite: 5000 })
      .then(({ data, error }) => {
        if (error) return;
        if (Number(data?.atualizadas) > 0) carregarSolicitacoes();
      });
  }, []);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  // A API devolve no MAXIMO 1000 linhas por requisicao -- inclusive quando a
  // consulta nao pede limite nenhum, e a resposta ainda volta como sucesso
  // (206). Antes esta fila pedia .limit(5000) numa tacada e recebia 1000: em
  // 25/08/2026 isso escondia 1.641 pagamentos abertos e R$ 2,36 milhoes, sem
  // erro em lugar nenhum. Agora busca de mil em mil ate acabar, igual a fila
  // de acordos, e so dos status que a aba pediu -- antes lia TODOS os status e
  // jogava fora no cliente, entao casos ja resolvidos ocupavam vaga e
  // empurravam os pendentes antigos para fora.
  async function buscarPaginado(statusAlvo) {
    const todas = [];
    let de = 0;
    while (true) {
      let q = supabase
        .from("solicitacoes_confirmacao_pagamento")
        .select("*")
        .order("criado_em", { ascending: false })
        // Desempate estavel: sem chave unica na ordenacao, linhas com o mesmo
        // criado_em podem trocar de pagina e sumir (ou vir duas vezes).
        .order("id", { ascending: true })
        .range(de, de + PAGE_SIZE - 1);
      if (statusAlvo) q = q.in("status", statusAlvo);
      const { data, error } = await q;
      if (error) throw error;
      const lote = data || [];
      todas.push(...lote);
      if (lote.length < PAGE_SIZE) break;
      de += PAGE_SIZE;
    }
    return todas;
  }

  // Contagem vem do banco (count exato, sem trazer as linhas): e barata e nao
  // depende de quanto a tela conseguiu carregar.
  async function contar(statusAlvo) {
    let q = supabase
      .from("solicitacoes_confirmacao_pagamento")
      .select("id", { count: "exact", head: true });
    if (statusAlvo) q = q.in("status", statusAlvo);
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  }

  async function carregarSolicitacoes() {
    setCarregando(true);
    try {
      // A aba decide o que precisa vir; nunca a base inteira "por via das duvidas".
      const statusAlvo =
        filtro === "CONFIRMADOS" ? ["PAGAMENTO_CONFIRMADO"]
        : filtro === "AGUARDANDO_VINCULO" ? [STATUS_AGUARDANDO_VINCULO]
        : filtro === "TODOS" ? null
        : STATUS_CONFIRMACAO_ABERTOS;

      const [linhas, nPendentes, nVinculo, nConfirmados, nTodos] = await Promise.all([
        buscarPaginado(statusAlvo),
        contar([STATUS_AGUARDANDO_CONFIRMACAO]),
        contar([STATUS_AGUARDANDO_VINCULO]),
        contar(["PAGAMENTO_CONFIRMADO"]),
        contar(null),
      ]);
      setSolicitacoes(linhas);
      setContadores({
        pendentes: nPendentes,
        aguardandoVinculo: nVinculo,
        confirmados: nConfirmados,
        todos: nTodos,
      });
    } catch (e) {
      alert("Erro ao carregar fila de confirmação de pagamento: " + (e?.message || String(e)));
    } finally {
      setCarregando(false);
    }
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

        // Parcelas em aberto: parte dos acordos ATIVOS do aluno e filtra as
        // parcelas por acordo_id direto (usa ix_parcelas_acordo_status_venc).
        // Antes, o embed acordos!inner com filtro no aluno forcava varredura de
        // TODAS as parcelas da base pra devolver poucas linhas.
        const { data: acsAtivos } = await supabase
          .from("acordos")
          .select("id")
          .eq("aluno_id", String(s.aluno_id))
          .eq("status", "ATIVO");
        const acordoIds = (acsAtivos || []).map((a) => a.id);
        const { data: parc } = acordoIds.length
          ? await supabase
              .from("parcelas")
              .select("id, numero, valor, honorarios, vencimento, status")
              .in("acordo_id", acordoIds)
              .in("status", ["A_VENCER", "VENCIDA"])
              .order("vencimento", { ascending: true })
          : { data: [] };
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

  const saldoAtual = totalAbertoParcelas + totalAbertoTitulos;

  // ---- Confirmar (fluxo atual preservado) ----
  async function quitarEEncerrar(s) {
    if (!s?.aluno_id) return;
    const ok = window.confirm(
      "Quitar e encerrar este caso? Ele e quitado, zerado, sai das filas e NAO volta pro operador."
    );
    if (!ok) return;
    let { error } = await supabase.rpc("quitar_e_encerrar_caso", {
      p_aluno_id: s.aluno_id,
      p_valor: s.valor_informado || null,
    });
    // Acordo em dia (parcelas futuras, nada vencido): a RPC bloqueia de
    // proposito pra nao encerrar acordo vigente por engano. Pede confirmacao
    // explicita e reenvia.
    if (error && /ACORDO_EM_DIA/.test(error.message || "")) {
      const detalhe = (error.message || "").replace(/^.*ACORDO_EM_DIA:\s*/, "");
      if (!window.confirm(detalhe + "\n\nConfirmar e quitar o acordo inteiro?")) return;
      ({ error } = await supabase.rpc("quitar_e_encerrar_caso", {
        p_aluno_id: s.aluno_id,
        p_valor: s.valor_informado || null,
        p_confirmar_acordo_em_dia: true,
      }));
    }
    if (error) {
      alert("Erro ao quitar: " + error.message);
      return;
    }
    alert("Caso quitado e encerrado.");
    fecharFicha();
    carregarSolicitacoes();
  }

  // ---- Confirmar saldo zero e retirar das filas (financeiro preservado) ----
  // Retira o aluno de carteira/fila/retornos/confirmacao/distribuicao e da
  // contagem dos 500, bloqueia redistribuicao e libera reposicao, SEM apagar
  // registros e SEM marcar o financeiro como pago. Exige motivo. So gestao.
  async function confirmarSaldoZero(s) {
    if (!s?.aluno_id) return;
    const motivo = (motivoRejeicao ?? observacoes[s.id] ?? "").trim();
    if (!motivo) {
      alert("Escreva o motivo antes de confirmar saldo zero (ex.: pago fora do sistema, conciliação bancária, saldo residual indevido).");
      return;
    }
    const ok = window.confirm(
      "Confirmar saldo zero e retirar das filas?\n\nO aluno sai da carteira, da fila operacional, dos retornos, da confirmação e da distribuição, e deixa de contar nos 500. O financeiro e o histórico são preservados (nada é apagado)."
    );
    if (!ok) return;
    const { error } = await supabase.rpc("confirmar_saldo_zero_retirar_filas", {
      p_aluno_id: s.aluno_id,
      p_motivo: motivo,
    });
    if (error) {
      alert("Erro ao confirmar saldo zero: " + error.message);
      return;
    }
    alert("Saldo zero confirmado. Aluno retirado das filas (financeiro e histórico preservados).");
    fecharFicha();
    carregarSolicitacoes();
  }

  // Confirma UMA solicitacao (pelo id) e devolve o resultado, sem alert nem
  // recarga -- pra servir tanto ao botao do card quanto ao "confirmar todos".
  async function enviarConfirmacao(s, observacaoExtra) {
    const observacaoAdm = [observacoes[s.id], observacaoExtra].filter(Boolean).join(" — ");
    const { data, error } = await supabase.rpc("confirmar_pagamento_solicitacao", {
      p_confirmacao_id: s.id,
      p_observacao: observacaoAdm || null,
    });
    if (error) return { erro: error.message };
    // Tira imediatamente da fila local (sem recarregar a pagina inteira).
    setSolicitacoes((prev) =>
      prev.map((x) => (x.id === s.id ? { ...x, status: "PAGAMENTO_CONFIRMADO" } : x))
    );
    return { dados: data || {} };
  }

  // Confirmavel = fluxo antigo liberado; "recebido, aguardando vinculo" so
  // depois que a divida foi identificada (mesma regra do rodape do modal).
  function podeConfirmarSolicitacao(s) {
    if (!isConfirmacaoAberta(s?.status)) return false;
    return s.status === STATUS_AGUARDANDO_VINCULO ? dadosMinimosOk(s) : true;
  }

  // Confirma de uma vez todos os pagamentos pendentes de UM aluno (card).
  // Cada um continua sendo uma chamada por id -- nao existe baixa por CPF.
  async function confirmarGrupo(g) {
    const alvos = g.itens.filter(podeConfirmarSolicitacao);
    if (alvos.length === 0) return;
    const chave = `grp:${g.chave}`;
    if (processando[chave]) return;
    setProcessando((p) => ({ ...p, [chave]: true }));
    let quitados = 0;
    let confirmados = 0;
    const erros = [];
    try {
      for (const s of alvos) {
        const r = await enviarConfirmacao(s);
        if (r.erro) erros.push(r.erro);
        else {
          confirmados += 1;
          if (r.dados?.quitou) quitados += 1;
        }
      }
    } finally {
      setProcessando((p) => {
        const n = { ...p };
        delete n[chave];
        return n;
      });
    }
    const partes = [`${confirmados} pagamento(s) confirmado(s).`];
    if (quitados) partes.push(`${quitados} caso(s) quitado(s) e retirado(s) das filas.`);
    if (confirmados > quitados) partes.push("Os demais seguem com saldo em aberto na carteira.");
    if (erros.length) partes.push(`Falhas: ${erros.join(" | ")}`);
    alert(partes.join("\n"));
    carregarSolicitacoes();
  }

  // Rejeita direto do card: o motivo continua obrigatorio, so que perguntado
  // na hora em vez de exigir abrir o modal e descer ate o rodape.
  async function rejeitarNoCard(s) {
    const motivo = window.prompt(
      "Motivo da rejeição (obrigatório):\nEx.: comprovante ilegível, valor divergente, CPF divergente, pagamento não localizado.",
      observacoes[s.id] || ""
    );
    if (motivo === null) return; // cancelou
    if (!motivo.trim()) {
      alert("O motivo é obrigatório para devolver ao operador.");
      return;
    }
    if (processando[s.id]) return;
    setProcessando((p) => ({ ...p, [s.id]: true }));
    try {
      await rejeitarPagamento(s, motivo);
    } finally {
      setProcessando((p) => {
        const n = { ...p };
        delete n[s.id];
        return n;
      });
    }
  }

  async function finalizarSolicitacao(s, observacaoExtra) {
    // Guarda de duplo clique: a RPC já é idempotente no banco (lock + checagem
    // de status), mas evitamos a segunda ida ao servidor.
    if (processando[s.id]) return;
    setProcessando((p) => ({ ...p, [s.id]: true }));
    try {
      const observacaoAdm = [observacoes[s.id], observacaoExtra].filter(Boolean).join(" — ");

      // Uma única RPC ATÔMICA faz tudo no backend (fonte da verdade):
      //  - bloqueia a solicitação (FOR UPDATE) e valida idempotência;
      //  - registra o recebimento;
      //  - recalcula o saldo canônico ignorando esta confirmação;
      //  - SE zero: encerra o caso com status reconhecido (SEM_SALDO_EM_ABERTO)
      //    e o retira de TODAS as filas do operador, preservando o responsável;
      //  - SE ainda há saldo: mantém o caso na carteira, sem quitar nem repor.
      // O frontend não faz mais UPDATE direto em alunos/solicitações.
      const { data, error } = await supabase.rpc("confirmar_pagamento_solicitacao", {
        p_confirmacao_id: s.id,
        p_observacao: observacaoAdm || null,
      });

      if (error) {
        alert("Erro ao confirmar pagamento: " + error.message);
        return;
      }

      // Tira imediatamente da fila local (sem recarregar a página inteira).
      setSolicitacoes((prev) =>
        prev.map((x) => (x.id === s.id ? { ...x, status: "PAGAMENTO_CONFIRMADO" } : x))
      );

      if (data?.ja_processado) {
        alert("Esta solicitação já havia sido processada. Nenhuma alteração adicional foi feita.");
      } else if (data?.quitou) {
        alert("Quitação total concluída: saldo zerado, caso encerrado e retirado das filas do operador.");
      } else {
        console.info(
          "Pagamento confirmado, mas saldo ainda em aberto: caso mantido na carteira, sem quitação nem reposição.",
          data && data.detalhe
        );
        alert("Pagamento confirmado (recebimento registrado). O aluno ainda tem saldo em aberto, então o caso permanece na carteira e não foi quitado.");
      }

      fecharFicha();
      carregarSolicitacoes();
    } finally {
      setProcessando((p) => {
        const n = { ...p };
        delete n[s.id];
        return n;
      });
    }
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
          status_jornada: "CONTATAR",
          status_atual: "CONTATAR",
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



  // Ordenacao: (1) data/hora do envio (criado_em) mais recente primeiro;
  // (2) desempate por ultima atualizacao; (3) desempate por nome do aluno.
  const solicitacoesFiltradas = useMemo(() => {
    let base;
    // "PENDENTES" (visível por padrão) inclui os recebidos aguardando vínculo,
    // para que nenhum pagamento fique escondido de Amanda/Fernanda.
    if (filtro === "PENDENTES") base = solicitacoes.filter((s) => isConfirmacaoAberta(s.status));
    else if (filtro === "AGUARDANDO_VINCULO") base = solicitacoes.filter((s) => s.status === STATUS_AGUARDANDO_VINCULO);
    else if (filtro === "CONFIRMADOS") base = solicitacoes.filter((s) => s.status === "PAGAMENTO_CONFIRMADO");
    else base = solicitacoes;

    if (busca.trim()) {
      const t = busca.trim().toLowerCase();
      const cpfBusca = t.replace(/\D/g, "");
      base = (base || []).filter((s) => {
        const nomeOk = String(s.aluno_nome || "").toLowerCase().includes(t);
        const cpfOk = cpfBusca && normCpf(s.aluno_cpf).includes(cpfBusca);
        return nomeOk || cpfOk;
      });
    }

    const ts = (v) => {
      const t = v ? new Date(v).getTime() : 0;
      return Number.isNaN(t) ? 0 : t;
    };
    const vl = (s) => {
      const n = Number(s?.valor_informado);
      return Number.isFinite(n) ? n : 0;
    };
    const porNome = (a, b) =>
      String(a.aluno_nome || "").localeCompare(String(b.aluno_nome || ""), "pt-BR");
    const porData = (a, b) => {
      const d = ts(b.criado_em) - ts(a.criado_em);
      if (d !== 0) return d;
      const u = ts(b.atualizado_em) - ts(a.atualizado_em);
      if (u !== 0) return u;
      return porNome(a, b);
    };
    return [...base].sort((a, b) => {
      if (ordem === "DATA_ASC") return -porData(a, b);
      if (ordem === "VALOR_DESC") {
        const v = vl(b) - vl(a);
        return v !== 0 ? v : porData(a, b);
      }
      if (ordem === "VALOR_ASC") {
        const v = vl(a) - vl(b);
        return v !== 0 ? v : porData(a, b);
      }
      return porData(a, b);
    });
  }, [solicitacoes, filtro, ordem, busca]);

  // 1 card por aluno (CPF), igual à fila de acordos: o card é o aluno, a tabela
  // são os pagamentos dele.
  //
  // A chave é o CPF, mas 69% das solicitações abertas em produção (1.568 de
  // 2.258, medido em 25/08/2026) nascem SEM cpf preenchido. Agrupando só por
  // CPF, cada uma dessas virava um card sozinho e o "Confirmar os N pagamentos"
  // praticamente nunca aparecia -- justo no caso em que ele mais economiza
  // clique. Sem CPF, cai para o aluno_id, que identifica a pessoa igual. Só
  // quando não há nem um nem outro é que a linha vira seu próprio card.
  const grupos = useMemo(() => {
    const mapa = new Map();
    for (const s of solicitacoesFiltradas) {
      const cpf = normCpf(s.aluno_cpf);
      const chave = cpf || (s.aluno_id ? `ALUNO-${s.aluno_id}` : `SEMCPF-${s.id}`);
      if (!mapa.has(chave)) {
        mapa.set(chave, { chave, cpf, nome: s.aluno_nome, alunoId: s.aluno_id, itens: [] });
      }
      mapa.get(chave).itens.push(s);
    }
    const arr = Array.from(mapa.values());
    for (const g of arr) {
      g.total = g.itens.reduce((soma, s) => soma + (Number(s.valor_informado) || 0), 0);
      // Duas datas: a mais antiga (há quanto tempo o aluno espera) e a mais
      // recente (o que acabou de chegar). Cada ordenação usa a sua.
      g.primeiroEm = g.itens.reduce((min, s) => {
        const t = ts(s.criado_em);
        return t && (!min || t < min) ? t : min;
      }, 0);
      g.ultimoEm = g.itens.reduce((max, s) => Math.max(max, ts(s.criado_em)), 0);
      g.abertos = g.itens.filter((s) => isConfirmacaoAberta(s.status));
    }
    const porNome = (a, b) => String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR");
    arr.sort((a, b) => {
      if (ordem === "VALOR_DESC") {
        const v = b.total - a.total;
        return v !== 0 ? v : porNome(a, b);
      }
      if (ordem === "VALOR_ASC") {
        const v = a.total - b.total;
        return v !== 0 ? v : porNome(a, b);
      }
      if (ordem === "DATA_ASC") {
        const d = a.primeiroEm - b.primeiroEm;
        return d !== 0 ? d : porNome(a, b);
      }
      const d = b.ultimoEm - a.ultimoEm; // DATA_DESC (padrão)
      return d !== 0 ? d : porNome(a, b);
    });
    return arr;
  }, [solicitacoesFiltradas, ordem]);

  const totalFiltrado = solicitacoesFiltradas.reduce((soma, s) => soma + (Number(s.valor_informado) || 0), 0);

  if (carregando) {
    return <div style={styles.container}><Carregando texto="Carregando fila de confirmação de pagamento…" /></div>;
  }

  if (!podeUsar) {
    return (
      <div style={styles.container}>
        <h1 style={styles.titulo}>Fila de Confirmação de Pagamento</h1>
        <div style={styles.alerta}>Seu usuário não tem permissão para acessar esta fila.</div>
      </div>
    );
  }

  // As frentes num lugar so: pagamentos informados pela operacao, acordos
  // importados e as listas auxiliares. Sao tabelas e fluxos diferentes -- a tela
  // nao mistura as linhas, ela deixa escolher o que trabalhar agora.
  const abertosTotal = contadores.pendentes + contadores.aguardandoVinculo;
  const ESCOPOS = [
    { chave: "PAGAMENTOS", rotulo: "Pagamentos a confirmar", badge: abertosTotal || null },
    { chave: "ACORDOS", rotulo: "Acordos a confirmar", badge: null },
    { chave: "NAO_IDENTIFICADOS", rotulo: "Não identificados", badge: null },
    { chave: "ACORDO_SEM_VALOR", rotulo: "Acordo sem valor", badge: qtdAcordoSemValor },
    { chave: "SEM_VALOR", rotulo: "Sem valor calculado", badge: qtdSemValor },
    { chave: "SEM_TELEFONE", rotulo: "Sem telefone", badge: qtdSemTelefone },
  ];
  const abasEscopo = (
    <div style={styles.escopo}>
      {ESCOPOS.map((e) => (
        <button
          key={e.chave}
          type="button"
          style={escopo === e.chave ? styles.escopoAtivo : styles.escopoBotao}
          onClick={() => setEscopo(e.chave)}
        >
          {e.rotulo}
          {e.badge !== null && e.badge !== undefined ? ` (${e.badge})` : ""}
        </button>
      ))}
    </div>
  );

  return (
    <div style={A.wrap}>
      {abasEscopo}

      {/* Mantem os dois sempre "vivos" (carregando em segundo plano), so
          escondidos visualmente quando nao e a aba ativa -- assim o numero
          na aba fica sempre atualizado, mesmo sem abrir a aba. */}
      <div style={{ display: escopo === "ACORDO_SEM_VALOR" ? "block" : "none" }}>
        <ConfirmacoesSemValor aoAtualizarContagem={setQtdAcordoSemValor} />
      </div>
      <div style={{ display: escopo === "SEM_TELEFONE" ? "block" : "none" }}>
        <CasosSemTelefone aoAtualizarContagem={setQtdSemTelefone} />
      </div>
      {/* SOB DEMANDA: a RPC listar_casos_sem_valor e cara (~3s). So monta
          quando a aba "Sem valor calculado" esta realmente ativa -- antes ela
          ficava sempre montada (display:none) so pelo badge, disparando a RPC
          em TODA visita a esta pagina. O contador aparece ao abrir a aba. */}
      {escopo === "SEM_VALOR" && <CasosSemValor aoAtualizarContagem={setQtdSemValor} />}
      {escopo === "NAO_IDENTIFICADOS" && <PagamentosNaoIdentificados />}
      {escopo === "ACORDOS" && <FilaAcordosConfirmar />}

      {escopo === "PAGAMENTOS" && (
        <>
          <div style={A.topo}>
            <div>
              <h1 style={A.titulo}>Fila de confirmação de pagamento</h1>
              <p style={A.sub}>Pagamentos informados pela operação para confirmar e baixar.</p>
            </div>
            <button type="button" style={A.btnGhost} onClick={carregarSolicitacoes}>Atualizar</button>
          </div>

          <div style={A.barra}>
            <select style={A.select} value={filtro} onChange={(e) => setFiltro(e.target.value)}>
              <option value="PENDENTES">Pendentes{abertosTotal ? ` (${abertosTotal})` : ""}</option>
              <option value="AGUARDANDO_VINCULO">
                Recebido, aguardando vínculo{contadores.aguardandoVinculo ? ` (${contadores.aguardandoVinculo})` : ""}
              </option>
              <option value="CONFIRMADOS">Confirmados</option>
              <option value="TODOS">Todos</option>
            </select>
            <select style={A.select} value={ordem} onChange={(e) => setOrdem(e.target.value)}>
              <option value="DATA_DESC">Mais recentes primeiro</option>
              <option value="DATA_ASC">Mais antigos primeiro</option>
              <option value="VALOR_DESC">Maior valor primeiro</option>
              <option value="VALOR_ASC">Menor valor primeiro</option>
            </select>
            <input
              style={A.input}
              placeholder="Buscar por nome ou CPF..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <div style={A.contadores}>
              <span style={A.contadorAlunos}>{grupos.length} alunos</span>
              <span style={A.contadorAcordos}>{solicitacoesFiltradas.length} pagamentos</span>
              <span style={A.contadorValor}>{formatarMoeda(totalFiltrado)}</span>
            </div>
          </div>

          {grupos.length === 0 ? (
            <p style={A.muted}>Nenhuma solicitação neste filtro.</p>
          ) : (
            <div style={A.cards}>
              {grupos.map((g) => {
                const confirmaveis = g.itens.filter(podeConfirmarSolicitacao);
                const busyGrp = !!processando[`grp:${g.chave}`];
                return (
                  <div key={g.chave} style={A.card}>
                    <div style={A.cardHead}>
                      <div style={A.cardHeadInfo}>
                        <span style={A.cardNome}>{g.nome || "Aluno sem nome"}</span>
                        <span style={A.cardCpf}>
                          {g.cpf ? `CPF ${formatCpf(g.cpf)}` : "sem CPF cadastrado"}
                        </span>
                      </div>
                      <div style={A.cardHeadDir}>
                        <span style={A.cardResumo}>
                          {g.itens.length} pagamento{g.itens.length > 1 ? "s" : ""} · {formatarMoeda(g.total)}
                          {g.primeiroEm ? ` · na fila desde ${formatarDia(g.primeiroEm)}` : ""}
                        </span>
                        {confirmaveis.length > 0 && (
                          <button
                            type="button"
                            style={{ ...A.btnConf, ...(busyGrp ? A.btnBusy : {}) }}
                            disabled={busyGrp}
                            onClick={() => confirmarGrupo(g)}
                            title={
                              confirmaveis.length > 1
                                ? "Confirma de uma vez todos os pagamentos pendentes deste aluno"
                                : "Confirma o pagamento pendente deste aluno"
                            }
                          >
                            {busyGrp
                              ? "Confirmando..."
                              : confirmaveis.length > 1
                                ? `Confirmar os ${confirmaveis.length} pagamentos`
                                : "Confirmar pagamento"}
                          </button>
                        )}
                        {podeQuitar(emailUsuario) && g.abertos.length > 0 && (
                          <button
                            type="button"
                            style={styles.btnQuitar}
                            onClick={() => quitarEEncerrar(g.abertos[0])}
                            title="Quita, zera e tira das filas. Não volta pro operador."
                          >
                            💰 Quitar e encerrar
                          </button>
                        )}
                        <button
                          type="button"
                          style={A.btnFicha}
                          onClick={() => abrirFicha(g.abertos[0] || g.itens[0])}
                        >
                          Abrir ficha
                        </button>
                      </div>
                    </div>

                    <table style={A.tabela}>
                      <thead>
                        <tr>
                          <th style={A.th}>Enviado em</th>
                          <th style={A.th}>Operador que informou</th>
                          <th style={A.th}>Origem da dívida</th>
                          <th style={A.th}>Tipo informado</th>
                          <th style={A.thNum}>Valor informado</th>
                          <th style={A.th}>Status</th>
                          <th style={A.th}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.itens.map((s) => {
                          const busy = !!processando[s.id];
                          const aberto = isConfirmacaoAberta(s.status);
                          const travado = aberto && !podeConfirmarSolicitacao(s);
                          return (
                            <tr
                              key={s.id}
                              style={{ cursor: "pointer" }}
                              onClick={() => abrirFicha(s)}
                              title="Abrir ficha do aluno"
                            >
                              <td style={A.td}>{formatarData(s.criado_em)}</td>
                              <td style={A.td}>{s.operador_nome || s.operador_email || "-"}</td>
                              <td style={A.td}>{traduzOrigem(s.origem_divida)}</td>
                              <td style={A.td}>{traduzTipo(s.forma_pagamento)}</td>
                              <td style={A.tdNum}>{formatarMoeda(s.valor_informado)}</td>
                              <td style={A.td}>
                                <span style={{ ...A.chip, ...chipStatus(s.status) }}>{traduzStatus(s.status)}</span>
                              </td>
                              <td style={A.td}>
                                <div style={A.acoes} onClick={(e) => e.stopPropagation()}>
                                  {travado && (
                                    <button
                                      type="button"
                                      style={A.btnVinc}
                                      onClick={() => { abrirFicha(s); setAbaFicha("acordo"); }}
                                      title="Sem vínculo com a dívida: acerte no financeiro para liberar a confirmação"
                                    >
                                      Acertar dívida
                                    </button>
                                  )}
                                  {aberto && (
                                    <button
                                      type="button"
                                      style={{ ...A.btnRej, ...(busy ? A.btnBusy : {}) }}
                                      disabled={busy}
                                      onClick={() => rejeitarNoCard(s)}
                                    >
                                      {busy ? "..." : "Rejeitar"}
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ---- Ficha do aluno (modal) ---- */}
      {detalhe && (
        <div style={A.modalOverlay} onClick={fecharFicha}>
          <div style={A.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <div style={A.cardHeadInfo}>
                <span style={A.modalTitulo}>{detalhe.aluno_nome || "Aluno sem nome"}</span>
                <span style={A.cardCpf}>CPF {formatCpf(detalhe.aluno_cpf)}</span>
              </div>
              <span style={{ ...A.chip, ...chipStatus(detalhe.status) }}>{traduzStatus(detalhe.status)}</span>
              {detalhe.aluno_id && (
                <button
                  type="button"
                  onClick={() => setAbaFicha("ficha")}
                  style={A.btnFicha}
                >
                  Abrir ficha completa
                </button>
              )}
              <button type="button" style={{ ...A.modalFechar, marginLeft: "auto" }} onClick={fecharFicha}>Fechar ✕</button>
            </div>

            {detalhe.aluno_id && (
              <div style={{ padding: "0 16px" }}>
                <DadosAcademicos aluno={{ id: detalhe.aluno_id, cpf: detalhe.aluno_cpf }} />
              </div>
            )}

            <div style={styles.abas}>
              {["resumo", "ficha", "financeiro", "acordo", "historico", "comprovante"].map((a) => (
                <button
                  key={a}
                  style={abaFicha === a ? styles.abaAtiva : styles.aba}
                  onClick={() => setAbaFicha(a)}
                >
                  {a === "resumo" ? "Resumo" : a === "ficha" ? "Ficha completa" : a === "financeiro" ? "Financeiro" : a === "acordo" ? "💳 Acordo / Baixa" : a === "historico" ? "Histórico" : "Comprovante"}
                </button>
              ))}
            </div>

            <div style={A.modalConteudo}>
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

              {abaFicha === "ficha" && detalhe?.aluno_id && (
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", background: "#fff" }}>
                  <Alunos fichaEmbedId={detalhe.aluno_id} />
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

              {abaFicha === "acordo" && (
                <div>
                  <p style={{ ...styles.info, marginBottom: 10 }}>
                    Lance acordo, quite parcelas ou registre pagamento à vista aqui mesmo — sem sair
                    da fila. As ações e permissões são as mesmas da ficha do aluno.
                  </p>
                  {carregandoAlunoFin || !alunoFin ? (
                    <p style={styles.info}>Carregando financeiro do aluno…</p>
                  ) : (
                    <FinanceiroAluno aluno={alunoFin} />
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
                      {/* Bucket privado: abre via URL assinada de curta duração
                          obtida pela Edge Function a partir do ID do link. */}
                      <button
                        type="button"
                        onClick={() => abrirDocumento(() => urlComprovanteLink(comprovante.id))}
                        style={styles.botaoPequeno}
                      >
                        Abrir comprovante em nova aba
                      </button>
                    </div>
                  ) : (
                    <p style={styles.info}>Nenhum comprovante anexado a este aluno.</p>
                  )}
                </div>
              )}
            </div>

            {isConfirmacaoAberta(detalhe.status) && (() => {
              const completos = dadosMinimosOk(detalhe);
              // "Recebido, aguardando vínculo": a conclusão só é liberada DEPOIS
              // que Amanda/Fernanda identificarem manualmente a dívida (tipo +
              // parcela/título/acordo). Para AGUARDANDO_CONFIRMACAO o fluxo antigo
              // é preservado.
              const aguardandoVinculo = detalhe.status === STATUS_AGUARDANDO_VINCULO;
              const confirmavel = aguardandoVinculo ? completos : true;
              return (
                <div style={styles.modalAcoes}>
                  {aguardandoVinculo && (
                    <div style={{ ...styles.incompleto, background: "#f5f3ff", color: "#5b21b6", border: "1px solid #ddd6fe" }}>
                      Pagamento <strong>recebido</strong>, mas ainda <strong>sem vínculo</strong>. Ajuste
                      a dívida na aba <strong>Financeiro</strong> (mensalidade, parcela de acordo,
                      entrada ou quitação total) — ou use <strong>“Rejeitar / devolver”</strong> para “pagamento
                      sem vínculo localizado”. A conclusão fica bloqueada até o acerto no Financeiro. Nada é quitado,
                      reposto ou alterado enquanto aguarda vínculo.
                    </div>
                  )}
                  {!completos && !aguardandoVinculo && (
                    <div style={styles.incompleto}>
                      Dados financeiros incompletos — falta valor, data, tipo e/ou a
                      identificação da dívida (parcela, título ou acordo). A confirmação
                      definitiva fica bloqueada até vincular os dados.
                    </div>
                  )}

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
                      <div style={styles.acoes}>
                        <button
                          style={confirmavel && !processando[detalhe.id] ? styles.botaoConfirmar : styles.botaoDesabilitado}
                          disabled={!confirmavel || !!processando[detalhe.id]}
                          title={confirmavel ? "" : "Ajuste a dívida na aba Financeiro antes de concluir."}
                          onClick={() => confirmavel && !processando[detalhe.id] && finalizarSolicitacao(detalhe)}
                        >
                          {processando[detalhe.id] ? "Confirmando..." : "Confirmar pagamento"}
                        </button>
                        {podeQuitar(usuario?.email) && (
                          <button
                            style={{ background: "#6b21a8", color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}
                            onClick={() => quitarEEncerrar(detalhe)}
                            title="Quita, zera e tira das filas. Nao volta pro operador."
                          >
                            💰 Quitar e encerrar
                          </button>
                        )}
                        {podeQuitar(usuario?.email) && (
                          <button
                            style={{ background: "#0f766e", color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}
                            onClick={() => confirmarSaldoZero(detalhe)}
                            title="Retira das filas e da contagem dos 500, bloqueia redistribuição e libera reposição. Preserva financeiro e histórico. Exige motivo."
                          >
                            ✅ Confirmar saldo zero e retirar das filas
                          </button>
                        )}
                        <button style={styles.botaoRejeitar} onClick={() => rejeitarPagamento(detalhe, motivoRejeicao)}>
                          Rejeitar / devolver
                        </button>
                      </div>
                  </>
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
  container: { padding: "24px", fontFamily: "Arial, sans-serif", background: "#f4f6f8", minHeight: "100%" },
  titulo: { margin: 0, marginBottom: "6px", color: "#111827" },
  btnQuitar: { background: "#6b21a8", color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  escopo: { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" },
  escopoBotao: { background: "#fff", border: "1px solid #d1d5db", color: "#374151", padding: "10px 18px", borderRadius: 10, cursor: "pointer", fontSize: 14, fontWeight: 700 },
  escopoAtivo: { background: "#1e40af", border: "1px solid #1e40af", color: "#fff", padding: "10px 18px", borderRadius: 10, cursor: "pointer", fontSize: 14, fontWeight: 800 },
  abas: { display: "flex", gap: "8px", padding: "12px 20px 0", flexWrap: "wrap" },
  aba: { background: "#f1f5f9", border: "none", color: "#475569", padding: "8px 14px", borderRadius: "8px 8px 0 0", cursor: "pointer", fontSize: "13px" },
  abaAtiva: { background: "#0ea5e9", border: "none", color: "#fff", padding: "8px 14px", borderRadius: "8px 8px 0 0", cursor: "pointer", fontSize: "13px", fontWeight: "bold" },
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
