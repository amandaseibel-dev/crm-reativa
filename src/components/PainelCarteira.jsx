import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import { podeVerTudo, nomeOperadorPorEmail } from "../utils/operadores";

/*
  PainelCarteira
  --------------
  Novo painel no formato "Minha Carteira": KPIs no topo, tabela de casos e
  painel do aluno com acoes e historico. Um so componente, com escopo por
  perfil: gestao (podeVerTudo) enxerga a base completa e pode filtrar por
  operador; operador enxerga apenas a propria carteira.

  Regra de prazo (dias desde o ultimo contato / acionamento):
    0 a 7  -> Normal (dentro do prazo)
    8      -> Atencao
    9 a 10 -> Critico
    11+    -> Passivel de perda (o operador pode perder o caso)
  Por enquanto so sinaliza; nada e removido automaticamente.

  As acoes (registrar contato, agendar retorno, fechar acordo, juridico,
  cancelar) abrem a ficha existente (/aluno?alunoId=...), que ja executa
  todos esses fluxos. Assim reaproveitamos o que ja funciona.
*/

const OPERADORES = [
  { nome: "Fernanda Supervisora", email: "cobranca04@aelbra.com.br" },
  { nome: "Luana", email: "cobranca05@aelbra.com.br" },
  { nome: "Rafaella", email: "cobranca12@aelbra.com.br" },
  { nome: "Amanda ADM", email: "cobranca07@aelbra.com.br" },
  { nome: "Allan", email: "cobranca11@aelbra.com.br" },
  { nome: "Mauricio", email: "cobranca06@aelbra.com.br" },
  { nome: "Olga", email: "cobranca03@aelbra.com.br" },
  { nome: "Joao", email: "cobranca10@aelbra.com.br" },
  { nome: "Diego", email: "cobranca13@aelbra.com.br" },
  { nome: "Natali", email: "cobranca08@aelbra.com.br" },
  { nome: "Amanda Seibel", email: "amanda.seibel@aelbra.com.br" },
];

