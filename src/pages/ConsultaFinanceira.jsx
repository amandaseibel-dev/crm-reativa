import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { OPERADORES_POR_EMAIL } from "../utils/operadores";

const POR_PAGINA = 30;

const FILTROS = [
  { valor: "TODOS", label: "Todos" },
  { valor: "EM_ABERTO", label: "Em aberto" },
  { valor: "EM_ATRASO", label: "Em atraso" },
  { valor: "PAGO", label: "Pagos" },
  { valor: "PARCIAL", label: "Parciais" },
];

function formatarData(data) {
  if (!data) return "-";
  return new Date(data + "T00:00:00").toLocaleDateString("pt-BR");
}

function moeda(valor) {
  if (valor == null) return "-";
  return Number(valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const SITUACAO_LABEL = {
  EM_ABERTO: "Em aberto",
  PARCIAL: "Parcial",
  PAGO: "Pago",
};

export default function ConsultaFinanceira() {
  const [resumo, setResumo] = useState(null);
  const [filtro, setFiltro] = useState("TODOS");
  const [busca, setBusca] = useState("");
  const [valorMinimo, setValorMinimo] = useState("");
  const [operador, setOperador] = useState("");
  const [pagina, setPagina] = useState(0);
  const [linhas, setLinhas] = useState([]);
  const [totalLinhas, setTotalLinhas] = useState(0);
  const [carregando, setCarregando] = useState(true);

  function aplicarFiltros(query) {
    const buscaLimpa = busca.trim();
    const ehCpf = /^\d{3,}$/.test(buscaLimpa.replace(/\D/g, ""));

    if (filtro === "EM_ABERTO") query = query.in("situacao_geral", ["EM_ABERTO", "PARCIAL"]);
    if (filtro === "EM_ATRASO") query = query.eq("tem_atraso", true);
    if (filtro === "PAGO") query = query.eq("situacao_geral", "PAGO");
    if (filtro === "PARCIAL") query = query.eq("situacao_geral", "PARCIAL");

    if (buscaLimpa) {
      if (ehCpf) {
        query = query.ilike("cpf", `%${buscaLimpa.replace(/\D/g, "")}%`);
      } else {
        query = query.ilike("nome", `%${buscaLimpa}%`);
      }
    }

    if (valorMinimo) {
      query = query.gte("valor_em_aberto", Number(valorMinimo));
    }

    if (operador === "__SEM__") {
      query = query.is("responsavel_atual_email", null);
    } else if (operador) {
      query = query.eq("responsavel_atual_email", operador);
    }

    return query;
  }

  useEffect(() => {
    carregarLinhas(pagina);
    carregarResumoFiltrado();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtro, pagina, operador]);

  async function buscar() {
    setPagina(0);
    await carregarLinhas(0);
    await carregarResumoFiltrado();
  }

  // Quando tem operador (ou qualquer filtro) selecionado, os cards passam a
  // mostrar o total daquele recorte, não o total geral da base. Usa RPC
  // (agregacao exata no banco) em vez de buscar todas as linhas no
  // navegador, que cortava em ~100-1000 linhas e distorcia os totais.
  async function carregarResumoFiltrado() {
    const buscaLimpa = busca.trim();
    const ehCpf = /^\d{3,}$/.test(buscaLimpa.replace(/\D/g, ""));

    const { data } = await supabase.rpc("resumo_financeiro_filtrado", {
      p_filtro: filtro === "TODOS" ? null : filtro,
      p_busca: buscaLimpa
        ? ehCpf
          ? buscaLimpa.replace(/\D/g, "")
          : buscaLimpa
        : null,
      p_eh_cpf: ehCpf,
      p_valor_minimo: valorMinimo ? Number(valorMinimo) : null,
      p_operador: operador || null,
    });

    setResumo({
      total_alunos: data?.total_alunos || 0,
      total_em_aberto: data?.total_em_aberto || 0,
      total_em_atraso: data?.total_em_atraso || 0,
      total_pagos: data?.total_pagos || 0,
      total_parcial: data?.total_parcial || 0,
      valor_em_aberto: data?.valor_em_aberto || 0,
      valor_em_atraso: data?.valor_em_atraso || 0,
    });
  }

  async function carregarLinhas(paginaAtual) {
    setCarregando(true);

    let query = supabase
      .from("consulta_financeira_por_aluno")
      .select("*", { count: "exact" });

    query = aplicarFiltros(query);

    query = query
      .order("valor_em_aberto", { ascending: false })
      .range(paginaAtual * POR_PAGINA, paginaAtual * POR_PAGINA + POR_PAGINA - 1);

    const { data, count } = await query;
    setLinhas(data || []);
    setTotalLinhas(count || 0);
    setCarregando(false);
  }

  return (
    <div className="main">
      <h1>Financeiro</h1>
      <p style={{ opacity: 0.75, marginBottom: 20 }}>
        Consulta agrupada por aluno, somando o valor em aberto de todos os títulos
        importados pelos borderôs.
      </p>

      {resumo && (
        <div style={estilos.grade}>
          <div style={estilos.cartao}>
            <div style={estilos.numero}>{resumo.total_alunos}</div>
            <div style={estilos.label}>Alunos com título</div>
          </div>
          <div style={{ ...estilos.cartao, background: "rgba(251,191,36,0.1)" }}>
            <div style={{ ...estilos.numero, color: "#fcd34d" }}>
              {moeda(resumo.valor_em_aberto)}
            </div>
            <div style={estilos.label}>Em aberto ({resumo.total_em_aberto} alunos)</div>
          </div>
          <div style={{ ...estilos.cartao, background: "rgba(239,68,68,0.1)" }}>
            <div style={{ ...estilos.numero, color: "#fca5a5" }}>
              {moeda(resumo.valor_em_atraso)}
            </div>
            <div style={estilos.label}>Em atraso ({resumo.total_em_atraso} alunos)</div>
          </div>
          <div style={{ ...estilos.cartao, background: "rgba(56,189,248,0.1)" }}>
            <div style={{ ...estilos.numero, color: "#7dd3fc" }}>{resumo.total_parcial}</div>
            <div style={estilos.label}>Parciais</div>
          </div>
          <div style={{ ...estilos.cartao, background: "rgba(34,197,94,0.1)" }}>
            <div style={{ ...estilos.numero, color: "#86efac" }}>{resumo.total_pagos}</div>
            <div style={estilos.label}>Pagos</div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, margin: "20px 0 12px", flexWrap: "wrap" }}>
        {FILTROS.map((f) => (
          <button
            key={f.valor}
            type="button"
            onClick={() => {
              setFiltro(f.valor);
              setPagina(0);
            }}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border:
                filtro === f.valor
                  ? "1px solid rgba(59,130,246,0.7)"
                  : "1px solid rgba(148,163,184,0.35)",
              background: filtro === f.valor ? "rgba(59,130,246,0.15)" : "transparent",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Nome ou CPF do aluno"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && buscar()}
          style={{ padding: "6px 10px", borderRadius: 8, minWidth: 200 }}
        />
        <input
          type="number"
          placeholder="Valor mínimo (R$)"
          value={valorMinimo}
          onChange={(e) => setValorMinimo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && buscar()}
          style={{ padding: "6px 10px", borderRadius: 8, width: 150 }}
        />
        <select
          value={operador}
          onChange={(e) => setOperador(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 8 }}
        >
          <option value="">Todos os operadores</option>
          <option value="__SEM__">Sem responsável</option>
          {Object.entries(OPERADORES_POR_EMAIL).map(([email, nome]) => (
            <option key={email} value={email}>
              {nome}
            </option>
          ))}
        </select>
        <button type="button" onClick={buscar}>
          Filtrar
        </button>
      </div>

      {carregando ? (
        <p>Carregando...</p>
      ) : linhas.length === 0 ? (
        <p>Nenhum aluno encontrado com esse filtro.</p>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(148,163,184,0.3)" }}>
                  <th style={{ padding: "8px 10px" }}>Aluno</th>
                  <th style={{ padding: "8px 10px" }}>Operador</th>
                  <th style={{ padding: "8px 10px" }}>Títulos</th>
                  <th style={{ padding: "8px 10px" }}>Próx. vencimento</th>
                  <th style={{ padding: "8px 10px" }}>Valor em aberto</th>
                  <th style={{ padding: "8px 10px" }}>Situação</th>
                  <th style={{ padding: "8px 10px" }}></th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((linha) => (
                  <tr
                    key={linha.aluno_id}
                    onClick={() => window.open(`/aluno?alunoId=${linha.aluno_id}`, "_blank")}
                    title="Clique para abrir a ficha do aluno"
                    style={{ borderBottom: "1px solid rgba(148,163,184,0.12)", cursor: "pointer" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(15,157,107,0.06)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ padding: "8px 10px" }}>{linha.nome}</td>
                    <td style={{ padding: "8px 10px", opacity: 0.8 }}>
                      {linha.responsavel_atual_nome || "-"}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {linha.qtd_em_aberto}
                      {linha.qtd_pagos > 0 ? ` (+${linha.qtd_pagos} pagos)` : ""}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {formatarData(linha.proximo_vencimento)}
                      {linha.tem_atraso && (
                        <span style={{ color: "#fca5a5", marginLeft: 6, fontSize: 11 }}>
                          atrasado
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "8px 10px", fontWeight: 700 }}>
                      {moeda(linha.valor_em_aberto)}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {SITUACAO_LABEL[linha.situacao_geral] || linha.situacao_geral}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(`/aluno?alunoId=${linha.aluno_id}`, "_blank");
                        }}
                        style={{
                          background: "#0f9d6b",
                          color: "#fff",
                          border: "none",
                          borderRadius: 8,
                          padding: "5px 12px",
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Abrir ficha
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
            <button
              type="button"
              disabled={pagina === 0}
              onClick={() => setPagina((p) => Math.max(0, p - 1))}
            >
              Anterior
            </button>
            <span style={{ fontSize: 13, opacity: 0.75 }}>
              Página {pagina + 1} de {Math.max(1, Math.ceil(totalLinhas / POR_PAGINA))} (
              {totalLinhas} alunos)
            </span>
            <button
              type="button"
              disabled={(pagina + 1) * POR_PAGINA >= totalLinhas}
              onClick={() => setPagina((p) => p + 1)}
            >
              Próxima
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const estilos = {
  grade: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: 12,
  },
  cartao: {
    padding: 16,
    borderRadius: 10,
    background: "rgba(148,163,184,0.08)",
  },
  numero: {
    fontSize: 22,
    fontWeight: 800,
  },
  label: {
    fontSize: 12,
    opacity: 0.75,
    marginTop: 4,
  },
};
