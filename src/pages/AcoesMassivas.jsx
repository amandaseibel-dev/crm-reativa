import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";
import BotaoAtualizar from "../components/BotaoAtualizar";
import PenetracaoPorAno from "../components/PenetracaoPorAno";
import { rotuloMotivo } from "../utils/motivosAcaoMassiva";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const VERDE = "var(--rv-azul-texto)";
// Presets do seletor "Sem acionamento há (mín.)" — valor = nº de dias.
const PRESETS_DIAS_SEM_ACIONAMENTO = ["7", "12", "15", "21", "30", "45", "60", "90"];
// Tipo de cobrança. A regra mora no banco (acoes_massivas_tipo_cobranca_alunos
// e _corresponde): a tela só escolhe. Não existe "Todos": a opção que junta
// tudo é "Mensalidades e acordos". Acordo em dia fica fora de todas.
const TIPOS_COBRANCA = [
  { valor: "MENSALIDADES", rotulo: "Somente mensalidades" },
  { valor: "ACORDOS_VENCIDOS", rotulo: "Somente acordos vencidos" },
  { valor: "MENSALIDADES_E_ACORDOS", rotulo: "Mensalidades e acordos" },
];
const AJUDA_TIPO_COBRANCA = {
  MENSALIDADES: "Alunos com mensalidade original em aberto e sem acordo vencido. Quem tem os dois está em “Somente acordos vencidos”. Acordo em dia fica fora.",
  ACORDOS_VENCIDOS: "Alunos com acordo quebrado ou parcela vencida, tenham ou não mensalidade em aberto. Acordo em dia fica fora.",
  MENSALIDADES_E_ACORDOS: "Os dois grupos juntos: somente mensalidades + acordos vencidos. Cada aluno aparece uma vez. Acordo em dia fica fora.",
};
function rotuloTipoCobranca(valor) {
  if (!valor || valor === "REGRA_ANTERIOR") return "Sem tipo (tela anterior)";
  return TIPOS_COBRANCA.find((t) => t.valor === valor)?.rotulo || valor;
}

// Filtro de acionamento (valores do banco). "Não acionados no mês" é o principal.
const OPCOES_ACIONAMENTO = [
  { valor: "TODOS", rotulo: "Todos" },
  { valor: "NAO_MES", rotulo: "Não acionados no mês (principal)" },
  { valor: "MES", rotulo: "Acionados no mês" },
  { valor: "NAO_HOJE", rotulo: "Não acionados hoje" },
  { valor: "HOJE", rotulo: "Acionados hoje" },
  { valor: "NUNCA", rotulo: "Nunca acionados" },
];
const ROTULO_ACIONAMENTO = Object.fromEntries(OPCOES_ACIONAMENTO.map((o) => [o.valor, o.rotulo]));

function formatarMoeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Cor do badge de status acadêmico por família de situação (só exibição).
function estiloStatusAcademico(situacao) {
  const base = {
    display: "inline-block", borderRadius: 6, padding: "1px 8px",
    fontSize: 11.5, fontWeight: 800, whiteSpace: "nowrap",
  };
  const s = String(situacao || "").toLowerCase();
  // Encerrados / sem vínculo ativo → vermelho (atenção: cobrança pode ser inócua)
  if (/(cancel|término|termino|desvincul|transfer|falecid|conclu[ií]|formad|saída|saida|reop)/.test(s))
    return { ...base, background: "var(--rv-vermelho-fundo)", color: "var(--rv-vermelho-texto)" };
  // Aguardando matrícula / trancado → âmbar (pendência acadêmica)
  if (/(aguardando|trancad|trancamento|reabertura|isen|certid)/.test(s))
    return { ...base, background: "var(--rv-ambar-fundo)", color: "var(--rv-ambar-texto)" };
  // Matriculado / normal → verde
  if (/(matriculad|normal|ativo|curr[ií]cul)/.test(s))
    return { ...base, background: "var(--rv-verde-ok-fundo)", color: "var(--rv-verde-ok-texto)" };
  // Demais → cinza neutro
  return { ...base, background: "var(--rv-fundo-suave)", color: "var(--rv-texto)" };
}

function converterValor(texto) {
  const limpo = String(texto || "").replace(/\./g, "").replace(",", ".").trim();
  const numero = Number(limpo);
  return Number.isFinite(numero) ? numero : null;
}

// Normaliza telefone pro formato 55DDDNUMERO (padrão internacional, sem
// espaço/símbolo, pronto pra ferramentas de disparo em massa). Trata os
// casos mais comuns de bagunça no cadastro: DDD duplicado, já ter o 55,
// e número de celular antigo sem o 9º dígito (completa automaticamente).
function normalizarTelefone(bruto) {
  let digitos = String(bruto || "").replace(/\D/g, "");
  if (!digitos) return null;

  // DDD duplicado tipo "(64) (64) 98122-6896" -> 6464981226896
  if (digitos.length === 13 && digitos.slice(0, 2) === digitos.slice(2, 4)) {
    digitos = digitos.slice(2);
  }
  if (digitos.length === 12 && digitos.slice(0, 2) === digitos.slice(2, 4) && digitos.slice(4, 5) !== "9") {
    digitos = digitos.slice(2);
  }

  // Separa o "55" (codigo do Brasil) do resto, se ja tiver.
  let temCodigoPais = false;
  let core = digitos;
  if (digitos.startsWith("55") && (digitos.length === 12 || digitos.length === 13)) {
    temCodigoPais = true;
    core = digitos.slice(2);
  }

  // Numero com 10 digitos (DDD + 8) esta sem o 9º dígito obrigatório do
  // celular -- completa. (Fixo teria os mesmos 10 dígitos, mas não recebe
  // WhatsApp mesmo, então não tem problema em "corrigir" ele também.)
  if (core.length === 10) {
    core = core.slice(0, 2) + "9" + core.slice(2);
  }

  if (core.length !== 11) {
    // Nao bateu em nenhum padrao esperado -- devolve mesmo assim, com 55
    // na frente, pra pelo menos nao quebrar o arquivo (mas pode precisar
    // de conferencia manual).
    return "55" + core;
  }

  return "55" + core;
}