function formatarMoeda(valor) {
  const n = Number(valor) || 0;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function nomeAluno(a) {
  return a?.nome || a?.nome_aluno || a?.aluno || "Aluno sem nome";
}

function hojeLocalBR() {
  const d = new Date();
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function formatarData(data) {
  if (!data) return "-";
  if (/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    const [ano, mes, dia] = data.split("-");
    return `${dia}/${mes}/${ano}`;
  }
  try {
    return new Date(data).toLocaleDateString("pt-BR");
  } catch {
    return "-";
  }
}

function formatarDataHora(data) {
  if (!data) return "-";
  try {
    return new Date(data).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "-";
  }
}

function ehQuitado(a) {
  const texto = [a?.status_acionamento, a?.status_jornada, a?.status_atual]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
  return texto.includes("QUITAD") || texto.includes("QUITACAO");
}

// Dias desde o ultimo contato/acionamento. Retorna null se nunca acionado.
function diasSemContato(a) {
  const base = a?.data_ultimo_acionamento || a?.ultimo_contato || a?.responsavel_atual_em || null;
  if (!base) return null;
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// Situacao operacional (badge azul/claro) a partir do status_atual/jornada.
const MAPA_SITUACAO = {
  CONTATAR: "A contatar",
  MENSAGEM_ENVIADA: "Mensagem enviada",
  EM_ATENDIMENTO: "Em atendimento",
  ALUNO_EM_NEGOCIACAO_24H: "Em negociacao",
  RETORNAR_DEPOIS: "Retornar depois",
  SEM_RETORNO: "Sem retorno",
  NAO_LOCALIZADO: "Nao localizado",
  AGUARDANDO_LINK: "Aguardando link",
  SOLICITADO_LINK: "Link solicitado",
  LINK_ENVIADO_AO_ALUNO: "Link enviado",
  AGUARDANDO_COMPROVANTE: "Aguardando comprovante",
  AGUARDANDO_BAIXA: "Aguardando baixa",
  BAIXA_REALIZADA: "Pago",
  ACORDO_FECHADO: "Acordo fechado",
  TERMO_ENVIADO_ALUNO: "Termo enviado",
  TERMO_ENVIADO_ADM: "Termo no ADM",
  JURIDICO: "Juridico",
  CANCELAMENTO_COBRANCA: "Cancelado",
  SUSPENSAO_COBRANCA: "Suspenso",
};

function situacaoLabel(a) {
  const s = a?.status_atual || a?.status_jornada || "";
  if (MAPA_SITUACAO[s]) return MAPA_SITUACAO[s];
  if (!s || s === "Novo caso") return "Sem contato";
  return s;
}

// Status de saude do caso (badge com bolinha), pela regra de prazo.
function statusPrazo(a) {
  const sit = a?.status_atual || "";
  if (sit === "JURIDICO") return { label: "Juridico", cor: "#7c3aed" };
  if (["ACORDO_FECHADO", "AGUARDANDO_BAIXA", "AGUARDANDO_COMPROVANTE", "SOLICITADO_LINK", "LINK_ENVIADO_AO_ALUNO"].includes(sit))
    return { label: "Aguardando pgto", cor: "#2563eb" };
  if (sit === "BAIXA_REALIZADA") return { label: "Pago", cor: "#16a34a" };
  if (["CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA"].includes(sit))
    return { label: "Cancelado", cor: "#6b7280" };

  const dias = diasSemContato(a);
  if (dias === null) return { label: "Novo", cor: "#94a3b8" };
  if (dias <= 7) return { label: "Dentro do prazo", cor: "#16a34a" };
  if (dias === 8) return { label: "Atencao", cor: "#f59e0b" };
  if (dias <= 10) return { label: "Critico", cor: "#dc2626" };
  return { label: "Perdendo o caso", cor: "#991b1b" };
}

export default function PainelCarteira({ embedded = false }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState(null);
  const [veTudo, setVeTudo] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  const [operadorFiltro, setOperadorFiltro] = useState("TODOS"); // so gestao usa
  const [casos, setCasos] = useState([]);
  const [kpis, setKpis] = useState({
    ativos: 0,
    semContato: 0,
    criticos: 0,
    retornosHoje: 0,
    acordosQuebrados: 0,
    recebidosMes: 0,
    quitados: 0,
  });

  const [busca, setBusca] = useState("");
  const [filtroStatus, setFiltroStatus] = useState("TODOS");
  const [selecionado, setSelecionado] = useState(null);
  const [historico, setHistorico] = useState([]);
  const [honorarios, setHonorarios] = useState(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      const mail = data?.user?.email || null;
      setEmail(mail);
      setVeTudo(podeVerTudo(mail));
    })();
  }, []);

  useEffect(() => {
    if (email === null) return;
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, veTudo, operadorFiltro]);

  // email de escopo: operador -> ele mesmo; gestao -> filtro escolhido (ou todos)
  function emailEscopo() {
    if (!veTudo) return email;
    return operadorFiltro === "TODOS" ? null : operadorFiltro;
  }

  function aplicarEscopo(query) {
    const alvo = emailEscopo();
    if (alvo) return query.eq("responsavel_atual_email", alvo);
    return query;
  }

  async function carregar() {
    setCarregando(true);
    setErro("");
    try {
      const hoje = hojeLocalBR();
      const corte = (n) => {
        const d = new Date();
        d.setHours(23, 59, 59, 999);
        d.setDate(d.getDate() - n);
        return d.toISOString();
      };

      // Tabela de casos (limite de exibicao)
      const colunas =
        "id,nome,nome_aluno,cpf,telefone,valor_em_aberto,status_atual,status_jornada,status_acionamento,nivel_criticidade,data_ultimo_acionamento,ultimo_contato,data_retorno,hora_retorno,responsavel_atual_nome,responsavel_atual_email,observacao";
      // Carrega a carteira inteira, paginando (Supabase limita 1000 por
      // requisicao). Para um operador (ou gestao filtrando um operador)
      // puxa tudo; para "todos os operadores" da gestao aplica um teto
      // pra nao travar o navegador com a base inteira.
      const alvoEscopo = emailEscopo();
      const TETO = alvoEscopo ? 50000 : 3000;
      const PAGINA = 1000;
      let todas = [];
      let inicio = 0;
      while (true) {
        let q = supabase
          .from("alunos")
          .select(colunas)
          .order("data_ultimo_acionamento", { ascending: true, nullsFirst: false })
          .range(inicio, inicio + PAGINA - 1);
        q = aplicarEscopo(q);
        const { data: parte, error: erroParte } = await q;
        if (erroParte) throw erroParte;
        todas = todas.concat(parte || []);
        if (!parte || parte.length < PAGINA || todas.length >= TETO) break;
        inicio += PAGINA;
      }
      const listaAtiva = todas.filter((a) => !ehQuitado(a));
      setCasos(listaAtiva);

      // KPIs por contagem (head:true), escopados
      const cAtivos = aplicarEscopo(
        supabase.from("alunos").select("id", { count: "exact", head: true })
      ).not("status_atual", "ilike", "%QUITAD%");
      const cRetHoje = aplicarEscopo(
        supabase.from("alunos").select("id", { count: "exact", head: true }).eq("data_retorno", hoje)
      );
      const cSemContato = aplicarEscopo(
        supabase.from("alunos").select("id", { count: "exact", head: true }).lte("data_ultimo_acionamento", corte(10))
      );
      const c9 = aplicarEscopo(
        supabase.from("alunos").select("id", { count: "exact", head: true }).lte("data_ultimo_acionamento", corte(9))
      );
      const c11 = aplicarEscopo(
        supabase.from("alunos").select("id", { count: "exact", head: true }).lte("data_ultimo_acionamento", corte(11))
      );
      const cQuitados = aplicarEscopo(
        supabase
          .from("alunos")
          .select("id", { count: "exact", head: true })
          .or("status_atual.ilike.%QUITAD%,status_jornada.ilike.%QUITAD%,status_acionamento.ilike.%QUITAD%")
      );

      const [rAtivos, rRetHoje, rSemContato, r9, r11, rQuitados] = await Promise.all([
        cAtivos,
        cRetHoje,
        cSemContato,
        c9,
        c11,
        cQuitados,
      ]);

      // Acordos quebrados e recebidos no mes: a base de acordos e pequena,
      // entao carregamos e calculamos no cliente.
      let qAcordos = supabase.from("acordos").select("id,operador_responsavel_email,status,honorarios_valor");
      const alvo = emailEscopo();
      if (alvo) qAcordos = qAcordos.eq("operador_responsavel_email", alvo);
      const { data: acordos } = await qAcordos;
      const acordoIds = (acordos || []).map((a) => a.id);

      let parcelas = [];
      if (acordoIds.length) {
        const { data: parc } = await supabase
          .from("parcelas")
          .select("acordo_id,status,vencimento,pago_em,valor")
          .in("acordo_id", acordoIds);
        parcelas = parc || [];
      }

      const inicioMes = `${hoje.slice(0, 7)}-01`;
      const recebidosMes = parcelas.filter(
        (p) => p.status === "PAGO" && p.pago_em && p.pago_em >= inicioMes
      ).length;

      const acordosComAtraso = new Set(
        parcelas
          .filter((p) => p.status !== "PAGO" && p.vencimento && p.vencimento < hoje)
          .map((p) => p.acordo_id)
      );
      const acordosAtivos = new Set((acordos || []).filter((a) => a.status === "ATIVO").map((a) => a.id));
      const acordosQuebrados = [...acordosComAtraso].filter((id) => acordosAtivos.has(id)).length;

      setKpis({
        ativos: rAtivos.count || 0,
        semContato: rSemContato.count || 0,
        criticos: Math.max(0, (r9.count || 0) - (r11.count || 0)),
        retornosHoje: rRetHoje.count || 0,
        acordosQuebrados,
        recebidosMes,
        quitados: rQuitados.count || 0,
      });
    } catch (e) {
      console.error("Erro no PainelCarteira:", e);
      setErro("Nao foi possivel carregar todos os dados. " + (e?.message || ""));
    } finally {
      setCarregando(false);
    }
  }

  async function selecionar(a) {
    if (a?.id && selecionado?.id === a.id) return;
    setSelecionado(a);
    setHistorico([]);
    setHonorarios(null);
    if (!a?.id) return;
    const { data: mov } = await supabase
      .from("aluno_movimentacoes")
      .select("id,tipo,descricao,status_novo,registrado_por_nome,registrado_em")
      .eq("aluno_id", String(a.id))
      .order("registrado_em", { ascending: false })
      .limit(8);
    setHistorico(mov || []);

    const cpf = a.cpf;
    if (cpf) {
      const { data: acs } = await supabase
        .from("acordos")
        .select("honorarios_valor")
        .eq("cpf", cpf);
      const total = (acs || []).reduce((s, x) => s + (Number(x.honorarios_valor) || 0), 0);
      setHonorarios(total || 0);
    }
  }

  function abrirFicha(a) {
    if (!a?.id) return;
    navigate(`/aluno?alunoId=${encodeURIComponent(a.id)}&origem=painel`);
  }

  const listaFiltrada = useMemo(() => {
    let l = casos;
    if (filtroStatus !== "TODOS") {
      l = l.filter((a) => statusPrazo(a).label === filtroStatus);
    }
    if (busca.trim()) {
      const t = busca.toLowerCase().trim();
      l = l.filter((a) =>
        [nomeAluno(a), a.cpf, a.telefone, a.responsavel_atual_nome, situacaoLabel(a)]
          .filter(Boolean)
          .some((c) => String(c).toLowerCase().includes(t))
      );
    }
    return l;
  }, [casos, filtroStatus, busca]);

  const kpiCards = [
    { rot: "Casos ativos", val: kpis.ativos, cor: "#2563eb", icone: "📁" },
    { rot: "Sem contato +10 dias", val: kpis.semContato, cor: "#f59e0b", icone: "📵" },
    { rot: "Criticos (9-10 dias)", val: kpis.criticos, cor: "#dc2626", icone: "⚠️" },
    { rot: "Retornos hoje", val: kpis.retornosHoje, cor: "#0ea5e9", icone: "📅" },
    { rot: "Acordos quebrados", val: kpis.acordosQuebrados, cor: "#e11d48", icone: "💔" },
    { rot: "Recebidos este mes", val: kpis.recebidosMes, cor: "#16a34a", icone: "💰" },
    { rot: "Quitados", val: kpis.quitados, cor: "#16a34a", icone: "✅" },
  ];

  const conteudo = (
      <div style={S.pagina}>
        <div style={S.cabecalho}>
          <div>
            <h1 style={S.titulo}>Minha Carteira</h1>
            <p style={S.subtitulo}>
              {veTudo
                ? "Visao completa da base de casos."
                : `Carteira de ${nomeOperadorPorEmail(email)}.`}
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={S.userChip}>
              <span style={S.userNome}>{nomeOperadorPorEmail(email)}</span>
              <span style={S.userRole}>{veTudo ? "Gestao" : "Operador"}</span>
            </div>
            {veTudo && (
              <select
                style={S.select}
                value={operadorFiltro}
                onChange={(e) => setOperadorFiltro(e.target.value)}
              >
                <option value="TODOS">Todos os operadores</option>
                {OPERADORES.map((o) => (
                  <option key={o.email} value={o.email}>
                    {o.nome}
                  </option>
                ))}
              </select>
            )}
            <button style={S.btnAtualizar} onClick={carregar} disabled={carregando}>
              {carregando ? "Atualizando..." : "Atualizar"}
            </button>
          </div>
        </div>

        {erro && <p style={S.erro}>{erro}</p>}

        {/* KPIs */}
        <div style={S.kpiGrid}>
          {kpiCards.map((k) => (
            <div key={k.rot} style={{ ...S.kpiCard, borderTop: `3px solid ${k.cor}` }}>
              <span style={S.kpiIcone}>{k.icone}</span>
              <p style={S.kpiRot}>{k.rot}</p>
              <p style={{ ...S.kpiVal, color: k.cor }}>{k.val}</p>
            </div>
          ))}
        </div>

        {/* Corpo: tabela + painel do aluno */}
        <div style={S.corpo}>
          <div style={S.painelTabela}>
            <div style={S.filtros}>
              <input
                style={S.inputBusca}
                placeholder="Pesquisar por CPF, nome ou telefone..."
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
              <select style={S.select} value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)}>
                <option value="TODOS">Todos os status</option>
                <option value="Dentro do prazo">Dentro do prazo</option>
                <option value="Atencao">Atencao</option>
                <option value="Critico">Critico</option>
                <option value="Perdendo o caso">Perdendo o caso</option>
                <option value="Aguardando pgto">Aguardando pgto</option>
                <option value="Juridico">Juridico</option>
              </select>
            </div>

            <h2 style={S.tituloSecao}>Casos da carteira</h2>

            <div style={S.tabelaWrap}>
              <table style={S.tabela}>
                <thead>
                  <tr>
                    <th style={S.th}>Nome</th>
                    <th style={S.th}>CPF</th>
                    <th style={S.th}>Situacao</th>
                    <th style={S.th}>Ult. contato</th>
                    <th style={S.th}>Prox. contato</th>
                    <th style={S.thNum}>Valor aberto</th>
                    <th style={S.th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {listaFiltrada.map((a) => {
                    const sp = statusPrazo(a);
                    const ativo = selecionado?.id === a.id;
                    return (
                      <tr
                        key={a.id}
                        style={{ ...S.tr, ...(ativo ? S.trAtivo : {}) }}
                        onClick={() => abrirFicha(a)}
                        onMouseEnter={() => selecionar(a)}
                      >
                        <td style={S.td}>
                          <div style={S.nomeCel}>{nomeAluno(a)}</div>
                          <div style={S.subCel}>{a.telefone || "-"}</div>
                        </td>
                        <td style={S.td}>{a.cpf || "-"}</td>
                        <td style={S.td}>
                          <span style={S.badgeSituacao}>{situacaoLabel(a)}</span>
                        </td>
                        <td style={S.td}>{formatarData(a.data_ultimo_acionamento || a.ultimo_contato)}</td>
                        <td style={S.td}>{formatarData(a.data_retorno)}</td>
                        <td style={S.tdNum}>{formatarMoeda(a.valor_em_aberto)}</td>
                        <td style={S.td}>
                          <span style={{ ...S.badgeStatus, color: sp.cor }}>
                            <span style={{ ...S.bolinha, background: sp.cor }} />
                            {sp.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {listaFiltrada.length === 0 && (
                    <tr>
                      <td style={S.vazio} colSpan={7}>
                        {carregando ? "Carregando..." : "Nenhum caso neste filtro."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p style={S.rodapeTabela}>
              Mostrando {listaFiltrada.length} de {casos.length} casos carregados.
            </p>
          </div>

          {/* Painel do aluno */}
          <aside style={S.painelAluno}>
            {!selecionado ? (
              <div style={S.semSelecao}>Selecione um caso para ver os detalhes e agir.</div>
            ) : (
              <>
                <div style={S.alunoTopo}>
                  <h3 style={S.alunoNome}>{nomeAluno(selecionado)}</h3>
                  <span style={S.badgeSituacao}>{situacaoLabel(selecionado)}</span>
                </div>

                <div style={S.linhaInfo}>
                  <span style={S.rotInfo}>Operador responsavel</span>
                  <span style={S.valInfo}>{selecionado.responsavel_atual_nome || "-"}</span>
                </div>
                <div style={S.linhaInfo}>
                  <span style={S.rotInfo}>Ultimo contato</span>
                  <span style={S.valInfo}>{formatarData(selecionado.data_ultimo_acionamento || selecionado.ultimo_contato)}</span>
                </div>
                <div style={S.linhaInfo}>
                  <span style={S.rotInfo}>Proximo contato</span>
                  <span style={S.valInfo}>
                    {formatarData(selecionado.data_retorno)}
                    {selecionado.hora_retorno ? ` ${selecionado.hora_retorno}` : ""}
                  </span>
                </div>
                <div style={S.linhaInfo}>
                  <span style={S.rotInfo}>Valor em aberto</span>
                  <span style={S.valInfo}>{formatarMoeda(selecionado.valor_em_aberto)}</span>
                </div>
                <div style={S.linhaInfo}>
                  <span style={S.rotInfo}>Honorarios</span>
                  <span style={S.valInfo}>{honorarios === null ? "..." : formatarMoeda(honorarios)}</span>
                </div>
                <div style={S.linhaInfo}>
                  <span style={S.rotInfo}>Status</span>
                  <span style={{ ...S.valInfo, color: statusPrazo(selecionado).cor, fontWeight: "bold" }}>
                    {statusPrazo(selecionado).label}
                  </span>
                </div>

                <div style={S.acoesGrid}>
                  <button style={{ ...S.btnAcao, ...S.acaoAzul }} onClick={() => abrirFicha(selecionado)}>
                    📞 Registrar contato
                  </button>
                  <button style={{ ...S.btnAcao, ...S.acaoRoxoClaro }} onClick={() => abrirFicha(selecionado)}>
                    📅 Agendar retorno
                  </button>
                  <button style={{ ...S.btnAcao, ...S.acaoLaranja }} onClick={() => abrirFicha(selecionado)}>
                    💵 Registrar proposta
                  </button>
                  <button style={{ ...S.btnAcao, ...S.acaoVerde }} onClick={() => abrirFicha(selecionado)}>
                    ✔️ Fechar acordo
                  </button>
                  {veTudo ? (
                    <>
                      <button style={{ ...S.btnAcao, ...S.acaoRoxo }} onClick={() => abrirFicha(selecionado)}>
                        ⚖️ Juridico
                      </button>
                      <button style={{ ...S.btnAcao, ...S.acaoVermelho }} onClick={() => abrirFicha(selecionado)}>
                        ✖️ Cancelado
                      </button>
                    </>
                  ) : (
                    <button
                      style={{ ...S.btnAcao, ...S.acaoRoxo, gridColumn: "1 / -1" }}
                      onClick={() => abrirFicha(selecionado)}
                    >
                      ↗️ Encaminhar p/ Amanda
                    </button>
                  )}
                </div>
                <button style={S.btnFicha} onClick={() => abrirFicha(selecionado)}>
                  Abrir ficha completa do aluno →
                </button>

                <h4 style={S.tituloHist}>Historico de contatos</h4>
                <div style={S.historico}>
                  {historico.length === 0 && <p style={S.subCel}>Sem movimentacoes registradas.</p>}
                  {historico.map((h) => (
                    <div key={h.id} style={S.itemHist}>
                      <div style={S.histData}>{formatarDataHora(h.registrado_em)}</div>
                      <div style={S.histDesc}>{h.descricao || h.tipo || h.status_novo || "Movimentacao"}</div>
                      {h.registrado_por_nome && <div style={S.histAutor}>por {h.registrado_por_nome}</div>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
  );
  return embedded ? conteudo : <main className="content">{conteudo}</main>;
}

const S = {
  pagina: { padding: "24px", fontFamily: "Arial, sans-serif", background: "#f1f5f9", minHeight: "100%" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 16, flexWrap: "wrap" },
  titulo: { margin: 0, marginBottom: 4, color: "#0f172a", fontSize: 26 },
  subtitulo: { margin: 0, color: "#64748b", fontSize: 14 },
  userChip: { display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.1 },
  userNome: { fontWeight: 700, color: "#0f172a", fontSize: 14 },
  userRole: { fontSize: 11, color: "#7c3aed", fontWeight: 600 },
  select: { padding: "9px 12px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", fontSize: 14 },
  btnAtualizar: { background: "#0f172a", color: "#fff", border: "none", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontWeight: "bold" },
  erro: { color: "#b91c1c", fontWeight: "bold" },

  kpiGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 18 },
  kpiCard: { background: "#fff", borderRadius: 12, padding: "14px 16px", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" },
  kpiIcone: { fontSize: 18 },
  kpiRot: { margin: "6px 0 4px 0", fontSize: 12.5, color: "#64748b", fontWeight: 600 },
  kpiVal: { margin: 0, fontSize: 26, fontWeight: 800 },

  corpo: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: 16, alignItems: "start" },
  painelTabela: { background: "#fff", borderRadius: 12, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" },
  filtros: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 },
  inputBusca: { flex: 1, minWidth: 220, padding: "10px 12px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 14 },
  tituloSecao: { margin: "4px 0 12px 0", color: "#0f172a", fontSize: 16 },
  tabelaWrap: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13.5 },
  th: { textAlign: "left", padding: "10px 8px", color: "#64748b", fontSize: 12, borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "10px 8px", color: "#64748b", fontSize: 12, borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap" },
  tr: { cursor: "pointer", borderBottom: "1px solid #f1f5f9" },
  trAtivo: { background: "#eff6ff", boxShadow: "inset 3px 0 0 #2563eb" },
  td: { padding: "10px 8px", color: "#334155", verticalAlign: "middle" },
  tdNum: { padding: "10px 8px", color: "#334155", textAlign: "right", whiteSpace: "nowrap" },
  nomeCel: { fontWeight: 600, color: "#0f172a" },
  subCel: { fontSize: 12, color: "#94a3b8" },
  badgeSituacao: { display: "inline-block", padding: "3px 9px", borderRadius: 999, background: "#e0edff", color: "#1d4ed8", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" },
  badgeStatus: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" },
  bolinha: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
  vazio: { padding: 24, textAlign: "center", color: "#94a3b8" },
  rodapeTabela: { margin: "10px 0 0 0", fontSize: 12, color: "#94a3b8" },

  painelAluno: { background: "#fff", borderRadius: 12, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", position: "sticky", top: 16 },
  semSelecao: { color: "#94a3b8", fontSize: 14, padding: "20px 4px" },
  alunoTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 14, borderBottom: "1px solid #f1f5f9", paddingBottom: 12 },
  alunoNome: { margin: 0, fontSize: 17, color: "#0f172a" },
  linhaInfo: { display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0", fontSize: 13.5 },
  rotInfo: { color: "#64748b" },
  valInfo: { color: "#0f172a", fontWeight: 600, textAlign: "right" },
  acoesGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "14px 0 10px 0" },
  btnAcao: { border: "none", borderRadius: 8, padding: "10px 8px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  acaoAzul: { background: "#e0edff", color: "#1d4ed8" },
  acaoRoxoClaro: { background: "#f3e8ff", color: "#7c3aed" },
  acaoLaranja: { background: "#ffedd5", color: "#c2410c" },
  acaoVerde: { background: "#dcfce7", color: "#15803d" },
  acaoRoxo: { background: "#ede9fe", color: "#6d28d9" },
  acaoVermelho: { background: "#fee2e2", color: "#b91c1c" },
  btnFicha: { width: "100%", background: "#0f172a", color: "#fff", border: "none", borderRadius: 8, padding: "10px", fontWeight: 700, cursor: "pointer", marginBottom: 14 },
  tituloHist: { margin: "6px 0 8px 0", fontSize: 14, color: "#0f172a" },
  historico: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 260, overflowY: "auto" },
  itemHist: { borderLeft: "2px solid #e2e8f0", paddingLeft: 10 },
  histData: { fontSize: 11.5, color: "#94a3b8" },
  histDesc: { fontSize: 13, color: "#334155" },
  histAutor: { fontSize: 11.5, color: "#94a3b8" },
};
