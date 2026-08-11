import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";
import BotaoAtualizar from "../components/BotaoAtualizar";
import PenetracaoPorAno from "../components/PenetracaoPorAno";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const VERDE = "#1e40af";
// Presets do seletor "Sem acionamento há (mín.)" — valor = nº de dias.
const PRESETS_DIAS_SEM_ACIONAMENTO = ["7", "12", "15", "21", "30", "45", "60", "90"];

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
    return { ...base, background: "#fee2e2", color: "#b91c1c" };
  // Aguardando matrícula / trancado → âmbar (pendência acadêmica)
  if (/(aguardando|trancad|trancamento|reabertura|isen|certid)/.test(s))
    return { ...base, background: "#fef3c7", color: "#92400e" };
  // Matriculado / normal → verde
  if (/(matriculad|normal|ativo|curr[ií]cul)/.test(s))
    return { ...base, background: "#dcfce7", color: "#166534" };
  // Demais → cinza neutro
  return { ...base, background: "#eef1f6", color: "#475569" };
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
  const [valorMin, setValorMin] = useState("100,00");
  const [valorMax, setValorMax] = useState("");
  const [quantidade, setQuantidade] = useState("100");
  const [anoVencimento, setAnoVencimento] = useState("");
  const [unidade, setUnidade] = useState("");
  const [curso, setCurso] = useState("");
  const [situacaoAcad, setSituacaoAcad] = useState("");
  const [opcoesUnidade, setOpcoesUnidade] = useState([]);
  const [opcoesCurso, setOpcoesCurso] = useState([]);
  const [opcoesSituacaoAcad, setOpcoesSituacaoAcad] = useState([]);
  // Carteiras importadas (borderôs). borderosSel = ids selecionados no filtro.
  const [opcoesBordero, setOpcoesBordero] = useState([]);
  const [borderosSel, setBorderosSel] = useState([]);
  const [diasMinimoSemContato, setDiasMinimoSemContato] = useState("");
  const [diasPersonalizado, setDiasPersonalizado] = useState(false);
  // "todos" | "nunca" (nunca acionados) | "ja" (já acionados)
  const [acionamentoFiltro, setAcionamentoFiltro] = useState("todos");
  const [soSemTelefone, setSoSemTelefone] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [gerando, setGerando] = useState(false);
  const [resultados, setResultados] = useState(null);
  const [erro, setErro] = useState("");
  const [sucesso, setSucesso] = useState("");
  const [progresso, setProgresso] = useState(null);
  const [porDia, setPorDia] = useState([]);
  const [saude, setSaude] = useState(null);
  const [retornos, setRetornos] = useState(null);
  // REGRA ABSOLUTA: casos em confirmação de pagamento nunca entram. A prévia os
  // devolve à parte (lista mascarada) só para transparência — eles não são elegíveis.
  const [excluidosConfirmacao, setExcluidosConfirmacao] = useState([]);
  const [mostrarExcluidos, setMostrarExcluidos] = useState(false);
  const [excluidosNoEnvio, setExcluidosNoEnvio] = useState(0);
  // Guarda o último relatório gerado p/ permitir baixar manualmente caso o
  // download automático seja bloqueado pelo navegador (perda de "user gesture"
  // após os awaits do registrar — comum no Safari).
  const [relatorioPronto, setRelatorioPronto] = useState(null); // { linhas, nomeArquivo }

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
      await Promise.all([carregarProgresso(), carregarPorDia(), carregarSaude(), carregarRetornos()]);
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
      const { data: bords } = await supabase.rpc("acoes_massivas_borderos");
      setOpcoesBordero(bords || []);
    })();
  }, []);

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

  async function carregarProgresso() {
    const { data } = await supabase.rpc("total_elegiveis_acoes_massivas", { p_canal: canal });
    setProgresso(data);
  }

  async function buscar(over = {}) {
    setErro("");
    setSucesso("");
    const min = valorMin.trim() ? converterValor(valorMin) : null;
    const max = valorMax.trim() ? converterValor(valorMax) : null;
    const qtd = Math.max(1, Math.min(5000, Number(quantidade) || 100));

    if (valorMin.trim() && min === null) {
      setErro("Valor mínimo inválido.");
      return;
    }
    if (valorMax.trim() && max === null) {
      setErro("Valor máximo inválido.");
      return;
    }

    // Regra fixa: nunca gera ação pra caso com valor em aberto abaixo de
    // R$100 -- mesmo que o campo fique em branco ou alguém digite menos.
    const minEfetivo = Math.max(min ?? 0, 100);

    setCarregando(true);
    setResultados(null);
    setExcluidosConfirmacao([]);
    setMostrarExcluidos(false);
    setExcluidosNoEnvio(0);

    try {
      // Busca a prévia direto no banco (funcao SQL, ja traz o valor junto),
      // evitando montar uma lista gigante de IDs na URL da requisicao.
      //
      // A prévia já separa, no backend, os casos em CONFIRMAÇÃO DE PAGAMENTO:
      // eles vêm em `excluidos_confirmacao` (mascarados) e NUNCA em `elegiveis`.
      const { data: previa, error: erroAlunos } = await supabase.rpc(
        "acoes_massivas_previa",
        {
          p_ano_vencimento: (over.ano ?? anoVencimento) || null,
          p_limite: Math.min(qtd * 3, 6000),
          p_dias_minimo_sem_contato: diasMinimoSemContato ? Number(diasMinimoSemContato) : null,
          p_apenas_nunca_acionado: (over.acionamento ?? acionamentoFiltro) === "nunca",
          p_apenas_ja_acionado: (over.acionamento ?? acionamentoFiltro) === "ja",
          p_unidade: (over.unidade ?? unidade) || null,
          p_curso: (over.curso ?? curso) || null,
          p_situacao_academica: (over.situacaoAcad ?? situacaoAcad) || null,
          p_importacao_ids: (over.borderosSel ?? borderosSel).length
            ? (over.borderosSel ?? borderosSel)
            : null,
        }
      );
      if (erroAlunos) throw erroAlunos;

      setExcluidosConfirmacao(previa?.excluidos_confirmacao || []);

      const alunosBrutos = previa?.elegiveis || [];
      if (alunosBrutos.length === 0) {
        setResultados([]);
        setCarregando(false);
        return;
      }

      // A prévia NÃO retorna telefone/e-mail completos (anti-enumeração): vêm
      // mascarados só pra exibição + flags tem_telefone/tem_email pra filtrar.
      // Os contatos reais só são devolvidos por registrar_acao_massiva (gestão).
      let lista = (alunosBrutos || [])
        .map((a) => ({
          alunoId: a.id,
          nome: a.nome || "-",                       // já mascarado no backend (ex.: "Ana ***")
          situacaoAcademica: a.situacao_academica || null,
          curso: a.curso || null,
          telefoneMascarado: a.telefone_mascarado || "",
          emailMascarado: a.email_mascarado || "",
          temTelefone: !!a.tem_telefone,
          temEmail: !!a.tem_email,
          semTelefone: !a.tem_telefone,
          valor: Number(a.valor || 0),
          diasSemContato: a.data_ultimo_acionamento
            ? Math.floor((Date.now() - new Date(a.data_ultimo_acionamento).getTime()) / 86400000)
            : null,
        }))
        .filter((l) => (canal === "WHATSAPP" ? l.temTelefone : l.temEmail)) // precisa do contato certo pro canal escolhido
        .filter((l) => l.valor >= minEfetivo)
        .filter((l) => (max === null ? true : l.valor <= max));

      if (canal === "EMAIL") {
        if (soSemTelefone) lista = lista.filter((l) => l.semTelefone);
        // Sem telefone = prioridade no e-mail (nao da pra alcancar por WhatsApp)
        lista = lista.slice().sort((a, b) => (b.semTelefone ? 1 : 0) - (a.semTelefone ? 1 : 0));
      }

      lista = lista.slice(0, qtd);
      setResultados(lista);
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

  async function gerarEregistrar() {
    if (!resultados || resultados.length === 0) return;

    setGerando(true);
    setErro("");
    setSucesso("");
    setExcluidosNoEnvio(0);

    try {
      const { data: userData } = await supabase.auth.getUser();
      const email = userData?.user?.email || "";
      const { data: perfil } = await supabase
        .from("usuarios")
        .select("nome")
        .eq("email", email)
        .maybeSingle();
      const nomeUsuario = perfil?.nome || email;

      const nomeArquivo = `acao-massiva-${canal.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.xlsx`;

      // 1) REVALIDA E REGISTRA no backend (fonte única de verdade). A RPC
      // recheca, aluno por aluno, se entrou em CONFIRMAÇÃO DE PAGAMENTO depois
      // da prévia; quem entrou é removido aqui — sem update, sem movimentação,
      // sem perder operador, sem contar como envio. Devolve só os ids que
      // realmente foram registrados.
      const { data: reg, error: erroReg } = await supabase.rpc("registrar_acao_massiva", {
        p_aluno_ids: resultados.map((r) => String(r.alunoId)),
        p_canal: canal,
        p_arquivo: nomeArquivo,
        p_registrado_por_nome: nomeUsuario,
        p_registrado_por_email: email,
      });
      if (erroReg) throw erroReg;

      const excluidosEnvio = Number(reg?.excluidos_confirmacao || 0);
      setExcluidosNoEnvio(excluidosEnvio);

      // 2) Gera o Excel APENAS com quem passou na revalidação. Os contatos
      // completos (nome/telefone/e-mail) vêm exclusivamente de registrar_acao_massiva
      // (backend gestão-gated e auditado) — a prévia nunca os expõe. Casos que
      // entraram em confirmação depois da prévia não aparecem aqui.
      const contatos = reg?.contatos || [];

      let relGerado = null;
      if (contatos.length > 0) {
        const linhas = contatos.map((c) => {
          const telFmt = normalizarTelefone(c.telefone);
          return canal === "WHATSAPP"
            ? { "Nome do aluno": c.nome, Telefone: telFmt }
            : { "Nome do aluno": c.nome, "E-mail": (c.email || "").trim(), Telefone: telFmt || "" };
        });
        relGerado = { linhas, nomeArquivo };
        // Guarda para o botão manual de fallback (caso o auto-download seja
        // bloqueado, a planilha não se perde: os alunos já foram registrados).
        setRelatorioPronto(relGerado);
        try {
          baixarPlanilha(relGerado);
        } catch (e) {
          console.warn("Download automático falhou; use o botão Baixar planilha.", e);
        }
      }
      const registrados = contatos;

      const retorno = new Date();
      retorno.setDate(retorno.getDate() + 10);
      const sufixoExcluidos = excluidosEnvio > 0
        ? ` ${excluidosEnvio} caso(s) foram removidos na revalidação por entrarem em confirmação de pagamento.`
        : "";

      if (registrados.length === 0) {
        setSucesso(`Nenhum caso registrado.${sufixoExcluidos}`);
      } else {
        setSucesso(
          `Planilha gerada e ${registrados.length} aluno(s) registrados com retorno agendado para ${retorno.toLocaleDateString("pt-BR")}. Se o download não abriu, use o botão “Baixar planilha novamente” abaixo.${sufixoExcluidos}`
        );
      }
      carregarProgresso();
      carregarPorDia();
    } catch (e) {
      console.error("Erro ao gerar/registrar ação massiva:", e);
      setErro("Erro ao gerar/registrar: " + (e.message || "tente novamente"));
    } finally {
      setGerando(false);
    }
  }

  const valorTotal = resultados ? resultados.reduce((s, r) => s + r.valor, 0) : 0;

  // Transporta os filtros do painel de penetração para a prévia oficial e
  // recalcula. NÃO congela lista, NÃO cria/agenda/envia campanha — a prévia
  // reavalia toda a elegibilidade (confirmação, saldo, quitados, jurídico, etc.).
  function usarComoFiltroDaPenetracao({ ano, unidade: uni, curso: cur }) {
    const anoStr = ano ? String(ano) : "";
    setAnoVencimento(anoStr);
    setUnidade(uni || "");
    setCurso(cur || "");
    setAcionamentoFiltro("nunca");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    buscar({ ano: anoStr, unidade: uni || "", curso: cur || "", acionamento: "nunca" });
  }

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <div>
          <h1 style={estilos.titulo}>⚡ Ações Massivas</h1>
          <p style={estilos.subtitulo}>
            Estimula por fora (fora do CRM) casos livres, sem operador vinculado — priorizado por
            tempo sem contato (quem nunca foi acionado, ou faz mais tempo, vem primeiro), sem depender
            de operador pra fazer o acionamento manual.
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
      />

      {saude && (saude.sem_valor > 0 || saude.sem_telefone > 0) && (
        <div style={{ ...estilos.card, background: "#fef7f0", borderColor: "#fde3cc" }}>
          <strong style={{ fontFamily: FONTE_TITULO, fontSize: 14, display: "block", marginBottom: 6 }}>
            ⚠️ Casos fora do alcance das Ações Massivas
          </strong>
          <p style={{ margin: 0, fontSize: 13, color: "#7c4a1e" }}>
            <strong>{saude.sem_valor}</strong> livres sem valor calculado e{" "}
            <strong>{saude.sem_telefone}</strong> sem telefone cadastrado — esses não entram em nenhuma
            remessa automática. Precisam de conferência manual em{" "}
            <a href="/financeiro-hub" style={{ color: "#c2410c", fontWeight: 700 }}>Confirmação de Pagamento</a>.
          </p>
        </div>
      )}

      {progresso && progresso.total_elegivel > 0 && (
        <div style={estilos.card}>
          {(() => {
            const restante = Math.max(progresso.total_elegivel - progresso.ja_acionado, 0);
            const percentualAcionado = ((progresso.ja_acionado / progresso.total_elegivel) * 100).toFixed(1);
            return (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <strong style={{ fontFamily: FONTE_TITULO, fontSize: 14 }}>
                    {percentualAcionado}% da base já acionada (aguardando retorno)
                  </strong>
                  <span style={{ color: "#8a93a3", fontSize: 12.5 }}>
                    {progresso.ja_acionado} enviados · {restante} restantes de {progresso.total_elegivel}
                  </span>
                </div>
                {progresso.sem_acionamento != null && (
                  <div style={{ fontSize: 12.5, color: "#475569", marginBottom: 8 }}>
                    <strong style={{ color: "#0f172a" }}>{progresso.sem_acionamento}</strong> nunca acionados
                    {" "}— marque <strong>“Só nunca acionados”</strong> abaixo para priorizá-los.
                  </div>
                )}
                <div style={{ background: "#f1f5f9", borderRadius: 999, height: 10, overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${percentualAcionado}%`,
                      background: VERDE,
                      height: "100%",
                      borderRadius: 999,
                      transition: "width 0.3s ease",
                    }}
                  />
                </div>
              </>
            );
          })()}
        </div>
      )}

      {retornos && retornos.envios_avaliados > 0 && (
        <div style={estilos.card}>
          <h3 style={{ margin: "0 0 4px", fontFamily: FONTE_TITULO, fontSize: 15, fontWeight: 800 }}>
            Retorno das ações — conversão em até {retornos.janela_dias} dias
          </h3>
          <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "#8a93a3" }}>
            "Retorno" = houve tabulação operacional no aluno após o envio. Considera só envios cuja janela de {retornos.janela_dias} dias já fechou.
          </p>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <div style={estilos.miniCard}><div style={estilos.miniVal}>{Number(retornos.envios_avaliados || 0).toLocaleString("pt-BR")}</div><div style={estilos.miniRot}>Enviados (avaliados)</div></div>
            <div style={estilos.miniCard}><div style={estilos.miniVal}>{Number(retornos.com_retorno || 0).toLocaleString("pt-BR")}</div><div style={estilos.miniRot}>Com retorno</div></div>
            <div style={{ ...estilos.miniCard, background: "#eef2ff", borderColor: "#c7d2fe" }}><div style={{ ...estilos.miniVal, color: "#1e40af" }}>{(retornos.taxa_conversao ?? 0)}%</div><div style={estilos.miniRot}>Taxa de conversão</div></div>
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
          <div style={estilos.campo}>
            <label style={estilos.label}>Valor mínimo (nunca abaixo de R$ 100,00)</label>
            <input
              style={estilos.input}
              placeholder="Ex: 500,00"
              value={valorMin}
              onChange={(e) => setValorMin(e.target.value)}
            />
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label}>Valor máximo</label>
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
          <div style={estilos.campo}>
            <label style={estilos.label}>Unidade</label>
            <select
              style={estilos.input}
              value={unidade}
              onChange={(e) => setUnidade(e.target.value)}
            >
              <option value="">Todas as unidades</option>
              {opcoesUnidade.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
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
                            if (proximo.length) setAcionamentoFiltro("todos");
                            return proximo;
                          });
                        }}
                      />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {(b.arquivo_nome || "Borderô").replace(/\.xlsx?$/i, "")}
                        <span style={{ color: "#8a93a3" }}> · {b.qtd_alunos} al.</span>
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
          <div style={estilos.campo}>
            <label style={estilos.label}>Status acadêmico</label>
            <select
              style={estilos.input}
              value={situacaoAcad}
              onChange={(e) => setSituacaoAcad(e.target.value)}
            >
              <option value="">Todos os status</option>
              {opcoesSituacaoAcad.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
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
            <span style={{ fontSize: 11, color: "#8a93a3", marginTop: 4 }}>
              Inclui quem nunca foi acionado. Use o filtro “Acionamento” para separar.
            </span>
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label}>Acionamento</label>
            <select
              style={estilos.input}
              value={acionamentoFiltro}
              onChange={(e) => setAcionamentoFiltro(e.target.value)}
            >
              <option value="todos">Todos</option>
              <option value="nunca">Só nunca acionados</option>
              <option value="ja">Só já acionados</option>
            </select>
          </div>

          {canal === "EMAIL" && (
            <div style={{ ...estilos.campo, justifyContent: "flex-end" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: "#475569", marginBottom: 9 }}>
                <input
                  type="checkbox"
                  checked={soSemTelefone}
                  onChange={(e) => setSoSemTelefone(e.target.checked)}
                />
                Só sem telefone (prioridade)
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

      {resultados && excluidosConfirmacao.length > 0 && (
        <div style={{ ...estilos.card, background: "#fff7ed", borderColor: "#fed7aa", marginBottom: 12 }}>
          <button
            onClick={() => setMostrarExcluidos((v) => !v)}
            style={{
              background: "none", border: "none", cursor: "pointer", padding: 0,
              display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
            }}
          >
            <span style={{ fontFamily: FONTE_TITULO, fontSize: 14, fontWeight: 800, color: "#9a3412" }}>
              🔒 Excluídos por confirmação de pagamento: {excluidosConfirmacao.length}
            </span>
            <span style={{ color: "#c2410c", fontSize: 12.5, fontWeight: 700 }}>
              {mostrarExcluidos ? "▲ ocultar" : "▼ ver relação"}
            </span>
          </button>
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "#9a3412" }}>
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

      {resultados && (
        <div style={estilos.card}>
          <div style={estilos.resumoTopo}>
            <div>
              <strong style={{ fontFamily: FONTE_TITULO, fontSize: 18 }}>{resultados.length}</strong>{" "}
              <span style={{ color: "#8a93a3" }}>
                caso(s) livre(s) com {canal === "WHATSAPP" ? "telefone" : "e-mail"}, prontos pra ação
              </span>
              {resultados.length > 0 && (
                <span style={{ color: "#8a93a3" }}> · Total em aberto: {formatarMoeda(valorTotal)}</span>
              )}
            </div>
            {resultados.length > 0 && (
              <button style={estilos.botaoGerar} onClick={gerarEregistrar} disabled={gerando}>
                {gerando ? "Gerando..." : "⬇️ Gerar Excel e registrar ação"}
              </button>
            )}
          </div>

          {relatorioPronto && relatorioPronto.linhas?.length > 0 && (
            <div style={{ marginTop: 12, padding: "12px 14px", border: "1px solid #1e6b3a", borderRadius: 12, background: "#0e2318", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ color: "#bbf7d0", fontSize: 13 }}>
                Planilha de <strong>{relatorioPronto.linhas.length}</strong> aluno(s) pronta
                (<span style={{ color: "#8a93a3" }}>{relatorioPronto.nomeArquivo}</span>).
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
            <p style={{ color: "#8a93a3" }}>
              Nenhum caso livre com esses filtros (ou sem {canal === "WHATSAPP" ? "telefone" : "e-mail"} cadastrado).
            </p>
          ) : (
            <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
              <table style={estilos.tabela}>
                <thead>
                  <tr>
                    <th style={estilos.th}>Nome do aluno</th>
                    <th style={estilos.th}>Status acadêmico</th>
                    <th style={estilos.th}>{canal === "WHATSAPP" ? "Telefone (formatado)" : "E-mail"}</th>
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
                          <span style={{ color: "#9aa3b2" }}>—</span>
                        )}
                        {r.curso && <div style={{ color: "#8a93a3", fontSize: 11, marginTop: 2 }}>{r.curso}</div>}
                      </td>
                      <td style={estilos.td}>{canal === "WHATSAPP" ? r.telefoneMascarado : (<>{r.emailMascarado}{r.semTelefone && <span style={{ marginLeft: 6, background: "#fee2e2", color: "#b91c1c", borderRadius: 6, padding: "1px 6px", fontSize: 11, fontWeight: 800 }}>sem telefone</span>}</>)}</td>
                      <td style={estilos.tdNum}>
                        {r.diasSemContato === null ? (
                          <span style={{ color: "#b91c1c", fontWeight: 800 }}>Nunca acionado</span>
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
    background: "var(--rv-fundo, #f4f6fa)",
    minHeight: "100%",
  },
  cabecalho: { marginBottom: 18 },
  titulo: {
    margin: 0,
    color: "#0d1321",
    fontFamily: FONTE_TITULO,
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: "-0.03em",
  },
  subtitulo: { margin: "5px 0 0", color: "#8a93a3", fontSize: 13.5, maxWidth: 640 },
  abas: { display: "flex", gap: 8, marginBottom: 6 },
  aba: {
    background: "#fff",
    border: "1px solid #e3e7ee",
    borderRadius: 10,
    padding: "9px 16px",
    fontSize: 13,
    fontWeight: 700,
    color: "#475569",
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
    background: "#fff",
    borderRadius: 16,
    padding: "20px 22px",
    boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)",
    border: "1px solid #edf0f5",
    marginBottom: 18,
  },
  linhaFiltros: { display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 },
  campo: { display: "flex", flexDirection: "column", gap: 5, minWidth: 160 },
  label: { fontSize: 12, fontWeight: 700, color: "#475569" },
  input: {
    padding: "9px 12px",
    borderRadius: 10,
    border: "1px solid #e3e7ee",
    fontSize: 13,
  },
  caixaBordero: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    maxHeight: 120,
    overflowY: "auto",
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #e3e7ee",
    background: "#fafbfc",
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
    color: "#b91c1c",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    padding: 0,
  },
  erro: { color: "#b91c1c", fontSize: 13, marginBottom: 10 },
  sucesso: { color: "#0f7a4f", fontSize: 13, marginBottom: 10, fontWeight: 700 },
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
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    color: "#8a93a3",
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    background: "#f8fafc",
    borderBottom: "1px solid #e3e7ee",
    position: "sticky",
    top: 0,
  },
  thNum: {
    textAlign: "right",
    padding: "10px 12px",
    color: "#8a93a3",
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    background: "#f8fafc",
    borderBottom: "1px solid #e3e7ee",
    position: "sticky",
    top: 0,
  },
  td: { padding: "10px 12px", borderBottom: "1px solid #f2f4f7", color: "#344054" },
  tdNum: { padding: "10px 12px", borderBottom: "1px solid #f2f4f7", textAlign: "right", fontWeight: 700, color: "#101828" },
  miniCard: { background: "#f8fafc", border: "1px solid #edf0f5", borderRadius: 12, padding: "12px 16px", minWidth: 150 },
  miniVal: { fontSize: 26, fontWeight: 800, color: "#101828" },
  miniRot: { fontSize: 12, color: "#8a93a3", fontWeight: 600, marginTop: 2 },
};
