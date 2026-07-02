import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { podeVerTudo } from "../utils/operadores";

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

function chaveDia(dataIso) {
  if (!dataIso) return null;
  return String(dataIso).slice(0, 10);
}

function formatarTabulacao(valor) {
  if (!valor) return "-";
  return String(valor)
    .split("_")
    .map((parte) => parte.charAt(0) + parte.slice(1).toLowerCase())
    .join(" ");
}

function formatarDiaBR(chave) {
  if (!chave) return "-";
  const [ano, mes, dia] = chave.split("-");
  return `${dia}/${mes}`;
}

export default function RelatorioTabulacoes() {
  const [usuario, setUsuario] = useState(null);
  const [movimentacoes, setMovimentacoes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [periodo, setPeriodo] = useState("SEMANA");

  useEffect(() => {
    carregarUsuario();
  }, []);

  useEffect(() => {
    if (usuario) carregarMovimentacoes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usuario, periodo]);

  async function carregarUsuario() {
    try {
      try {
        await supabase.auth.getSession();
      } catch {}

      const { data, error } = await supabase.auth.getUser();

      if (error || !data?.user) {
        setErro(
          "Sua sessão expirou (a tela ficou muito tempo parada). Atualize a página (F5) para continuar."
        );
        setCarregando(false);
        return;
      }

      setUsuario(data.user);
    } catch (e) {
      console.error("Erro ao carregar usuário:", e);
      setErro(
        "Sua sessão expirou (a tela ficou muito tempo parada). Atualize a página (F5) para continuar."
      );
      setCarregando(false);
    }
  }

  async function carregarMovimentacoes() {
    setCarregando(true);
    setErro("");

    const desde = inicioPeriodo(periodo);
    const emailUsuario = usuario?.email || "";
    const vejoTudo = podeVerTudo(emailUsuario);

    let query = supabase
      .from("aluno_movimentacoes")
      .select("registrado_por_nome, registrado_por_email, registrado_em, status_novo")
      .eq("tipo", "FINALIZACAO_ATENDIMENTO")
      .order("registrado_em", { ascending: false })
      .limit(20000);

    if (desde) {
      query = query.gte("registrado_em", desde.toISOString());
    }

    // Operador comum só vê a própria contagem -- gestão/ADM/supervisão vê
    // o ranking de todo mundo.
    if (!vejoTudo) {
      query = query.eq("registrado_por_email", emailUsuario);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Erro ao carregar tabulações:", error);
      setErro("Não foi possível carregar as tabulações.");
      setCarregando(false);
      return;
    }

    setMovimentacoes(data || []);
    setCarregando(false);
  }

  const emailUsuario = usuario?.email || "";
  const vejoTudo = podeVerTudo(emailUsuario);
  const hojeChave = chaveDia(new Date().toISOString());

  const porOperador = useMemo(() => {
    const mapa = new Map();

    for (const m of movimentacoes) {
      const nome = m.registrado_por_nome || m.registrado_por_email || "Sem operador";
      const dia = chaveDia(m.registrado_em);
      if (!dia) continue;

      if (!mapa.has(nome)) {
        mapa.set(nome, { nome, total: 0, dias: new Set(), hoje: 0 });
      }

      const registro = mapa.get(nome);
      registro.total += 1;
      registro.dias.add(dia);
      if (dia === hojeChave) registro.hoje += 1;
    }

    return [...mapa.values()]
      .map((r) => ({
        nome: r.nome,
        total: r.total,
        hoje: r.hoje,
        diasAtivos: r.dias.size,
        media: r.dias.size > 0 ? Math.round((r.total / r.dias.size) * 10) / 10 : 0,
      }))
      .sort((a, b) => b.total - a.total);
  }, [movimentacoes, hojeChave]);

  const porTipo = useMemo(() => {
    const mapa = new Map();

    for (const m of movimentacoes) {
      const chave = m.status_novo || "SEM_TABULACAO";
      mapa.set(chave, (mapa.get(chave) || 0) + 1);
    }

    return [...mapa.entries()]
      .map(([tipo, qtd]) => ({ tipo, qtd }))
      .sort((a, b) => b.qtd - a.qtd);
  }, [movimentacoes]);

  const porDia = useMemo(() => {
    const mapa = new Map();

    for (const m of movimentacoes) {
      const dia = chaveDia(m.registrado_em);
      if (!dia) continue;
      mapa.set(dia, (mapa.get(dia) || 0) + 1);
    }

    return [...mapa.entries()]
      .map(([dia, qtd]) => ({ dia, qtd }))
      .sort((a, b) => (a.dia < b.dia ? 1 : -1))
      .slice(0, 14);
  }, [movimentacoes]);

  const totalPeriodo = movimentacoes.length;
  const totalHoje = movimentacoes.filter((m) => chaveDia(m.registrado_em) === hojeChave).length;
  const mediaGeral =
    porOperador.length > 0
      ? Math.round((porOperador.reduce((soma, o) => soma + o.media, 0) / porOperador.length) * 10) / 10
      : 0;

  return (
    <div style={estilos.pagina}>
      <h1 style={estilos.titulo}>Tabulações da operação</h1>
      <p style={estilos.subtitulo}>
        {vejoTudo
          ? "Contagem de tabulações registradas por cada operador (ranking geral)."
          : "Sua contagem de tabulações registradas."}
      </p>

      <div style={estilos.filtros}>
        <select value={periodo} onChange={(e) => setPeriodo(e.target.value)} style={estilos.select}>
          <option value="HOJE">Hoje</option>
          <option value="SEMANA">Esta semana</option>
          <option value="MES">Este mês</option>
          <option value="TODOS">Tudo</option>
        </select>

        <button type="button" onClick={carregarMovimentacoes} style={estilos.botaoAtualizar}>
          Atualizar
        </button>
      </div>

      {erro && <div style={estilos.erro}>{erro}</div>}

      <div style={estilos.grid}>
        <div style={estilos.cartao}>
          <p style={estilos.rotuloCartao}>Tabulações hoje</p>
          <p style={estilos.valorCartao}>{totalHoje}</p>
        </div>
        <div style={estilos.cartao}>
          <p style={estilos.rotuloCartao}>Tabulações no período</p>
          <p style={estilos.valorCartao}>{totalPeriodo}</p>
        </div>
        {vejoTudo && (
          <div style={estilos.cartao}>
            <p style={estilos.rotuloCartao}>Média por operador/dia</p>
            <p style={estilos.valorCartao}>{mediaGeral}</p>
          </div>
        )}
        {vejoTudo && (
          <div style={estilos.cartao}>
            <p style={estilos.rotuloCartao}>Operadores ativos no período</p>
            <p style={estilos.valorCartao}>{porOperador.length}</p>
          </div>
        )}
      </div>

      {carregando ? (
        <p style={estilos.textoAuxiliar}>Carregando...</p>
      ) : (
        <>
          {vejoTudo && (
            <div style={estilos.tabelaContainer}>
              <h2 style={estilos.tituloSecao}>Ranking por operador</h2>

              {porOperador.length === 0 ? (
                <p style={estilos.textoAuxiliar}>Nenhuma tabulação nesse período.</p>
              ) : (
                <table style={estilos.tabela}>
                  <thead>
                    <tr>
                      <th style={estilos.th}>Operador</th>
                      <th style={estilos.th}>Hoje</th>
                      <th style={estilos.th}>Total no período</th>
                      <th style={estilos.th}>Dias ativos</th>
                      <th style={estilos.th}>Média por dia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {porOperador.map((o) => (
                      <tr key={o.nome} style={estilos.tr}>
                        <td style={estilos.td}>{o.nome}</td>
                        <td style={estilos.td}>{o.hoje}</td>
                        <td style={estilos.td}>{o.total}</td>
                        <td style={estilos.td}>{o.diasAtivos}</td>
                        <td style={estilos.td}>{o.media}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {!vejoTudo && porOperador.length > 0 && (
            <div style={estilos.tabelaContainer}>
              <h2 style={estilos.tituloSecao}>Sua contagem</h2>
              <table style={estilos.tabela}>
                <thead>
                  <tr>
                    <th style={estilos.th}>Hoje</th>
                    <th style={estilos.th}>Total no período</th>
                    <th style={estilos.th}>Dias ativos</th>
                    <th style={estilos.th}>Média por dia</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={estilos.tr}>
                    <td style={estilos.td}>{porOperador[0].hoje}</td>
                    <td style={estilos.td}>{porOperador[0].total}</td>
                    <td style={estilos.td}>{porOperador[0].diasAtivos}</td>
                    <td style={estilos.td}>{porOperador[0].media}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div style={estilos.duasColunas}>
            <div style={estilos.tabelaContainer}>
              <h2 style={estilos.tituloSecao}>Por tipo de tabulação</h2>

              {porTipo.length === 0 ? (
                <p style={estilos.textoAuxiliar}>Sem dados nesse período.</p>
              ) : (
                <table style={estilos.tabela}>
                  <thead>
                    <tr>
                      <th style={estilos.th}>Tabulação</th>
                      <th style={estilos.th}>Quantidade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {porTipo.map((t) => (
                      <tr key={t.tipo} style={estilos.tr}>
                        <td style={estilos.td}>{formatarTabulacao(t.tipo)}</td>
                        <td style={estilos.td}>{t.qtd}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={estilos.tabelaContainer}>
              <h2 style={estilos.tituloSecao}>Últimos dias</h2>

              {porDia.length === 0 ? (
                <p style={estilos.textoAuxiliar}>Sem dados nesse período.</p>
              ) : (
                <table style={estilos.tabela}>
                  <thead>
                    <tr>
                      <th style={estilos.th}>Dia</th>
                      <th style={estilos.th}>Quantidade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {porDia.map((d) => (
                      <tr key={d.dia} style={estilos.tr}>
                        <td style={estilos.td}>{formatarDiaBR(d.dia)}</td>
                        <td style={estilos.td}>{d.qtd}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const estilos = {
  pagina: {
    padding: "24px",
  },
  titulo: {
    margin: "0 0 6px",
    color: "#0f172a",
  },
  subtitulo: {
    margin: "0 0 20px",
    color: "#475569",
  },
  filtros: {
    display: "flex",
    gap: "10px",
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
  tabelaContainer: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "12px",
    overflow: "hidden",
    padding: "16px",
    marginBottom: "20px",
  },
  tituloSecao: {
    margin: "0 0 12px",
    fontSize: "16px",
    color: "#0f172a",
  },
  duasColunas: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: "16px",
  },
  tabela: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "13px",
  },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    color: "#475569",
    fontWeight: "700",
    borderBottom: "1px solid #e2e8f0",
    background: "#f8fafc",
  },
  tr: {
    borderBottom: "1px solid #f1f5f9",
  },
  td: {
    padding: "9px 12px",
    color: "#0f172a",
  },
  textoAuxiliar: {
    padding: "16px",
    textAlign: "center",
    color: "#64748b",
  },
};
