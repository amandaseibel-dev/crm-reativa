import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { podeVerTudo } from "../utils/operadores";

const OPERADORES_REATIVA = [
  { nome: "Fernanda Supervisora", email: "cobranca04@aelbra.com.br" },
  { nome: "Luana", email: "cobranca05@aelbra.com.br" },
  { nome: "Rafaella", email: "cobranca12@aelbra.com.br" },
  { nome: "Amanda ADM", email: "cobranca07@aelbra.com.br" },
  { nome: "Allan", email: "cobranca11@aelbra.com.br" },
  { nome: "Maurício", email: "cobranca06@aelbra.com.br" },
  { nome: "Olga", email: "cobranca03@aelbra.com.br" },
  { nome: "João", email: "cobranca10@aelbra.com.br" },
  { nome: "Diego", email: "cobranca13@aelbra.com.br" },
  { nome: "Natali", email: "cobranca08@aelbra.com.br" },
  { nome: "Amanda Seibel", email: "amanda.seibel@aelbra.com.br" },
];

const STATUS_LABELS = {
  SOLICITADO_LINK: "Solicitado",
  LINK_EM_ATENDIMENTO: "Em atendimento",
  LINK_PRONTO_PARA_ENVIO: "Respondido",
  LINK_ENVIADO_AO_ALUNO: "Enviado ao aluno",
  AGUARDANDO_BAIXA: "Aguardando baixa",
  BAIXA_REALIZADA: "Baixa realizada",
  BAIXA_DEVOLVIDA: "Baixa devolvida",
  CANCELADO: "Cancelado",
  DIVERGENCIA: "Divergência",
};

const STATUS_AGUARDANDO = ["SOLICITADO_LINK", "LINK_EM_ATENDIMENTO"];

const LIMITE_ATRASO_MIN = 60;

function corStatus(status) {
  if (STATUS_AGUARDANDO.includes(status)) {
    return { bg: "#fef3c7", texto: "#92400e" };
  }
  if (status === "LINK_PRONTO_PARA_ENVIO" || status === "BAIXA_REALIZADA") {
    return { bg: "#dcfce7", texto: "#166534" };
  }
  if (status === "CANCELADO" || status === "DIVERGENCIA" || status === "BAIXA_DEVOLVIDA") {
    return { bg: "#fee2e2", texto: "#991b1b" };
  }
  return { bg: "#e0f2fe", texto: "#075985" };
}

function inicioPeriodo(periodo) {
  const agora = new Date();

  if (periodo === "HOJE") {
    agora.setHours(0, 0, 0, 0);
    return agora;
  }

  if (periodo === "SEMANA") {
    const diaSemana = agora.getDay();
    agora.setDate(agora.getDate() - diaSemana);
    agora.setHours(0, 0, 0, 0);
    return agora;
  }

  if (periodo === "MES") {
    agora.setDate(1);
    agora.setHours(0, 0, 0, 0);
    return agora;
  }

  return null;
}

