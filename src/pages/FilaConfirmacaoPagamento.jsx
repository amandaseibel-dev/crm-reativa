import { useEffect, useMemo, useRef, useState } from "react";
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
import MensalidadesAVincular from "../components/MensalidadesAVincular";
import FilaAcordosConfirmar from "./FilaAcordosConfirmar";
import { S as A } from "../ui/estilosFila";

// A tela é a MESMA da fila de acordos: 1 card por aluno, tabela dos pagamentos
// dele e a ação de confirmar no próprio card (sem precisar abrir o modal).
// Os estilos vêm importados de lá justamente pra não divergirem com o tempo.

// Teto da API: cada requisicao devolve no maximo 1000 linhas.
const PAGE_SIZE = 1000;

// Cards desenhados por vez na lista (ver comentario em quantosCards).
const CARDS_POR_VEZ = 40;

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
  // MAIOR VALOR PRIMEIRO (Amanda, 27/08/2026: "se tu colocar na confirmacao por
  // maior valor me ajuda, maior valor total").
  //
  // O valor e o do ALUNO -- a soma das confirmacoes abertas dele --, nao o de
  // uma linha solta. Um aluno com tres pagamentos pequenos pode pesar mais que
  // outro com um medio, e e o aluno que ela abre.
  //
  // POR QUE ISSO E O PADRAO. Medido no dia: em quatro dias sairam 172 casos
  // quitados, R$ 241.901,43 -- 0,5% de um saldo de R$ 47,7 milhoes. O caso que
  // ela vinha quitando vale R$ 1.441 em media; o caso medio da carteira vale
  // R$ 3.317. A contagem caia e o dinheiro nao se mexia. Comecando pelos
  // maiores, cada confirmacao fechada pesa.
  //
  // Antes disto o padrao era DATA_DESC (mais recentes primeiro), numa fila que
  // cresce a cada importacao -- entao a cauda nunca era alcancada. "Mais
  // antigos primeiro" continua na lista, junto com o botao "Parados +30 dias",
  // para atacar as 560 que esperam ha mais de um mes.
  const [ordem, setOrdem] = useState("VALOR_DESC");
  // Escopo do trabalho: pagamentos, acordos importados e as listas auxiliares
  // (nao identificados / sem valor / sem telefone), que antes eram "filtros" e
  // nao filtravam nada -- trocavam a tela inteira. Agora sao abas de verdade.
  const [escopo, setEscopo] = useState("PAGAMENTOS");
  const [busca, setBusca] = useState("");
  // O placar do dia. Amanda: "eu estou fazendo bastante por dia" -- e estava
  // mesmo: 276 fechadas em 26/08, 593 em quatro dias contra 231 que entraram.
  // A tela nunca mostrou isso. Ela fechava centenas e abria no dia seguinte com
  // a pilha na frente, sem nada dizendo que a pilha tinha encolhido -- por isso
  // a sensacao de andar em circulos. Nao era ritmo, era falta de placar.
  const [placar, setPlacar] = useState(null);
  // Copiar o nome do aluno direto do card: e o que ela cola na busca do Prime
  // para conferir o pagamento. Sem isso, seleciona com o mouse e erra pedaco do
  // nome (Amanda, 27/08/2026).
  const [nomeCopiado, setNomeCopiado] = useState(null);
  // Linhas ja buscadas, por filtro. Volta para uma aba vista = instantaneo.
  const cacheFiltro = useRef({});
  const primeiraCarga = useRef(true);
  // Ficha do aluno em modal -- exatamente o que "Acordos a confirmar" faz.
  // Amanda, 27/08/2026: "deixar exatamente igual a forma como abre o card, um
  // padrao, cada um esta abrindo de um jeito". Aqui o clique abria um painel de
  // detalhe da SOLICITACAO, com abas; la abria a FICHA DO ALUNO. Duas telas
  // irmas, dois comportamentos, e ela alternando entre as duas o dia inteiro.
  //
  // Agora as duas abrem a ficha do aluno. O painel da solicitacao continua
  // existindo -- e onde ficam comprovante e rejeicao -- mas passa a ser um
  // botao explicito ("Detalhes"), nao o comportamento padrao do clique.
  const [fichaAlunoId, setFichaAlunoId] = useState(null);
  // Ver so a cauda -- o que esta esperando ha mais de 30 dias.
  const [soAntigos, setSoAntigos] = useState(false);
  // Quantos cards desenhar de uma vez. A tela desenhava TODOS os grupos -- 1.650
  // cards, cada um com sua tabela interna, somando 2.121 linhas num unico
  // render. Os dados chegam rapido (a consulta roda em milissegundos); o que
  // travava era o navegador montar tudo isso de uma vez (Amanda, 26/08/2026:
  // "fila de confirmacao de pagamento esta bem lenta").
  const [quantosCards, setQuantosCards] = useState(CARDS_POR_VEZ);
  const [qtdSemValor, setQtdSemValor] = useState(null);
  const [qtdAcordoSemValor, setQtdAcordoSemValor] = useState(null);
  const [qtdSemTelefone, setQtdSemTelefone] = useState(null);
  const [qtdAVincular, setQtdAVincular] = useState(null);

  // Ficha do aluno (modal leve reaproveitando as pecas ja existentes:
  // financeiro em aberto, historico de movimentacoes e comprovante).
  const [detalhe, setDetalhe] = useState(null); // solicitacao selecionada
  const [abaFicha, setAbaFicha] = useState("resumo");
  const [historico, setHistorico] = useState([]);
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
    if (abaFicha !== "financeiro" || !detalhe?.aluno_id) return;
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
    // Trocar de aba nao mexe nos contadores: eles nao dependem do filtro.
    carregarSolicitacoes(primeiraCarga.current);
    primeiraCarga.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtro]);

  useEffect(() => {
    carregarUsuario();
    // A origem da divida e carimbada quando a solicitacao nasce, mas o saldo do
    // aluno muda enquanto o caso espera (ele fecha acordo, paga mensalidade).
    // Recarimba os ABERTOS uma vez ao abrir a tela; se algo mudou, recarrega.
    // Falha aqui nao atrapalha a fila -- so deixa a classificacao desatualizada.
    carregarPlacar();
    carregarContagemSemTelefone();
    supabase
      .rpc("recarimbar_origem_divida_pendentes", { p_limite: 5000 })
      .then(({ data, error }) => {
        if (error) return;
        if (Number(data?.atualizadas) > 0) carregarSolicitacoes();
      });
  }, []);

  async function copiarNome(nome, chave, e) {
    if (e) e.stopPropagation();
    const texto = String(nome || "").trim();
    if (!texto) return;
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      // Fallback para navegador sem Clipboard API (ou pagina sem HTTPS).
      const ta = document.createElement("textarea");
      ta.value = texto;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setNomeCopiado(chave);
    setTimeout(() => setNomeCopiado((atual) => (atual === chave ? null : atual)), 1500);
  }

  // Quantos alunos estao sem telefone -- contagem pelo banco, sem trazer linha.
  // Substitui a varredura de 3.821 registros que a aba fazia so para o badge.
  async function carregarContagemSemTelefone() {
    try {
      const [nulos, vazios] = await Promise.all([
        supabase.from("alunos").select("id", { count: "exact", head: true }).is("telefone", null),
        supabase.from("alunos").select("id", { count: "exact", head: true }).eq("telefone", ""),
      ]);
      setQtdSemTelefone((nulos.count || 0) + (vazios.count || 0));
    } catch {
      setQtdSemTelefone(null);
    }
  }

  // Atualiza SO as linhas do aluno que acabou de ser mexido.
  //
  // Fechar a ficha recarregava a fila inteira -- 1.129 linhas mais quatro
  // contagens -- e a tela travava a cada fechamento (Amanda, 27/08/2026:
  // "quando fecho a aba da fila de confirmacao de pagamento demora para
  // carregar"). Foi defeito que eu mesmo introduzi ao fazer o modal recarregar
  // no fechamento.
  //
  // O que muda quando ela resolve alguem e o que aconteceu COM AQUELE ALUNO.
  // Entao busca so as linhas dele e troca no lugar: uma requisicao pequena,
  // sem spinner, sem perder a posicao da rolagem.
  async function atualizarAluno(alunoId) {
    const id = String(alunoId || "").trim();
    if (!id) return;
    // O que estava guardado por filtro ficou velho para este aluno.
    cacheFiltro.current = {};
    try {
      const { data, error } = await supabase
        .from("solicitacoes_confirmacao_pagamento")
        .select("*")
        .eq("aluno_id", id);
      if (error) return;
      const novas = data || [];
      setSolicitacoes((atual) => {
        const semEsse = atual.filter((x) => String(x.aluno_id || "") !== id);
        return [...semEsse, ...novas];
      });
    } catch { /* silencioso: a fila continua valida com o que ja tem */ }
  }

  // Fechadas e abertas HOJE, direto do banco (contagem, sem trazer linha).
  async function carregarPlacar() {
    const hoje = new Date();
    const iso = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}`;
    try {
      const [fech, novas] = await Promise.all([
        supabase.from("solicitacoes_confirmacao_pagamento")
          .select("id", { count: "exact", head: true })
          .gte("confirmado_em", `${iso}T00:00:00`),
        supabase.from("solicitacoes_confirmacao_pagamento")
          .select("id", { count: "exact", head: true })
          .gte("criado_em", `${iso}T00:00:00`),
      ]);
      setPlacar({ fechadas: fech.count || 0, novas: novas.count || 0 });
    } catch {
      setPlacar(null);
    }
  }

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

  async function carregarSolicitacoes(contarDeNovo = true) {
    setCarregando(true);
    try {
      // A aba decide o que precisa vir; nunca a base inteira "por via das duvidas".
      const statusAlvo =
        filtro === "CONFIRMADOS" ? ["PAGAMENTO_CONFIRMADO"]
        : filtro === "AGUARDANDO_VINCULO" ? [STATUS_AGUARDANDO_VINCULO]
        : filtro === "TODOS" ? null
        : STATUS_CONFIRMACAO_ABERTOS;

      // Cache por filtro: voltar para uma aba ja vista e instantaneo. A lista
      // continua sendo buscada em segundo plano para nao ficar velha, mas ela
      // ve o conteudo na hora em vez de esperar a viagem inteira.
      const emCache = cacheFiltro.current[filtro];
      if (emCache) {
        setSolicitacoes(emCache);
        setCarregando(false);
      }

      const linhas = await buscarPaginado(statusAlvo);
      cacheFiltro.current[filtro] = linhas;
      setSolicitacoes(linhas);

      // Os quatro contadores NAO dependem do filtro escolhido -- sao sempre os
      // mesmos numeros. Recalcula-los a cada troca de aba custava quatro idas
      // ao banco por clique, sem mudar nada na tela. Agora so na abertura e
      // depois de uma acao.
      if (contarDeNovo) {
        const [nPendentes, nVinculo, nConfirmados, nTodos] = await Promise.all([
          contar([STATUS_AGUARDANDO_CONFIRMACAO]),
          contar([STATUS_AGUARDANDO_VINCULO]),
          contar(["PAGAMENTO_CONFIRMADO"]),
          contar(null),
        ]);
        setContadores({
          pendentes: nPendentes,
          aguardandoVinculo: nVinculo,
          confirmados: nConfirmados,
          todos: nTodos,
        });
      }
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

        // As parcelas e as mensalidades NAO sao mais buscadas aqui: a aba
        // Financeiro renderiza a ficha de verdade (FinanceiroAluno), que busca
        // o que precisa e ainda calcula o saldo pela fonte unica. Duas
        // consultas a menos toda vez que um card e aberto.

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
    // So o aluno mexido -- recarregar a fila inteira aqui travava a tela a cada
    // acao, e ela faz mais de 150 por dia.
    atualizarAluno(s.aluno_id);
    carregarPlacar();
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
    // So o aluno mexido -- recarregar a fila inteira aqui travava a tela a cada
    // acao, e ela faz mais de 150 por dia.
    atualizarAluno(s.aluno_id);
    carregarPlacar();
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
    atualizarAluno(g.alunoId || g.itens?.[0]?.aluno_id);
    carregarPlacar();
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
      atualizarAluno(s.aluno_id);
      carregarPlacar();
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
    // So o aluno mexido -- recarregar a fila inteira aqui travava a tela a cada
    // acao, e ela faz mais de 150 por dia.
    atualizarAluno(s.aluno_id);
    carregarPlacar();
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
    const corte = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const comIdade = soAntigos ? base.filter((s) => ts(s.criado_em) && ts(s.criado_em) < corte) : base;
    return [...comIdade].sort((a, b) => {
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
  }, [solicitacoes, filtro, ordem, busca, soAntigos]);

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
      // Ha quantos dias o aluno espera. E o numero que diz se a fila esta
      // andando ou so recebendo.
      g.diasNaFila = g.primeiroEm
        ? Math.floor((Date.now() - g.primeiroEm) / 86400000)
        : null;
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

  // Quantas estao paradas ha mais de 30 dias -- a cauda que a ordem antiga
  // escondia. Conta sobre os ABERTOS, nao sobre o filtro atual.
  const totalAntigos = useMemo(() => {
    const corte = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return solicitacoes.filter(
      (s) => isConfirmacaoAberta(s.status) && ts(s.criado_em) && ts(s.criado_em) < corte
    ).length;
  }, [solicitacoes]);

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
    { chave: "A_VINCULAR", rotulo: "Mensalidades a vincular", badge: qtdAVincular },
    { chave: "SEM_TELEFONE", rotulo: "Sem telefone", badge: qtdSemTelefone },
  ];
  const abasEscopo = (
    <div style={styles.escopo}>
      {ESCOPOS.map((e) => (
        <button
          key={e.chave}
          type="button"
          style={escopo === e.chave ? styles.escopoAtivo : styles.escopoBotao}
          onClick={() => { setEscopo(e.chave); setQuantosCards(CARDS_POR_VEZ); }}
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
      {/* SOB DEMANDA. Esta aba baixa TODOS os alunos sem telefone -- 3.821 em
          producao, em duas varreduras paginadas de mil em mil. Ficava montada
          escondida so pelo badge, entao toda visita a esta tela pagava esse
          preco antes de mostrar qualquer coisa (Amanda, 27/08/2026: "esta bem
          lenta a tela de confirmacao de pagamento"). O numero do badge agora
          vem de uma contagem no banco, que nao traz linha nenhuma. Mesmo
          tratamento que "Sem valor calculado" ja tinha. */}
      {/* SOB DEMANDA: a RPC varre acordos_titulos inteiro cruzando com acordos e
          pagamentos. So monta quando a aba esta ativa -- o mesmo cuidado que
          "Sem telefone" e "Sem valor calculado" ja recebem. */}
      {escopo === "A_VINCULAR" && (
        <MensalidadesAVincular aoAtualizarContagem={setQtdAVincular} />
      )}
      {escopo === "SEM_TELEFONE" && (
        <CasosSemTelefone aoAtualizarContagem={setQtdSemTelefone} />
      )}
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

          {placar && (placar.fechadas > 0 || placar.novas > 0) && (
            <div style={styles.placar}>
              <b>Hoje: {placar.fechadas} confirmação{placar.fechadas === 1 ? "" : "ões"} fechada{placar.fechadas === 1 ? "" : "s"}</b>
              {" · "}{placar.novas} entrou{placar.novas === 1 ? "" : " / entraram"}
              {placar.fechadas > placar.novas && (
                <> — a fila caiu <b>{placar.fechadas - placar.novas}</b> hoje.</>
              )}
              {placar.fechadas < placar.novas && (
                <> — a fila subiu <b>{placar.novas - placar.fechadas}</b> hoje.</>
              )}
            </div>
          )}

          <div style={A.barra}>
            <select style={A.select} value={filtro} onChange={(e) => { setFiltro(e.target.value); setQuantosCards(CARDS_POR_VEZ); }}>
              <option value="PENDENTES">Pendentes{abertosTotal ? ` (${abertosTotal})` : ""}</option>
              <option value="AGUARDANDO_VINCULO">
                Recebido, aguardando vínculo{contadores.aguardandoVinculo ? ` (${contadores.aguardandoVinculo})` : ""}
              </option>
              <option value="CONFIRMADOS">Confirmados</option>
              <option value="TODOS">Todos</option>
            </select>
            <button
              type="button"
              onClick={() => { setSoAntigos((v) => !v); setQuantosCards(CARDS_POR_VEZ); }}
              title="Só o que está esperando há mais de 30 dias"
              style={{
                ...A.select, cursor: "pointer", fontWeight: 700,
                background: soAntigos ? "#fef2f2" : "#fff",
                borderColor: soAntigos ? "#fecaca" : undefined,
                color: soAntigos ? "#991b1b" : undefined,
              }}
            >
              ⏳ Parados +30 dias{totalAntigos ? ` (${totalAntigos})` : ""}
            </button>
            <select style={A.select} value={ordem} onChange={(e) => setOrdem(e.target.value)}>
              <option value="VALOR_DESC">Maior valor primeiro</option>
              <option value="DATA_ASC">Mais antigos primeiro</option>
              <option value="DATA_DESC">Mais recentes primeiro</option>
              <option value="VALOR_ASC">Menor valor primeiro</option>
            </select>
            <input
              style={A.input}
              placeholder="Buscar por nome ou CPF..."
              value={busca}
              onChange={(e) => { setBusca(e.target.value); setQuantosCards(CARDS_POR_VEZ); }}
            />
            <button
              type="button"
              style={A.btnGhost}
              disabled={carregando}
              onClick={() => carregarSolicitacoes()}
              title="Buscar de novo no banco -- a lista nao se atualiza sozinha"
            >
              {carregando ? "Atualizando..." : "↻ Atualizar"}
            </button>
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
              {grupos.slice(0, quantosCards).map((g) => {
                const confirmaveis = g.itens.filter(podeConfirmarSolicitacao);
                const busyGrp = !!processando[`grp:${g.chave}`];
                return (
                  <div key={g.chave} style={A.card}>
                    <div style={A.cardHead}>
                      <div style={A.cardHeadInfo}>
                        <span style={A.cardNome}>{g.nome || "Aluno sem nome"}</span>
                        {g.nome && (
                          <button
                            type="button"
                            onClick={(e) => copiarNome(g.nome, g.chave, e)}
                            title="Copiar o nome do aluno"
                            style={{
                              ...styles.btnCopiar,
                              color: nomeCopiado === g.chave ? "#16a34a" : "#94a3b8",
                            }}
                          >
                            {nomeCopiado === g.chave ? "✓ copiado" : "📋 copiar nome"}
                          </button>
                        )}
                        <span style={A.cardCpf}>
                          {g.cpf ? `CPF ${formatCpf(g.cpf)}` : "sem CPF cadastrado"}
                        </span>
                      </div>
                      <div style={A.cardHeadDir}>
                        <span style={A.cardResumo}>
                          {g.itens.length} pagamento{g.itens.length > 1 ? "s" : ""} · {formatarMoeda(g.total)}
                          {g.primeiroEm ? ` · na fila desde ${formatarDia(g.primeiroEm)}` : ""}
                        </span>
                        {g.diasNaFila != null && (
                          <span style={g.diasNaFila >= 30 ? styles.seloVelho : styles.seloIdade}>
                            {g.diasNaFila === 0
                              ? "chegou hoje"
                              : `parado há ${g.diasNaFila} dia${g.diasNaFila > 1 ? "s" : ""}`}
                          </span>
                        )}
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
                          onClick={() => {
                            const alvo = g.abertos[0] || g.itens[0];
                            if (alvo?.aluno_id) setFichaAlunoId(String(alvo.aluno_id));
                          }}
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
                              onClick={() => s.aluno_id && setFichaAlunoId(String(s.aluno_id))}
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
                                  <button
                                    type="button"
                                    style={A.btnGhost}
                                    onClick={() => abrirFicha(s)}
                                    title="Comprovante, historico e rejeicao deste pagamento"
                                  >
                                    Detalhes
                                  </button>
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

          {grupos.length > quantosCards && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
              <button type="button" style={A.btnGhost}
                onClick={() => setQuantosCards((n) => n + CARDS_POR_VEZ)}>
                Mostrar mais {Math.min(CARDS_POR_VEZ, grupos.length - quantosCards)} — faltam {grupos.length - quantosCards}
              </button>
            </div>
          )}
        </>
      )}

      {/* ---- Ficha do aluno (modal) -- mesmo padrao de "Acordos a confirmar" ---- */}
      {fichaAlunoId && (
        <div style={A.modalOverlay} onClick={() => setFichaAlunoId(null)}>
          <div style={A.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <span style={A.modalTitulo}>Ficha do aluno</span>
              <button
                type="button"
                style={{ ...A.modalFechar, marginLeft: "auto" }}
                onClick={() => {
                  const alvo = fichaAlunoId;
                  setFichaAlunoId(null);
                  // So o aluno mexido -- nao a fila inteira.
                  atualizarAluno(alvo);
                  carregarPlacar();
                }}
              >
                Fechar ✕
              </button>
            </div>
            <div style={A.modalConteudo}>
              <Alunos fichaEmbedId={fichaAlunoId} />
            </div>
          </div>
        </div>
      )}

      {/* ---- Detalhe da solicitacao: comprovante, historico, rejeicao ---- */}
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
              {["resumo", "ficha", "financeiro", "historico", "comprovante"].map((a) => (
                <button
                  key={a}
                  style={abaFicha === a ? styles.abaAtiva : styles.aba}
                  onClick={() => setAbaFicha(a)}
                >
                  {a === "resumo" ? "Resumo" : a === "ficha" ? "Ficha completa" : a === "financeiro" ? "💳 Financeiro" : a === "historico" ? "Histórico" : "Comprovante"}
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
              {/* A MESMA ficha financeira da base -- nao uma copia.
                  Antes havia duas abas de dinheiro: "Financeiro", uma lista
                  simplificada e sem acao nenhuma, e "Acordo / Baixa", que
                  trazia a ficha de verdade. Quem chegava pela fila caia na
                  copia, via numeros diferentes dos da base e nao tinha como
                  vincular mensalidade (Amanda, 26/08/2026: "esta bem confuso e
                  nao consigo vincular"). Agora e uma aba so, e ela e a real:
                  mesmas contas, mesmas acoes, mesmas permissoes. */}
              {abaFicha === "financeiro" && (
                <div>
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
  btnCopiar: {
    border: "none", background: "none", padding: "0 4px", cursor: "pointer",
    fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap",
  },
  placar: {
    background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534",
    borderRadius: 10, padding: "10px 14px", fontSize: 13.5, marginBottom: 12,
  },
  seloIdade: {
    fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: "2px 10px",
    background: "#f1f5f9", color: "#334155", border: "1px solid #e2e8f0", whiteSpace: "nowrap",
  },
  seloVelho: {
    fontSize: 11.5, fontWeight: 800, borderRadius: 999, padding: "2px 10px",
    background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", whiteSpace: "nowrap",
  },
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