export default function AcoesMassivas() {
  const [canal, setCanal] = useState("WHATSAPP"); // WHATSAPP | EMAIL
  const [valorMin, setValorMin] = useState("0");
  const [valorMax, setValorMax] = useState("");
  const [quantidade, setQuantidade] = useState("100");
  const [anoVencimento, setAnoVencimento] = useState("");
  // Selecao MULTIPLA de unidades: algumas ja encerraram e outras encerram a
  // matricula hoje, entao a gestao precisa marcar um subconjunto. O backend
  // recebe as unidades separadas por "|" -- uma sozinha continua funcionando
  // igual, entao nada que ja chamava a funcao quebrou.
  const [unidadesSel, setUnidadesSel] = useState([]);
  // Situacao da matricula no semestre corrente, vinda do Prime.
  const [matricula, setMatricula] = useState("");
  const [curso, setCurso] = useState("");
  // Status academico: selecao MULTIPLA, no mesmo formato das unidades. O
  // backend recebe os status separados por "|"; um sozinho funciona igual.
  const [situacoesAcadSel, setSituacoesAcadSel] = useState([]);
  const [opcoesUnidade, setOpcoesUnidade] = useState([]);
  const [opcoesCurso, setOpcoesCurso] = useState([]);
  const [opcoesSituacaoAcad, setOpcoesSituacaoAcad] = useState([]);
  // Carteiras importadas (borderôs). borderosSel = ids selecionados no filtro.
  const [opcoesBordero, setOpcoesBordero] = useState([]);
  const [borderosSel, setBorderosSel] = useState([]);
  // Operador responsável: "" = base livre / regra atual. Com um e-mail, a
  // prévia e o registro recortam SÓ a carteira atual daquele operador. A chave
  // é o e-mail (vem do cadastro via acoes_massivas_filtros), nunca o nome.
  // "TODOS" | "LIVRES" | e-mail. Nunca vazio/null: o banco recebe sempre um valor.
  const [operadorEmail, setOperadorEmail] = useState("LIVRES");
  const [opcoesOperador, setOpcoesOperador] = useState([]);
  // Recorte que o BANCO confirmou na última prévia. É ele que vai para o
  // registro: planilha e prévia saem sempre da mesma carteira.
  const [operadorDaPrevia, setOperadorDaPrevia] = useState(null);
  // Tipo de cobrança escolhido e o que o BANCO confirmou na última prévia (é
  // este que vai para a planilha e para o lote).
  // Sem padrão: a gestão escolhe o tipo antes de buscar. Nenhuma base é
  // ampliada ou reduzida sem uma escolha explícita.
  const [tipoCobranca, setTipoCobranca] = useState("");
  const [tipoDaPrevia, setTipoDaPrevia] = useState(null);
  const [diasMinimoSemContato, setDiasMinimoSemContato] = useState("");
  const [diasPersonalizado, setDiasPersonalizado] = useState(false);
  // TODOS | NAO_MES | MES | NAO_HOJE | HOJE | NUNCA
  const [acionamentoFiltro, setAcionamentoFiltro] = useState("TODOS");
  // Recência da ação massiva por canal, em dias (0–60).
  const [recenciaDias, setRecenciaDias] = useState("10");
  // O que o banco explicou na última prévia (painel) e o id dela (vai à exportação).
  const [resumoPrevia, setResumoPrevia] = useState(null);
  const [previaId, setPreviaId] = useState(null);
  const [soSemTelefone, setSoSemTelefone] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [gerando, setGerando] = useState(false);
  const [resultados, setResultados] = useState(null);
  const [erro, setErro] = useState("");
  const [sucesso, setSucesso] = useState("");
  const [porDia, setPorDia] = useState([]);
  const [saude, setSaude] = useState(null);
  const [retornos, setRetornos] = useState(null);
  // REGRA ABSOLUTA: casos em confirmação de pagamento nunca entram. A prévia os
  // devolve à parte (lista mascarada) só para transparência — eles não são elegíveis.
  const [excluidosConfirmacao, setExcluidosConfirmacao] = useState([]);
  // Data do extrato do Prime que a prévia usou para tirar quem já pagou lá.
  // A relação NÃO vem para a tela: quem consta liquidado não deve nem aparecer.
  const [primeExtratoEm, setPrimeExtratoEm] = useState(null);
  // Quantos alunos por tipo atendem aos filtros enviados ao banco -- já com o
  // contato do canal e a faixa de valor.
  const [contagemTipo, setContagemTipo] = useState(null);
  const [mostrarExcluidos, setMostrarExcluidos] = useState(false);
  const [excluidosNoEnvio, setExcluidosNoEnvio] = useState(0);
  // Guarda o último relatório gerado p/ permitir baixar manualmente caso o
  // download automático seja bloqueado pelo navegador (perda de "user gesture"
  // após os awaits do registrar — comum no Safari).
  const [relatorioPronto, setRelatorioPronto] = useState(null); // { linhas, nomeArquivo }
  // Planilhas exportadas que ainda não foram confirmadas nem descartadas. Ficam
  // no banco: o disparo externo pode levar horas e a página pode recarregar.
  const [lotesPendentes, setLotesPendentes] = useState([]);
  // Lote + ação ("CONFIRMAR" | "DESCARTAR") aguardando o "sim" explícito.
  const [acaoLote, setAcaoLote] = useState(null);
  const [concluindoLote, setConcluindoLote] = useState(false);

  // SOB DEMANDA: o painel analítico (saúde/retornos/por dia/elegíveis) não
  // carrega sozinho. Só roda no clique de Atualizar painel. A busca e a geração
  // de ações (operacionais) seguem normais, sob comando do usuário.
  const [carregandoPainel, setCarregandoPainel] = useState(false);
  const [painelEm, setPainelEm] = useState(null);
  const emVooPainel = useRef(false);
  const bloqueadoAtePainel = useRef(0);

  async function atualizarPainel() {
    const agora = Date.now();
    if (emVooPainel.current || agora < bloqueadoAtePainel.current) return;
    emVooPainel.current = true;
    bloqueadoAtePainel.current = agora + 15000;
    setCarregandoPainel(true);
    try {
      await Promise.all([carregarPorDia(), carregarSaude(), carregarRetornos()]);
      setPainelEm(new Date());
    } finally {
      emVooPainel.current = false;
      setCarregandoPainel(false);
    }
  }

  // Opções dos filtros de unidade/modalidade — carregadas uma vez na montagem.
  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("acoes_massivas_filtros");
      setOpcoesUnidade(data?.unidades || []);
      setOpcoesCurso(data?.cursos || []);
      setOpcoesSituacaoAcad(data?.situacoes_academicas || []);
      setOpcoesOperador(data?.operadores || []);
      const { data: bords } = await supabase.rpc("acoes_massivas_borderos");
      setOpcoesBordero(bords || []);
      const { data: lotes } = await supabase.rpc("acoes_massivas_lotes_pendentes");
      setLotesPendentes(Array.isArray(lotes) ? lotes : []);
    })();
  }, []);

  async function carregarLotesPendentes() {
    const { data: lotes } = await supabase.rpc("acoes_massivas_lotes_pendentes");
    setLotesPendentes(Array.isArray(lotes) ? lotes : []);
  }

  async function carregarSaude() {
    const { data } = await supabase.rpc("saude_da_base");
    setSaude(data);
  }

  async function carregarRetornos() {
    const { data } = await supabase.rpc("acoes_massivas_retornos", { p_dias: 3 });
    setRetornos(data || null);
  }

  async function carregarPorDia() {
    const { data } = await supabase.rpc("acoes_massivas_por_dia");
    setPorDia(data || []);
  }

  // Some com a prévia na tela. Usado quando o recorte muda: uma lista de um
  // operador nunca pode ficar à mostra (nem ser registrada) com outro escolhido.
  function limparPrevia() {
    setResultados(null);
    setOperadorDaPrevia(null);
    setTipoDaPrevia(null);
    setContagemTipo(null);
    setResumoPrevia(null);
    setPreviaId(null);
    setRelatorioPronto(null);
    setExcluidosConfirmacao([]);
    setPrimeExtratoEm(null);
    setMostrarExcluidos(false);
    setExcluidosNoEnvio(0);
    setSucesso("");
  }

  function nomeDoOperador(email) {
    if (String(email).toUpperCase() === "TODOS") return "Todos os operadores";
    if (String(email).toUpperCase() === "LIVRES") return "Sem responsável / livres";
    return opcoesOperador.find((o) => o.email === email)?.nome || email;
  }

  async function buscar(over = {}) {
    setErro("");
    setSucesso("");
    const min = valorMin.trim() ? converterValor(valorMin) : 0;
    const max = valorMax.trim() ? converterValor(valorMax) : null;
    const qtd = Math.max(1, Math.min(5000, Number(quantidade) || 100));
    const recencia = Math.max(0, Math.min(60, Number.parseInt(recenciaDias, 10) || 0));

    if (valorMin.trim() && min === null) {
      setErro("Valor mínimo inválido.");
      return;
    }
    if (valorMax.trim() && max === null) {
      setErro("Valor máximo inválido.");
      return;
    }
    if (!tipoCobranca) {
      setErro("Escolha o tipo de cobrança antes de buscar a prévia.");
      return;
    }

    setCarregando(true);
    setResultados(null);
    setOperadorDaPrevia(null);
    setTipoDaPrevia(null);
    setContagemTipo(null);
    setResumoPrevia(null);
    setPreviaId(null);
    setExcluidosConfirmacao([]);
    setPrimeExtratoEm(null);
    setMostrarExcluidos(false);
    setExcluidosNoEnvio(0);

    try {
      // TODOS os filtros (canal, valor, contato, acionamento, recência, operador)
      // vão ao BANCO, que aplica o limite exato só depois deles. A tela não corta,
      // não reordena e não filtra a lista devolvida.
      const operadorPedido = over.operador ?? operadorEmail;
      const argsPrevia = {
        p_ano_vencimento: (over.ano ?? anoVencimento) || null,
        p_limite: qtd,
        p_dias_minimo_sem_contato: diasMinimoSemContato ? Number(diasMinimoSemContato) : null,
        p_unidade: ((over.unidades ?? unidadesSel) || []).join("|") || null,
        p_matricula: (over.matricula ?? matricula) || null,
        p_curso: (over.curso ?? curso) || null,
        // vazio = TODAS as situações
        p_situacao_academica: ((over.situacoesAcad ?? situacoesAcadSel) || []).join("|") || null,
        p_importacao_ids: (over.borderosSel ?? borderosSel).length
          ? (over.borderosSel ?? borderosSel)
          : null,
        p_canal: canal,
        p_valor_min: min,
        p_valor_max: max,
        p_operador_email: operadorPedido,
        p_tipo_cobranca: tipoCobranca,
        p_acionamento: over.acionamento ?? acionamentoFiltro,
        p_recencia_dias: recencia,
        p_sem_telefone: canal === "EMAIL" && soSemTelefone,
      };
      const { data: previa, error: erroAlunos } = await supabase.rpc("acoes_massivas_previa", argsPrevia);
      if (erroAlunos) throw erroAlunos;

      // O banco devolve o recorte que aplicou (em minúsculas: 'todos'/'livres').
      // Se não bater com o pedido, a lista pode ser de outra carteira: não mostra nada.
      if (String(previa?.operador_email ?? "").toLowerCase() !== String(operadorPedido).toLowerCase()) {
        throw new Error("o banco não aplicou o filtro de operador. Nada foi listado.");
      }
      if (previa?.tipo_cobranca !== tipoCobranca) {
        throw new Error("o banco não aplicou o tipo de cobrança escolhido. Nada foi listado.");
      }
      setOperadorDaPrevia(operadorPedido);
      setTipoDaPrevia(tipoCobranca);
      setContagemTipo(previa?.contagem_tipo || null);
      setResumoPrevia(previa?.resumo || null);
      setPreviaId(previa?.previa_id || null);

      setExcluidosConfirmacao(previa?.excluidos_confirmacao || []);
      setPrimeExtratoEm(previa?.prime_extrato_em || null);

      // A prévia NÃO retorna telefone/e-mail completos (anti-enumeração): vêm
      // mascarados só pra exibição. Os contatos reais só são devolvidos por
      // acoes_massivas_exportar (gestão). A lista é exibida exatamente como veio.
      setResultados((previa?.elegiveis || []).map((a) => ({
        alunoId: a.id,
        nome: a.nome || "-",                       // já mascarado no backend (ex.: "Ana ***")
        situacaoAcademica: a.situacao_academica || null,
        curso: a.curso || null,
        unidade: a.unidade || null,
        telefoneMascarado: a.telefone_mascarado || "",
        emailMascarado: a.email_mascarado || "",
        semTelefone: !a.tem_telefone,
        valor: Number(a.valor || 0),
        temResponsavel: !!a.tem_responsavel,
        responsavelEmail: a.responsavel_email || null,
        fidelizacaoAtiva: !!a.fidelizacao_ativa,
        acionadoMes: !!a.acionado_mes,
        diasSemContato: a.data_ultimo_acionamento
          ? Math.floor((Date.now() - new Date(a.data_ultimo_acionamento).getTime()) / 86400000)
          : null,
      })));
    } catch (e) {
      console.error("Erro ao buscar casos livres:", e);
      setErro("Erro ao buscar: " + (e.message || "tente novamente"));
    } finally {
      setCarregando(false);
    }
  }

  // Monta e dispara o download do .xlsx. Chamado tanto automaticamente (após
  // registrar) quanto pelo botão manual (gesto novo do usuário) de fallback.
  function baixarPlanilha(rel) {
    if (!rel || !rel.linhas || rel.linhas.length === 0) return;
    const planilha = XLSX.utils.json_to_sheet(rel.linhas);
    const livro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(livro, planilha, "Ação Massiva");
    XLSX.writeFile(livro, rel.nomeArquivo);
  }

  // EXPORTAR NÃO É CONTATO REALIZADO. O disparo acontece numa ferramenta
  // externa; baixar a planilha não muda nada no aluno (tabulação, retorno,
  // fidelização, acionamento). O banco revalida, devolve os contatos e guarda um
  // LOTE de auditoria. O registro só acontece em "Confirmar ação realizada".
  async function exportarPlanilha() {
    if (!resultados || resultados.length === 0) return;

    setGerando(true);
    setErro("");
    setSucesso("");
    setExcluidosNoEnvio(0);

    try {
      const sufixoOperador = operadorDaPrevia && operadorDaPrevia.includes("@") ? `-${operadorDaPrevia.split("@")[0]}` : "";
      const tipoLote = tipoDaPrevia;
      const sufixoTipo = tipoLote ? `-${tipoLote.toLowerCase().replace(/_/g, "-")}` : "";
      const nomeArquivo = `acao-massiva-${canal.toLowerCase()}${sufixoOperador}${sufixoTipo}-${new Date().toISOString().slice(0, 10)}.xlsx`;

      const argsExportar = {
        p_aluno_ids: resultados.map((r) => String(r.alunoId)),
        p_canal: canal,
        p_arquivo: nomeArquivo,
      };
      // Mesmo recorte da prévia ('TODOS' | 'LIVRES' | e-mail) e a mesma prévia.
      argsExportar.p_operador_email = operadorDaPrevia;
      if (previaId) argsExportar.p_previa_id = previaId;
      // O banco revalida o tipo e o grava no lote; a confirmação revalida de novo.
      if (tipoLote) argsExportar.p_tipo_cobranca = tipoLote;
      const { data: exp, error: erroExp } = await supabase.rpc("acoes_massivas_exportar", argsExportar);
      if (erroExp) throw erroExp;

      const excluidosEnvio = Number(exp?.excluidos_confirmacao || 0);
      const excluidosPrime = Number(exp?.excluidos_liquidados_prime || 0);
      const excluidosOutroOperador = Number(exp?.excluidos_outro_operador || 0);
      const excluidosJaAcionados = Number(exp?.excluidos_ja_acionados || 0);
      const excluidosTipo = Number(exp?.excluidos_tipo_cobranca || 0);
      setExcluidosNoEnvio(excluidosEnvio);

      // Os contatos completos só vêm desta RPC (gestão, auditada pelo lote); a
      // prévia nunca os expõe.
      const contatos = exp?.contatos || [];
      if (contatos.length > 0) {
        const linhas = contatos.map((c) => {
          const telFmt = normalizarTelefone(c.telefone);
          return canal === "WHATSAPP"
            ? { "Nome do aluno": c.nome, Telefone: telFmt }
            : { "Nome do aluno": c.nome, "E-mail": (c.email || "").trim(), Telefone: telFmt || "" };
        });
        const relGerado = { linhas, nomeArquivo };
        setRelatorioPronto(relGerado);
        try {
          baixarPlanilha(relGerado);
        } catch (e) {
          console.warn("Download automático falhou; use o botão Baixar planilha.", e);
        }
      }

      const sufixoExcluidos = (excluidosEnvio > 0
        ? ` ${excluidosEnvio} caso(s) ficaram fora por entrarem em confirmação de pagamento.`
        : "")
        + (excluidosPrime > 0
        ? ` ${excluidosPrime} caso(s) foram removidos por já constarem liquidados no Prime.`
        : "")
        + (excluidosOutroOperador > 0
        ? ` ${excluidosOutroOperador} caso(s) foram removidos por não estarem mais na carteira do operador selecionado.`
        : "")
        + (excluidosJaAcionados > 0
        ? ` ${excluidosJaAcionados} caso(s) ficaram fora por já terem sido acionados por operador.`
        : "")
        + (excluidosTipo > 0
        ? ` ${excluidosTipo} caso(s) ficaram fora por não corresponderem mais ao tipo de cobrança.`
        : "");

      if (contatos.length === 0) {
        setSucesso(`Nenhum aluno na planilha.${sufixoExcluidos}`);
      } else {
        setSucesso(
          `Planilha exportada com ${contatos.length} aluno(s). Nada foi registrado nos alunos: tabulação, retorno, fidelização e acionamento só mudam quando você confirmar a ação realizada, depois que o disparo na ferramenta externa terminar. Se o download não abriu, use o botão “Baixar planilha novamente” abaixo.${sufixoExcluidos}`
        );
      }
      carregarLotesPendentes();
    } catch (e) {
      console.error("Erro ao exportar planilha da ação massiva:", e);
      setErro("Erro ao exportar planilha: " + (e.message || "tente novamente"));
    } finally {
      setGerando(false);
    }
  }

  // CONFIRMAR AÇÃO REALIZADA (ou DESCARTAR lote não enviado). Só aqui o aluno
  // passa a contar como acionado: o banco revalida e grava tabulação, retorno e
  // movimentação pelo registro de sempre. Um lote confirma uma vez só.
  async function concluirLote(lote, acao) {
    setConcluindoLote(true);
    setErro("");
    setSucesso("");
    try {
      const { data: res, error } = await supabase.rpc("acoes_massivas_concluir_lote", {
        p_lote_id: lote.id,
        p_acao: acao,
      });
      if (error) throw error;
      if (acao === "DESCARTAR") {
        setSucesso(`Lote ${lote.arquivo || ""} descartado. Nada foi registrado nos alunos.`);
      } else {
        const registrados = Number(res?.registrados || 0);
        const jaListados = ["confirmacao_pendente", "liquidado_prime", "outro_responsavel", "fora_tipo_cobranca"];
        const outrosMotivos = Object.entries(res?.excluidos_por_motivo || {})
          .filter(([codigo]) => !jaListados.includes(codigo))
          .map(([codigo, n]) => [Number(n || 0), `estavam indisponíveis (${rotuloMotivo(codigo).toLowerCase()})`]);
        const partes = [
          [Number(res?.excluidos_acionados_apos_exportacao || 0), "foram acionados depois da exportação e mantiveram o contato mais novo"],
          [Number(res?.excluidos_confirmacao || 0), "entraram em confirmação de pagamento"],
          [Number(res?.excluidos_liquidados_prime || 0), "já constam liquidados no Prime"],
          [Number(res?.excluidos_outro_operador || 0), "não estão mais na carteira do operador do lote"],
          [Number(res?.excluidos_tipo_cobranca || 0), "não correspondem mais ao tipo de cobrança do lote"],
          ...outrosMotivos,
        ].filter(([n]) => n > 0).map(([n, t]) => ` ${n} caso(s) ${t} e não foram registrados.`).join("");
        setSucesso(
          `Ação confirmada: ${registrados} aluno(s) registrados como ação massiva e contados na cobertura. Responsável, fidelização e retorno dos alunos não foram alterados.${partes}`
        );
        carregarPorDia();
      }
    } catch (e) {
      console.error("Erro ao concluir lote da ação massiva:", e);
      setErro("Erro ao concluir o lote: " + (e.message || "tente novamente"));
    } finally {
      setAcaoLote(null);
      setConcluindoLote(false);
      carregarLotesPendentes();
    }
  }

  // Filtros de população/operação enviados ao painel de cobertura (o painel
  // ignora 'ano'). Mesmas chaves que o banco lê em acoes_massivas_universo.
  const filtrosCobertura = {
    unidade: unidadesSel.join("|") || null,
    curso: curso || null,
    situacao_academica: situacoesAcadSel.join("|") || null,
    matricula: matricula || null,
    importacao_ids: borderosSel.length ? borderosSel : null,
    operador: operadorEmail,
    tipo_cobranca: tipoCobranca || null,
    canal,
    sem_telefone: canal === "EMAIL" && soSemTelefone,
    valor_min: converterValor(valorMin) ?? 0,
    valor_max: valorMax.trim() ? converterValor(valorMax) : null,
    recencia_dias: Math.max(0, Math.min(60, Number.parseInt(recenciaDias, 10) || 0)),
  };

  const valorTotal = resultados ? resultados.reduce((s, r) => s + r.valor, 0) : 0;

  // Transporta os filtros do painel de penetração para a prévia oficial e
  // recalcula. NÃO congela lista, NÃO cria/agenda/envia campanha — a prévia
  // reavalia toda a elegibilidade (confirmação, saldo, quitados, jurídico, etc.).
  function usarComoFiltroDaPenetracao({ ano, unidade: uni, curso: cur }) {
    const anoStr = ano ? String(ano) : "";
    setAnoVencimento(anoStr);
    setUnidadesSel(uni ? [uni] : []);
    setCurso(cur || "");
    setAcionamentoFiltro("NUNCA");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    buscar({ ano: anoStr, unidades: uni ? [uni] : [], curso: cur || "", acionamento: "NUNCA" });
  }

  // Nomes explícitos dos cartões da prévia: a disponibilidade sempre considera o canal.
  const rotuloCanalPrevia = String(resumoPrevia?.filtros?.canal || canal || "").toUpperCase() === "EMAIL" ? "E-mail" : "WhatsApp";
  const nomeDispPrevia = `Disponíveis para ${rotuloCanalPrevia}`;
  const nomeIndispPrevia = `Indisponíveis para ${rotuloCanalPrevia}`;

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <div>
          <h1 style={estilos.titulo}>⚡ Ações Massivas</h1>
          <p style={estilos.subtitulo}>
            Estimula por fora (fora do CRM) alunos com dívida ativa — da carteira livre, de um operador ou de
            todos. Prioriza quem ainda não foi acionado no mês, depois quem está há mais tempo sem contato.
            A ação nunca altera o responsável do aluno.
          </p>
        </div>
        <BotaoAtualizar carregando={carregandoPainel} ultimaEm={painelEm} onClick={atualizarPainel} rotulo="Atualizar painel" />
      </div>

      <div style={estilos.abas}>
        <button
          style={canal === "WHATSAPP" ? estilos.abaAtiva : estilos.aba}
          onClick={() => {
            setCanal("WHATSAPP");
            setResultados(null);
          }}
        >
          📱 WhatsApp
        </button>
        <button
          style={canal === "EMAIL" ? estilos.abaAtiva : estilos.aba}
          onClick={() => {
            setCanal("EMAIL");
            setResultados(null);
          }}
        >
          📧 E-mail
        </button>
      </div>
      {canal === "EMAIL" && (
        <p style={{ ...estilos.subtitulo, marginBottom: 14, marginTop: -8 }}>
          Pra tratar quem não tem telefone cadastrado, mas tem e-mail.
        </p>
      )}

      <PenetracaoPorAno
        opcoesUnidade={opcoesUnidade}
        opcoesCurso={opcoesCurso}
        onUsarComoFiltro={usarComoFiltroDaPenetracao}
        filtrosCobertura={filtrosCobertura}
      />

      {saude && (saude.sem_valor > 0 || saude.sem_telefone > 0) && (
        <div style={{ ...estilos.card, background: "var(--rv-ambar-fundo)", borderColor: "var(--rv-ambar-borda)" }}>
          <strong style={{ fontFamily: FONTE_TITULO, fontSize: 14, display: "block", marginBottom: 6 }}>
            ⚠️ Casos fora do alcance das Ações Massivas
          </strong>
          <p style={{ margin: 0, fontSize: 13, color: "var(--rv-ambar-texto)" }}>
            <strong>{saude.sem_valor}</strong> livres sem valor calculado e{" "}
            <strong>{saude.sem_telefone}</strong> sem telefone cadastrado — esses não entram em nenhuma
            remessa automática. Precisam de conferência manual em{" "}
            <a href="/financeiro-hub" style={{ color: "var(--rv-ambar-texto)", fontWeight: 700 }}>Confirmação de Pagamento</a>.
          </p>
        </div>
      )}

      {retornos && retornos.envios_avaliados > 0 && (
        <div style={estilos.card}>
          <h3 style={{ margin: "0 0 4px", fontFamily: FONTE_TITULO, fontSize: 15, fontWeight: 800 }}>
            Retorno das ações — conversão em até {retornos.janela_dias} dias
          </h3>
          <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--rv-texto-fraco)" }}>
            "Retorno" = houve tabulação operacional no aluno após o envio. Considera só envios cuja janela de {retornos.janela_dias} dias já fechou.
          </p>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <div style={estilos.miniCard}><div style={estilos.miniVal}>{Number(retornos.envios_avaliados || 0).toLocaleString("pt-BR")}</div><div style={estilos.miniRot}>Enviados (avaliados)</div></div>
            <div style={estilos.miniCard}><div style={estilos.miniVal}>{Number(retornos.com_retorno || 0).toLocaleString("pt-BR")}</div><div style={estilos.miniRot}>Com retorno</div></div>
            <div style={{ ...estilos.miniCard, background: "var(--rv-roxo-fundo)", borderColor: "var(--rv-roxo-borda)" }}><div style={{ ...estilos.miniVal, color: "var(--rv-azul-texto)" }}>{(retornos.taxa_conversao ?? 0)}%</div><div style={estilos.miniRot}>Taxa de conversão</div></div>
          </div>
          {(retornos.por_canal || []).length > 0 && (
            <table style={{ ...estilos.tabela, marginTop: 14 }}>
              <thead><tr><th style={estilos.th}>Canal</th><th style={estilos.thNum}>Avaliados</th><th style={estilos.thNum}>Com retorno</th><th style={estilos.thNum}>Taxa</th></tr></thead>
              <tbody>
                {retornos.por_canal.map((c) => (
                  <tr key={c.canal}>
                    <td style={estilos.td}>{c.canal}</td>
                    <td style={estilos.tdNum}>{Number(c.avaliados || 0).toLocaleString("pt-BR")}</td>
                    <td style={estilos.tdNum}>{Number(c.com_retorno || 0).toLocaleString("pt-BR")}</td>
                    <td style={estilos.tdNum}>{(c.taxa ?? 0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {porDia.length > 0 && (
        <div style={estilos.card}>
          <h3 style={{ margin: "0 0 12px", fontFamily: FONTE_TITULO, fontSize: 15, fontWeight: 800 }}>
            Ações enviadas por dia
          </h3>
          <div style={{ overflowX: "auto", maxHeight: 260, overflowY: "auto" }}>
            <table style={estilos.tabela}>
              <thead>
                <tr>
                  <th style={estilos.th}>Dia</th>
                  <th style={estilos.thNum}>📱 WhatsApp</th>
                  <th style={estilos.thNum}>📧 E-mail</th>
                  <th style={estilos.thNum}>Total</th>
                </tr>
              </thead>
              <tbody>
                {porDia.map((d) => (
                  <tr key={d.dia}>
                    <td style={estilos.td}>{new Date(d.dia + "T00:00:00").toLocaleDateString("pt-BR")}</td>
                    <td style={estilos.tdNum}>{d.whatsapp}</td>
                    <td style={estilos.tdNum}>{d.email}</td>
                    <td style={{ ...estilos.tdNum, fontWeight: 800 }}>{d.whatsapp + d.email}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={estilos.card}>
        <div style={estilos.linhaFiltros}>
          <div style={{ ...estilos.campo, minWidth: 240 }}>
            <label style={estilos.label} htmlFor="filtro-operador-responsavel">Operador responsável</label>
            <select
              id="filtro-operador-responsavel"
              style={estilos.input}
              value={operadorEmail}
              // Trocar no meio da busca ou da geração deixaria a lista de um
              // operador à mostra com outro escolhido.
              disabled={carregando || gerando}
              onChange={(e) => {
                setOperadorEmail(e.target.value);
                limparPrevia();
              }}
            >
              <option value="LIVRES">Sem responsável / livres</option>
              <option value="TODOS">Todos os operadores</option>
              {opcoesOperador.map((o) => (
                <option key={o.email} value={o.email}>{o.nome} ({o.email})</option>
              ))}
            </select>
            {operadorEmail.includes("@") && (
              <span style={estilos.ajudaCampo}>
                Só alunos da carteira atual de {nomeDoOperador(operadorEmail)}. O filtro “Sem acionamento há”
                continua opcional e não é aplicado sozinho. Exportar a planilha não muda nada no aluno.
              </span>
            )}
          </div>
          <div style={{ ...estilos.campo, minWidth: 220 }}>
            <label style={estilos.label} htmlFor="filtro-tipo-cobranca">Tipo de cobrança</label>
            <select
              id="filtro-tipo-cobranca"
              style={estilos.input}
              value={tipoCobranca}
              disabled={carregando || gerando}
              onChange={(e) => {
                setTipoCobranca(e.target.value);
                limparPrevia();
              }}
            >
              <option value="" disabled>Selecione o tipo de cobrança</option>
              {TIPOS_COBRANCA.map((t) => (
                <option key={t.valor} value={t.valor}>{t.rotulo}</option>
              ))}
            </select>
            {AJUDA_TIPO_COBRANCA[tipoCobranca] && (
              <span style={estilos.ajudaCampo}>{AJUDA_TIPO_COBRANCA[tipoCobranca]}</span>
            )}
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label} htmlFor="filtro-valor-min">Valor mínimo (R$)</label>
            <input
              id="filtro-valor-min"
              style={estilos.input}
              placeholder="Ex: 500,00"
              value={valorMin}
              onChange={(e) => setValorMin(e.target.value)}
            />
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label}>Valor máximo (R$, opcional)</label>
            <input
              style={estilos.input}
              placeholder="Ex: 3000,00"
              value={valorMax}
              onChange={(e) => setValorMax(e.target.value)}
            />
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label}>Quantidade</label>
            <input
              style={estilos.input}
              type="number"
              min="1"
              max="5000"
              value={quantidade}
              onChange={(e) => setQuantidade(e.target.value)}
            />
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label}>Ano de vencimento da parcela</label>
            <select
              style={estilos.input}
              value={anoVencimento}
              onChange={(e) => setAnoVencimento(e.target.value)}
            >
              <option value="">Todos os anos</option>
              <option value="2023">2023</option>
              <option value="2024">2024</option>
              <option value="2025">2025</option>
              <option value="2026">2026</option>
            </select>
          </div>
          <div style={{ ...estilos.campo, minWidth: 260 }}>
            <label style={estilos.label}>
              Unidades{unidadesSel.length ? ` · ${unidadesSel.length} selec.` : " · todas"}
            </label>
            <div style={estilos.caixaBordero}>
              {opcoesUnidade.map((u) => {
                const marcado = unidadesSel.includes(u);
                return (
                  <label key={u} style={estilos.itemBordero} title={u}>
                    <input
                      type="checkbox"
                      checked={marcado}
                      onChange={() =>
                        setUnidadesSel((prev) =>
                          prev.includes(u) ? prev.filter((x) => x !== u) : [...prev, u]
                        )
                      }
                    />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {u}
                    </span>
                  </label>
                );
              })}
            </div>
            {unidadesSel.length > 0 && (
              <button type="button" onClick={() => setUnidadesSel([])} style={estilos.limparBordero}>
                limpar unidades
              </button>
            )}
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label}>Matrícula no semestre</label>
            <select
              style={estilos.input}
              value={matricula}
              onChange={(e) => setMatricula(e.target.value)}
            >
              <option value="">Tanto faz</option>
              <option value="NAO_CONFIRMADA">Não confirmada (não matriculou)</option>
              <option value="CONFIRMADA">Confirmada</option>
            </select>
          </div>
          {opcoesBordero.length > 0 && (
            <div style={{ ...estilos.campo, minWidth: 260 }}>
              <label style={estilos.label}>
                Carteira (borderô){borderosSel.length ? ` · ${borderosSel.length} selec.` : ""}
              </label>
              <div style={estilos.caixaBordero}>
                {opcoesBordero.map((b) => {
                  const marcado = borderosSel.includes(b.importacao_id);
                  return (
                    <label key={b.importacao_id} style={estilos.itemBordero} title={b.arquivo_nome}>
                      <input
                        type="checkbox"
                        checked={marcado}
                        onChange={() => {
                          setBorderosSel((prev) => {
                            const proximo = prev.includes(b.importacao_id)
                              ? prev.filter((id) => id !== b.importacao_id)
                              : [...prev, b.importacao_id];
                            // Carteira nova = ninguém foi acionado; não faz sentido
                            // travar por "já acionado". Solta o filtro de acionamento.
                            if (proximo.length) setAcionamentoFiltro("TODOS");
                            return proximo;
                          });
                        }}
                      />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {(b.arquivo_nome || "Borderô").replace(/\.xlsx?$/i, "")}
                        <span style={{ color: "var(--rv-texto-fraco)" }}> · {b.qtd_alunos} al.</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {borderosSel.length > 0 && (
                <button
                  type="button"
                  onClick={() => setBorderosSel([])}
                  style={estilos.limparBordero}
                >
                  Limpar carteira
                </button>
              )}
            </div>
          )}
          <div style={estilos.campo}>
            <label style={estilos.label}>Modalidade (curso)</label>
            <select
              style={estilos.input}
              value={curso}
              onChange={(e) => setCurso(e.target.value)}
            >
              <option value="">Todas as modalidades</option>
              {opcoesCurso.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div style={{ ...estilos.campo, minWidth: 260 }}>
            <label style={estilos.label}>
              Status acadêmico{situacoesAcadSel.length ? ` · ${situacoesAcadSel.length} selec.` : " · todas as situações"}
            </label>
            <div style={estilos.caixaBordero}>
              {opcoesSituacaoAcad.map((s) => {
                const marcado = situacoesAcadSel.includes(s);
                return (
                  <label key={s} style={estilos.itemBordero} title={s}>
                    <input
                      type="checkbox"
                      checked={marcado}
                      onChange={() =>
                        setSituacoesAcadSel((prev) =>
                          prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
                        )
                      }
                    />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s}
                    </span>
                  </label>
                );
              })}
            </div>
            {situacoesAcadSel.length > 0 && (
              <button type="button" onClick={() => setSituacoesAcadSel([])} style={estilos.limparBordero}>
                limpar status
              </button>
            )}
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label}>Sem acionamento há (mín.)</label>
            <select
              style={estilos.input}
              value={
                diasPersonalizado
                  ? "custom"
                  : (PRESETS_DIAS_SEM_ACIONAMENTO.includes(String(diasMinimoSemContato))
                      ? String(diasMinimoSemContato)
                      : (diasMinimoSemContato ? "custom" : ""))
              }
              onChange={(e) => {
                const v = e.target.value;
                if (v === "custom") {
                  setDiasPersonalizado(true);
                } else {
                  setDiasPersonalizado(false);
                  setDiasMinimoSemContato(v);
                }
              }}
            >
              <option value="">Qualquer período</option>
              <option value="7">Acima de 7 dias</option>
              <option value="12">Acima de 12 dias</option>
              <option value="15">Acima de 15 dias</option>
              <option value="21">Acima de 21 dias</option>
              <option value="30">Acima de 30 dias</option>
              <option value="45">Acima de 45 dias</option>
              <option value="60">Acima de 60 dias</option>
              <option value="90">Acima de 90 dias</option>
              <option value="custom">Personalizado…</option>
            </select>
            {diasPersonalizado && (
              <input
                style={{ ...estilos.input, marginTop: 6 }}
                type="number"
                min="1"
                placeholder="Nº de dias (ex: 12)"
                value={diasMinimoSemContato}
                onChange={(e) => setDiasMinimoSemContato(e.target.value)}
              />
            )}
            <span style={{ fontSize: 11, color: "var(--rv-texto-fraco)", marginTop: 4 }}>
              Inclui quem nunca foi acionado. Use o filtro “Acionamento” para separar.
            </span>
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label} htmlFor="filtro-acionamento">Acionamento</label>
            <select
              id="filtro-acionamento"
              style={estilos.input}
              value={acionamentoFiltro}
              onChange={(e) => setAcionamentoFiltro(e.target.value)}
            >
              {OPCOES_ACIONAMENTO.map((o) => (
                <option key={o.valor} value={o.valor}>{o.rotulo}</option>
              ))}
            </select>
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label} htmlFor="filtro-recencia">Recência da ação massiva (dias, por canal)</label>
            <input
              id="filtro-recencia"
              style={estilos.input}
              type="number"
              min="0"
              max="60"
              value={recenciaDias}
              onChange={(e) => setRecenciaDias(e.target.value)}
            />
            <span style={estilos.ajudaCampo}>
              Não repete ação massiva no mesmo canal dentro deste prazo. Não cria retorno nem altera fidelização.
            </span>
          </div>

          {canal === "EMAIL" && (
            <div style={{ ...estilos.campo, justifyContent: "flex-end" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: "var(--rv-texto)", marginBottom: 9 }}>
                <input
                  type="checkbox"
                  checked={soSemTelefone}
                  onChange={(e) => setSoSemTelefone(e.target.checked)}
                />
                Só sem telefone
              </label>
            </div>
          )}
        </div>

        {erro && <p style={estilos.erro}>{erro}</p>}
        {sucesso && <p style={estilos.sucesso}>{sucesso}</p>}

        <button style={estilos.botaoBuscar} onClick={buscar} disabled={carregando}>
          {carregando ? "Buscando..." : "Buscar prévia"}
        </button>
      </div>

      {lotesPendentes.length > 0 && (
        <div style={estilos.card}>
          <h3 style={{ margin: "0 0 4px", fontFamily: FONTE_TITULO, fontSize: 15, fontWeight: 800 }}>
            Planilhas exportadas aguardando confirmação
          </h3>
          <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--rv-texto-fraco)" }}>
            Exportar não registra contato. Depois que o disparo na ferramenta externa terminar, confirme a
            ação realizada — só então os alunos contam como acionados. Se a planilha não foi enviada, descarte.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={estilos.tabela}>
              <thead>
                <tr>
                  <th style={estilos.th}>Planilha</th>
                  <th style={estilos.th}>Canal</th>
                  <th style={estilos.th}>Carteira</th>
                  <th style={estilos.th}>Tipo de cobrança</th>
                  <th style={estilos.thNum}>Alunos</th>
                  <th style={estilos.th}>Exportada</th>
                  <th style={estilos.th}></th>
                </tr>
              </thead>
              <tbody>
                {lotesPendentes.map((l) => (
                  <tr key={l.id}>
                    <td style={estilos.td}>{l.arquivo || "—"}</td>
                    <td style={estilos.td}>{l.canal === "EMAIL" ? "E-mail" : "WhatsApp"}</td>
                    <td style={estilos.td}>{l.operador_email ? (l.operador_nome || l.operador_email) : "Base livre"}</td>
                    <td style={estilos.td}>{rotuloTipoCobranca(l.tipo_cobranca)}</td>
                    <td style={estilos.tdNum}>{l.total}</td>
                    <td style={estilos.td}>
                      {new Date(l.exportado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                      <div style={{ color: "var(--rv-texto-fraco)", fontSize: 11 }}>{l.exportado_por_email}</div>
                    </td>
                    <td style={estilos.td}>
                      {acaoLote?.id === l.id ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 360 }}>
                          <span style={{ fontSize: 12, color: "var(--rv-texto)" }}>
                            {acaoLote.acao === "CONFIRMAR"
                              ? `Confirme só se o disparo já foi concluído. Os ${l.total} aluno(s) passam a contar como acionados na cobertura e ficam registrados no histórico do lote. Não altera responsável, não cria retorno e não renova fidelização. Quem foi acionado por um operador depois da exportação, ou deixou de estar disponível, fica de fora.`
                              : "Descartar: a planilha não foi enviada. Nada é registrado nos alunos."}
                          </span>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              style={estilos.botaoGerar}
                              disabled={concluindoLote}
                              onClick={() => concluirLote(l, acaoLote.acao)}
                            >
                              {acaoLote.acao === "CONFIRMAR" ? "Sim, o disparo foi concluído" : "Sim, descartar"}
                            </button>
                            <button style={estilos.botaoSecundario} disabled={concluindoLote} onClick={() => setAcaoLote(null)}>
                              Voltar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button style={estilos.botaoGerar} onClick={() => setAcaoLote({ id: l.id, acao: "CONFIRMAR" })}>
                            ✅ Confirmar ação realizada
                          </button>
                          <button style={estilos.botaoSecundario} onClick={() => setAcaoLote({ id: l.id, acao: "DESCARTAR" })}>
                            Descartar
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {resultados && excluidosConfirmacao.length > 0 && (
        <div style={{ ...estilos.card, background: "var(--rv-ambar-fundo)", borderColor: "var(--rv-ambar-borda)", marginBottom: 12 }}>
          <button
            onClick={() => setMostrarExcluidos((v) => !v)}
            style={{
              background: "none", border: "none", cursor: "pointer", padding: 0,
              display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
            }}
          >
            <span style={{ fontFamily: FONTE_TITULO, fontSize: 14, fontWeight: 800, color: "var(--rv-ambar-texto)" }}>
              🔒 Excluídos por confirmação de pagamento: {excluidosConfirmacao.length}
            </span>
            <span style={{ color: "var(--rv-ambar-texto)", fontSize: 12.5, fontWeight: 700 }}>
              {mostrarExcluidos ? "▲ ocultar" : "▼ ver relação"}
            </span>
          </button>
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--rv-ambar-texto)" }}>
            Casos aguardando confirmação financeira. Não entram como elegíveis, não recebem comunicação
            e não são contabilizados como envio.
          </p>
          {mostrarExcluidos && (
            <div style={{ overflowX: "auto", maxHeight: 260, overflowY: "auto", marginTop: 12 }}>
              <table style={estilos.tabela}>
                <thead>
                  <tr>
                    <th style={estilos.th}>Aluno (mascarado)</th>
                    <th style={estilos.th}>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {excluidosConfirmacao.map((e, i) => (
                    <tr key={i}>
                      <td style={estilos.td}>{e.aluno}</td>
                      <td style={estilos.td}>{e.motivo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {resultados && resumoPrevia && (
        <div style={estilos.card} data-testid="painel-previa">
          <h3 style={{ margin: "0 0 10px", fontFamily: FONTE_TITULO, fontSize: 15, fontWeight: 800 }}>
            Painel da prévia <span style={{ fontSize: 11, fontWeight: 800, color: "var(--rv-ambar-texto)", background: "var(--rv-ambar-fundo)", borderRadius: 6, padding: "1px 8px", marginLeft: 6 }}>PRÉVIA — nada foi enviado nem registrado</span>
          </h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
            <div style={estilos.miniCard}><div style={estilos.miniVal}>{Number(resumoPrevia.solicitado || 0).toLocaleString("pt-BR")}</div><div style={estilos.miniRot}>Solicitado</div></div>
            <div style={estilos.miniCard}><div style={estilos.miniVal}>{Number(resumoPrevia.universo_base || 0).toLocaleString("pt-BR")}</div><div style={estilos.miniRot} title="Base: alunos com dívida ativa dentro dos filtros de população">No universo (base)</div></div>
            <div style={estilos.miniCard}><div style={estilos.miniVal}>{Number(resumoPrevia.disponiveis || 0).toLocaleString("pt-BR")}</div><div style={estilos.miniRot} title="Podem entrar numa ação agora, considerando TODOS os filtros atuais, inclusive o canal">{nomeDispPrevia}</div></div>
            <div style={{ ...estilos.miniCard, background: "var(--rv-roxo-fundo)", borderColor: "var(--rv-roxo-borda)" }}><div style={{ ...estilos.miniVal, color: "var(--rv-azul-texto)" }}>{Number(resumoPrevia.selecionado || 0).toLocaleString("pt-BR")}</div><div style={estilos.miniRot}>Serão selecionados</div></div>
            <div style={estilos.miniCard}><div style={estilos.miniVal}>{Number(resumoPrevia.indisponiveis || 0).toLocaleString("pt-BR")}</div><div style={estilos.miniRot} title="Base menos disponíveis. O motivo de cada um está na lista abaixo">{nomeIndispPrevia}</div></div>
          </div>
          <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--rv-texto-fraco)" }} data-testid="legenda-disponibilidade-previa">
            “{nomeDispPrevia}” considera todos os filtros atuais, inclusive o canal: quem não tem contato válido para {rotuloCanalPrevia} aparece
            como indisponível (“Sem contato válido para o canal”). Trocar o canal muda estes números; a base não muda.
          </p>
          {resumoPrevia.menos_que_solicitado && (
            <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: "var(--rv-ambar-texto)" }} data-testid="menos-que-solicitado">
              Somente {Number(resumoPrevia.selecionado || 0)} disponíveis dentro dos filtros atuais (solicitado {Number(resumoPrevia.solicitado || 0)})
            </p>
          )}
          {Number(resumoPrevia.fora_do_filtro_acionamento || 0) > 0 && (
            <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--rv-texto-fraco)" }}>
              {Number(resumoPrevia.fora_do_filtro_acionamento)} disponível(is) ficaram fora pelo filtro de acionamento.
            </p>
          )}
          {Object.keys(resumoPrevia.motivos || {}).length > 0 && (
            <div style={{ marginBottom: 10 }} data-testid="motivos-previa">
              <div style={{ ...estilos.label, marginBottom: 4 }}>Indisponíveis por motivo</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--rv-texto)" }}>
                {Object.entries(resumoPrevia.motivos).map(([m, n]) => (
                  <li key={m}>{rotuloMotivo(m)}: <strong>{Number(n).toLocaleString("pt-BR")}</strong></li>
                ))}
              </ul>
            </div>
          )}
          <p style={{ margin: "0 0 6px", fontSize: 12.5, color: "var(--rv-texto)" }} data-testid="resp-fidelizacao">
            Entre os selecionados: <strong>{Number(resumoPrevia.com_responsavel || 0)}</strong> com responsável e{" "}
            <strong>{Number(resumoPrevia.com_fidelizacao_ativa || 0)}</strong> com fidelização ativa.
            A ação massiva <strong>não altera</strong> o responsável nem a fidelização.
          </p>
          {resumoPrevia.filtros && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--rv-texto-fraco)" }} data-testid="filtros-aplicados">
              Filtros aplicados: valor mínimo {formatarMoeda(resumoPrevia.filtros.valor_min)}
              {" "}· valor máximo {resumoPrevia.filtros.valor_max != null ? formatarMoeda(resumoPrevia.filtros.valor_max) : "sem limite"}
              {" "}· recência {resumoPrevia.filtros.recencia_dias} dia(s)
              {" "}· acionamento {ROTULO_ACIONAMENTO[resumoPrevia.filtros.acionamento] || resumoPrevia.filtros.acionamento}
              {resumoPrevia.filtros.canal ? <> · canal {resumoPrevia.filtros.canal}</> : null}
            </p>
          )}
        </div>
      )}

      {resultados && (
        <div style={estilos.card}>
          <div style={estilos.resumoTopo}>
            <div>
              <strong style={{ fontFamily: FONTE_TITULO, fontSize: 18 }}>{resultados.length}</strong>{" "}
              <span style={{ color: "var(--rv-texto-fraco)" }}>
                {operadorDaPrevia.includes("@")
                  ? `caso(s) da carteira de ${nomeDoOperador(operadorDaPrevia)}`
                  : `caso(s) — ${nomeDoOperador(operadorDaPrevia).toLowerCase()}`}{" "}
                com {canal === "WHATSAPP" ? "telefone" : "e-mail"}, prontos pra ação
              </span>
              {resultados.length > 0 && (
                <span style={{ color: "var(--rv-texto-fraco)" }}> · Total em aberto: {formatarMoeda(valorTotal)}</span>
              )}
              <div style={{ ...estilos.ajudaCampo, maxWidth: "none", fontSize: 12.5 }}>
                Operador filtrado: <strong>{nomeDoOperador(operadorDaPrevia)}</strong>
                {operadorDaPrevia.includes("@") ? <> ({operadorDaPrevia}) — só alunos com esse responsável atual.</> : null}
                {" "}· Tipo de cobrança: <strong>{rotuloTipoCobranca(tipoDaPrevia)}</strong>
              </div>
              {contagemTipo && (
                <div style={{ ...estilos.ajudaCampo, maxWidth: "none", fontSize: 12.5 }} data-testid="contagem-tipo">
                  Por tipo, após os filtros: Mensalidades <strong>{contagemTipo.mensalidades}</strong>
                  {" "}· Acordos vencidos <strong>{contagemTipo.acordos_vencidos}</strong>
                  {" "}· Total único <strong>{contagemTipo.total_unico}</strong>
                  {contagemTipo.mensalidades_e_acordos_vencidos > 0 && (
                    <> ({contagemTipo.mensalidades_e_acordos_vencidos} dos acordos vencidos também têm mensalidade)</>
                  )}
                </div>
              )}
              {primeExtratoEm && (
                <div style={{ color: "#8a93a3", fontSize: 12.5, marginTop: 4 }}>
                  Quem já consta liquidado no Prime não entra nesta lista. Extrato de{" "}
                  {new Date(`${primeExtratoEm}T12:00:00`).toLocaleDateString("pt-BR")} — quem pagou
                  depois disso só sai na próxima coleta.
                </div>
              )}
            </div>
            {resultados.length > 0 && (
              <button style={estilos.botaoGerar} onClick={exportarPlanilha} disabled={gerando}>
                {gerando ? "Exportando..." : "⬇️ Exportar planilha (não registra contato)"}
              </button>
            )}
          </div>

          {relatorioPronto && relatorioPronto.linhas?.length > 0 && (
            <div style={{ marginTop: 12, padding: "12px 14px", border: "1px solid #1e6b3a", borderRadius: 12, background: "#0e2318", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ color: "#bbf7d0", fontSize: 13 }}>
                Planilha de <strong>{relatorioPronto.linhas.length}</strong> aluno(s) pronta
                (<span style={{ color: "var(--rv-texto-fraco)" }}>{relatorioPronto.nomeArquivo}</span>).
                {" "}Se o download não abriu sozinho, clique aqui:
              </div>
              <button
                style={{ ...estilos.botaoGerar, background: "#16a34a" }}
                onClick={() => baixarPlanilha(relatorioPronto)}
              >
                ⬇️ Baixar planilha novamente
              </button>
            </div>
          )}


          {resultados.length === 0 ? (
            <p style={{ color: "var(--rv-texto-fraco)" }}>
              Nenhum caso com esses filtros. Veja no painel acima quantos ficaram indisponíveis e por quê.
            </p>
          ) : (
            <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
              <table style={estilos.tabela}>
                <thead>
                  <tr>
                    <th style={estilos.th}>Nome do aluno</th>
                    <th style={estilos.th}>Status acadêmico</th>
                    <th style={estilos.th}>{canal === "WHATSAPP" ? "Telefone (formatado)" : "E-mail"}</th>
                    {resultados.some((r) => r.temResponsavel) && <th style={estilos.th}>Responsável</th>}
                    <th style={estilos.thNum}>Sem contato há</th>
                    <th style={estilos.thNum}>Valor em aberto</th>
                  </tr>
                </thead>
                <tbody>
                  {resultados.map((r) => (
                    <tr key={r.alunoId}>
                      <td style={estilos.td}>{r.nome}</td>
                      <td style={estilos.td}>
                        {r.situacaoAcademica ? (
                          <span style={estiloStatusAcademico(r.situacaoAcademica)}>{r.situacaoAcademica}</span>
                        ) : (
                          <span style={{ color: "var(--rv-texto-fraco)" }}>—</span>
                        )}
                        {r.curso && <div style={{ color: "var(--rv-texto-fraco)", fontSize: 11, marginTop: 2 }}>{r.curso}</div>}
                      </td>
                      <td style={estilos.td}>{canal === "WHATSAPP" ? r.telefoneMascarado : (<>{r.emailMascarado}{r.semTelefone && <span style={{ marginLeft: 6, background: "var(--rv-vermelho-fundo)", color: "var(--rv-vermelho-texto)", borderRadius: 6, padding: "1px 6px", fontSize: 11, fontWeight: 800 }}>sem telefone</span>}</>)}</td>
                      {resultados.some((rr) => rr.temResponsavel) && (
                        <td style={estilos.td}>
                          {r.temResponsavel ? (
                            <>
                              {nomeDoOperador(r.responsavelEmail)}
                              {r.fidelizacaoAtiva && (
                                <span style={{ marginLeft: 6, background: "var(--rv-ambar-fundo)", color: "var(--rv-ambar-texto)", borderRadius: 6, padding: "1px 6px", fontSize: 11, fontWeight: 800 }}>
                                  fidelizado
                                </span>
                              )}
                            </>
                          ) : (
                            <span style={{ color: "var(--rv-texto-fraco)" }}>Livre</span>
                          )}
                        </td>
                      )}
                      <td style={estilos.tdNum}>
                        {r.diasSemContato === null ? (
                          <span style={{ color: "var(--rv-vermelho-texto)", fontWeight: 800 }}>Nunca acionado</span>
                        ) : (
                          `${r.diasSemContato} dia(s)`
                        )}
                      </td>
                      <td style={estilos.tdNum}>{formatarMoeda(r.valor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const estilos = {
  container: {
    padding: "28px 30px 40px",
    fontFamily: "'Inter', system-ui, sans-serif",
    background: "var(--rv-fundo, var(--rv-fundo))",
    minHeight: "100%",
  },
  cabecalho: { marginBottom: 18 },
  titulo: {
    margin: 0,
    color: "var(--rv-tinta)",
    fontFamily: FONTE_TITULO,
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: "-0.03em",
  },
  subtitulo: { margin: "5px 0 0", color: "var(--rv-texto-fraco)", fontSize: 13.5, maxWidth: 640 },
  abas: { display: "flex", gap: 8, marginBottom: 6 },
  aba: {
    background: "var(--rv-superficie)",
    border: "1px solid var(--rv-borda)",
    borderRadius: 10,
    padding: "9px 16px",
    fontSize: 13,
    fontWeight: 700,
    color: "var(--rv-texto)",
    cursor: "pointer",
  },
  abaAtiva: {
    background: "#1e40af",
    border: "1px solid #1e40af",
    borderRadius: 10,
    padding: "9px 16px",
    fontSize: 13,
    fontWeight: 800,
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(15,157,107,0.35)",
  },
  card: {
    background: "var(--rv-superficie)",
    borderRadius: 16,
    padding: "20px 22px",
    boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)",
    border: "1px solid var(--rv-borda-suave)",
    marginBottom: 18,
  },
  linhaFiltros: { display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 },
  campo: { display: "flex", flexDirection: "column", gap: 5, minWidth: 160 },
  label: { fontSize: 12, fontWeight: 700, color: "var(--rv-texto)" },
  ajudaCampo: { fontSize: 11, color: "var(--rv-texto-fraco)", marginTop: 4, maxWidth: 420 },
  input: {
    padding: "9px 12px",
    borderRadius: 10,
    border: "1px solid var(--rv-borda)",
    fontSize: 13,
    // o CSS global de <input> é escuro (legado); sem isto o campo destoa dos seletores da tela
    background: "var(--rv-superficie)",
    color: "var(--rv-texto)",
  },
  caixaBordero: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    maxHeight: 120,
    overflowY: "auto",
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid var(--rv-borda)",
    background: "var(--rv-superficie)",
  },
  itemBordero: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    cursor: "pointer",
    maxWidth: 240,
  },
  limparBordero: {
    marginTop: 4,
    alignSelf: "flex-start",
    background: "none",
    border: "none",
    color: "var(--rv-vermelho-texto)",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    padding: 0,
  },
  erro: { color: "var(--rv-vermelho-texto)", fontSize: 13, marginBottom: 10 },
  sucesso: { color: "var(--rv-verde-ok-texto)", fontSize: 13, marginBottom: 10, fontWeight: 700 },
  botaoBuscar: {
    background: VERDE,
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 20px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },
  resumoTopo: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 14,
  },
  botaoGerar: {
    background: "#0d1321",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 18px",
    fontWeight: 800,
    fontSize: 13,
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(0,0,0,0.2)",
  },
  botaoSecundario: {
    background: "var(--rv-superficie)",
    color: "var(--rv-texto)",
    border: "1px solid var(--rv-borda)",
    borderRadius: 10,
    padding: "9px 14px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    color: "var(--rv-texto-fraco)",
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    background: "var(--rv-fundo-cartao)",
    borderBottom: "1px solid var(--rv-borda)",
    position: "sticky",
    top: 0,
  },
  thNum: {
    textAlign: "right",
    padding: "10px 12px",
    color: "var(--rv-texto-fraco)",
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    background: "var(--rv-fundo-cartao)",
    borderBottom: "1px solid var(--rv-borda)",
    position: "sticky",
    top: 0,
  },
  td: { padding: "10px 12px", borderBottom: "1px solid var(--rv-borda-suave)", color: "var(--rv-texto-forte)" },
  tdNum: { padding: "10px 12px", borderBottom: "1px solid var(--rv-borda-suave)", textAlign: "right", fontWeight: 700, color: "var(--rv-tinta)" },
  miniCard: { background: "var(--rv-fundo-cartao)", border: "1px solid var(--rv-borda-suave)", borderRadius: 12, padding: "12px 16px", minWidth: 150 },
  miniVal: { fontSize: 26, fontWeight: 800, color: "var(--rv-tinta)" },
  miniRot: { fontSize: 12, color: "var(--rv-texto-fraco)", fontWeight: 600, marginTop: 2 },
};