function diffMinutos(inicio, fim) {
  if (!inicio || !fim) return null;
  const ms = new Date(fim).getTime() - new Date(inicio).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

function formatarDuracao(minutos) {
  if (minutos === null || minutos === undefined) return "-";
  if (minutos < 60) return `${minutos}min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return resto > 0 ? `${horas}h ${resto}min` : `${horas}h`;
}

function formatarMoeda(valor) {
  if (valor === null || valor === undefined || valor === "") return "-";
  const numero = Number(valor);
  if (Number.isNaN(numero)) return "-";
  return numero.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function PainelAdm() {
  const [usuario, setUsuario] = useState(null);
  const [links, setLinks] = useState([]);
  const [aguardandoGeral, setAguardandoGeral] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  const [periodo, setPeriodo] = useState("HOJE");
  const [operadorFiltro, setOperadorFiltro] = useState("TODOS");
  const [statusFiltro, setStatusFiltro] = useState("TODOS");
  const [busca, setBusca] = useState("");

  useEffect(() => {
    carregarUsuario();
  }, []);

  useEffect(() => {
    carregarLinks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodo]);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarLinks() {
    setCarregando(true);
    setErro("");

    try {
      const desde = inicioPeriodo(periodo);

      let query = supabase
        .from("links_pagamento")
        .select(
          "id, aluno_nome, operador_nome, operador_solicitante, operador_email, valor, status, criado_em, respondido_em"
        )
        .order("criado_em", { ascending: false })
        .limit(2000);

      if (desde) {
        query = query.gte("criado_em", desde.toISOString());
      }

      const { data, error } = await query;

      if (error) {
        console.error("Erro ao carregar links:", error);
        setErro("Não foi possível carregar os links de pagamento.");
        setCarregando(false);
        return;
      }

      setLinks(data || []);

      const { count, error: erroAguardando } = await supabase
        .from("links_pagamento")
        .select("id", { count: "exact", head: true })
        .in("status", STATUS_AGUARDANDO);

      if (!erroAguardando) {
        setAguardandoGeral(count || 0);
      }
    } finally {
      setCarregando(false);
    }
  }

  const indicadores = useMemo(() => {
    const respondidos = links.filter((l) => l.respondido_em);

    const temposResposta = respondidos
      .map((l) => diffMinutos(l.criado_em, l.respondido_em))
      .filter((v) => v !== null);

    const tempoMedio =
      temposResposta.length > 0
        ? Math.round(temposResposta.reduce((a, b) => a + b, 0) / temposResposta.length)
        : null;

    return {
      solicitados: links.length,
      respondidos: respondidos.length,
      tempoMedio,
    };
  }, [links]);

  const porOperador = useMemo(() => {
    const mapa = {};

    links.forEach((l) => {
      if (!l.respondido_em) return;

      const nome = l.operador_nome || l.operador_solicitante || l.operador_email || "Sem operador";
      const minutos = diffMinutos(l.criado_em, l.respondido_em);
      if (minutos === null) return;

      if (!mapa[nome]) mapa[nome] = { nome, total: 0, soma: 0 };
      mapa[nome].total += 1;
      mapa[nome].soma += minutos;
    });

    return Object.values(mapa)
      .map((item) => ({ nome: item.nome, media: Math.round(item.soma / item.total) }))
      .sort((a, b) => b.media - a.media)
      .slice(0, 8);
  }, [links]);

  const maiorMedia = useMemo(
    () => Math.max(1, ...porOperador.map((o) => o.media)),
    [porOperador]
  );

  const linksFiltrados = useMemo(() => {
    let lista = [...links];

    if (operadorFiltro !== "TODOS") {
      lista = lista.filter(
        (l) =>
          String(l.operador_email || "").toLowerCase() === operadorFiltro.toLowerCase()
      );
    }

    if (statusFiltro === "AGUARDANDO") {
      lista = lista.filter((l) => STATUS_AGUARDANDO.includes(l.status));
    } else if (statusFiltro !== "TODOS") {
      lista = lista.filter((l) => l.status === statusFiltro);
    }

    if (busca.trim()) {
      const termo = busca.trim().toLowerCase();
      lista = lista.filter((l) =>
        [l.aluno_nome, l.operador_nome, l.operador_solicitante]
          .join(" ")
          .toLowerCase()
          .includes(termo)
      );
    }

    return lista;
  }, [links, operadorFiltro, statusFiltro, busca]);

  if (usuario && !podeVerTudo(usuario.email)) {
    return (
      <div style={estilos.pagina}>
        <p>Você não tem permissão para ver este painel.</p>
      </div>
    );
  }

  return (
    <div style={estilos.pagina}>
      <div style={estilos.filtros}>
        <select
          value={periodo}
          onChange={(e) => setPeriodo(e.target.value)}
          style={estilos.select}
        >
          <option value="HOJE">Hoje</option>
          <option value="SEMANA">Esta semana</option>
          <option value="MES">Este mês</option>
          <option value="TODOS">Tudo</option>
        </select>

        <select
          value={operadorFiltro}
          onChange={(e) => setOperadorFiltro(e.target.value)}
          style={estilos.select}
        >
          <option value="TODOS">Todos os operadores</option>
          {OPERADORES_REATIVA.map((op) => (
            <option key={op.email} value={op.email}>
              {op.nome}
            </option>
          ))}
        </select>

        <select
          value={statusFiltro}
          onChange={(e) => setStatusFiltro(e.target.value)}
          style={estilos.select}
        >
          <option value="TODOS">Todos os status</option>
          <option value="AGUARDANDO">Aguardando resposta</option>
          {Object.entries(STATUS_LABELS).map(([valor, label]) => (
            <option key={valor} value={valor}>
              {label}
            </option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Buscar aluno ou operador"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          style={estilos.busca}
        />

        <button type="button" onClick={carregarLinks} style={estilos.botaoAtualizar}>
          Atualizar
        </button>
      </div>

      {erro && <div style={estilos.erro}>{erro}</div>}

      <div style={estilos.grid}>
        <div style={estilos.cartao}>
          <p style={estilos.rotuloCartao}>Solicitados no período</p>
          <p style={estilos.valorCartao}>{indicadores.solicitados}</p>
        </div>

        <div style={{ ...estilos.cartao, background: "#fef3c7" }}>
          <p style={{ ...estilos.rotuloCartao, color: "#92400e" }}>Aguardando resposta agora</p>
          <p style={{ ...estilos.valorCartao, color: "#92400e" }}>{aguardandoGeral}</p>
        </div>

        <div style={{ ...estilos.cartao, background: "#dcfce7" }}>
          <p style={{ ...estilos.rotuloCartao, color: "#166534" }}>Respondidos no período</p>
          <p style={{ ...estilos.valorCartao, color: "#166534" }}>{indicadores.respondidos}</p>
        </div>

        <div style={estilos.cartao}>
          <p style={estilos.rotuloCartao}>Tempo médio de resposta</p>
          <p style={estilos.valorCartao}>{formatarDuracao(indicadores.tempoMedio)}</p>
        </div>
      </div>

      {porOperador.length > 0 && (
        <div style={estilos.cartaoGrafico}>
          <p style={estilos.rotuloGrafico}>Tempo médio de resposta por operador (no período)</p>

          {porOperador.map((op) => (
            <div key={op.nome} style={estilos.linhaGrafico}>
              <span style={estilos.nomeGrafico}>{op.nome}</span>
              <div style={estilos.barraFundo}>
                <div
                  style={{
                    ...estilos.barraPreenchida,
                    width: `${Math.max(6, (op.media / maiorMedia) * 100)}%`,
                    background: op.media > LIMITE_ATRASO_MIN ? "#d97706" : "#0f6e56",
                  }}
                />
              </div>
              <span style={estilos.valorGrafico}>{formatarDuracao(op.media)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={estilos.tabelaContainer}>
        {carregando ? (
          <p style={estilos.textoAuxiliar}>Carregando...</p>
        ) : linksFiltrados.length === 0 ? (
          <p style={estilos.textoAuxiliar}>Nenhum link encontrado para esse filtro.</p>
        ) : (
          <table style={estilos.tabela}>
            <thead>
              <tr>
                <th style={estilos.th}>Aluno</th>
                <th style={estilos.th}>Operador</th>
                <th style={estilos.th}>Valor</th>
                <th style={estilos.th}>Status</th>
                <th style={estilos.th}>Tempo</th>
              </tr>
            </thead>
            <tbody>
              {linksFiltrados.map((item) => {
                const cores = corStatus(item.status);
                const aguardando = STATUS_AGUARDANDO.includes(item.status);
                const minutosResposta = item.respondido_em
                  ? diffMinutos(item.criado_em, item.respondido_em)
                  : aguardando
                  ? diffMinutos(item.criado_em, new Date().toISOString())
                  : null;

                const atrasado = aguardando && minutosResposta !== null && minutosResposta > LIMITE_ATRASO_MIN;

                return (
                  <tr key={item.id} style={estilos.tr}>
                    <td style={estilos.td}>{item.aluno_nome || "-"}</td>
                    <td style={{ ...estilos.td, color: "#475569" }}>
                      {item.operador_nome || item.operador_solicitante || "-"}
                    </td>
                    <td style={estilos.td}>{formatarMoeda(item.valor)}</td>
                    <td style={estilos.td}>
                      <span
                        style={{
                          ...estilos.badge,
                          background: cores.bg,
                          color: cores.texto,
                        }}
                      >
                        {STATUS_LABELS[item.status] || item.status}
                      </span>
                    </td>
                    <td style={{ ...estilos.td, color: atrasado ? "#b91c1c" : "#475569" }}>
                      {minutosResposta === null
                        ? "-"
                        : item.respondido_em
                        ? `${formatarDuracao(minutosResposta)} para responder`
                        : `${atrasado ? "atrasado há " : "aguardando há "}${formatarDuracao(minutosResposta)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const estilos = {
  pagina: {
    padding: "24px",
  },
  filtros: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
    alignItems: "center",
    marginBottom: "20px",
  },
  select: {
    padding: "9px 10px",
    border: "1px solid #cbd5e1",
    borderRadius: "8px",
    fontSize: "14px",
    background: "#fff",
  },
  busca: {
    padding: "9px 10px",
    border: "1px solid #cbd5e1",
    borderRadius: "8px",
    fontSize: "14px",
    flex: "1",
    minWidth: "180px",
  },
  botaoAtualizar: {
    padding: "9px 14px",
    border: "1px solid #cbd5e1",
    borderRadius: "8px",
    background: "#0f172a",
    color: "#fff",
    fontWeight: "700",
    cursor: "pointer",
  },
  erro: {
    background: "#fee2e2",
    color: "#991b1b",
    padding: "10px 14px",
    borderRadius: "8px",
    marginBottom: "16px",
    fontWeight: "700",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "12px",
    marginBottom: "20px",
  },
  cartao: {
    background: "#f1f5f9",
    borderRadius: "12px",
    padding: "16px",
  },
  rotuloCartao: {
    margin: "0 0 6px",
    fontSize: "13px",
    color: "#475569",
  },
  valorCartao: {
    margin: 0,
    fontSize: "26px",
    fontWeight: "800",
    color: "#0f172a",
  },
  cartaoGrafico: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "12px",
    padding: "16px 18px",
    marginBottom: "20px",
  },
  rotuloGrafico: {
    margin: "0 0 14px",
    fontSize: "13px",
    color: "#475569",
    fontWeight: "700",
  },
  linhaGrafico: {
    display: "grid",
    gridTemplateColumns: "130px 1fr 80px",
    alignItems: "center",
    gap: "10px",
    marginBottom: "10px",
  },
  nomeGrafico: {
    fontSize: "13px",
    color: "#0f172a",
    fontWeight: "700",
  },
  barraFundo: {
    background: "#f1f5f9",
    borderRadius: "6px",
    height: "10px",
    overflow: "hidden",
  },
  barraPreenchida: {
    height: "100%",
    borderRadius: "6px",
  },
  valorGrafico: {
    fontSize: "12px",
    color: "#475569",
    textAlign: "right",
  },
  tabelaContainer: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "12px",
    overflow: "hidden",
  },
  tabela: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "13px",
  },
  th: {
    textAlign: "left",
    padding: "12px 14px",
    color: "#475569",
    fontWeight: "700",
    borderBottom: "1px solid #e2e8f0",
    background: "#f8fafc",
  },
  tr: {
    borderBottom: "1px solid #f1f5f9",
  },
  td: {
    padding: "10px 14px",
    color: "#0f172a",
  },
  badge: {
    fontSize: "12px",
    fontWeight: "700",
    padding: "3px 10px",
    borderRadius: "999px",
  },
  textoAuxiliar: {
    padding: "24px",
    textAlign: "center",
    color: "#64748b",
  },
};
