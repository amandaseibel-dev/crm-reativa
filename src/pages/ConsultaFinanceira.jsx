import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const POR_PAGINA = 30;

const FILTROS = [
  { valor: "TODOS", label: "Todos" },
  { valor: "EM_ABERTO", label: "Em aberto" },
  { valor: "EM_ATRASO", label: "Em atraso" },
  { valor: "EM_DIA", label: "Em dia" },
  { valor: "PAGO", label: "Pagos" },
];

function formatarData(data) {
  if (!data) return "-";
  return new Date(data + "T00:00:00").toLocaleDateString("pt-BR");
}

function moeda(valor) {
  if (valor == null) return "-";
  return Number(valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function ConsultaFinanceira() {
  const [resumo, setResumo] = useState(null);
  const [filtro, setFiltro] = useState("TODOS");
  const [busca, setBusca] = useState("");
  const [pagina, setPagina] = useState(0);
  const [linhas, setLinhas] = useState([]);
  const [totalLinhas, setTotalLinhas] = useState(0);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    async function carregarResumo() {
      const { data } = await supabase.rpc("resumo_financeiro");
      setResumo(data?.[0] || null);
    }
    carregarResumo();
  }, []);

  useEffect(() => {
    carregarLinhas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtro, pagina]);

  async function buscar() {
    setPagina(0);
    await carregarLinhas(0);
  }

  async function carregarLinhas(paginaForcada) {
    setCarregando(true);
    const paginaAtual = paginaForcada ?? pagina;
    const hoje = new Date().toISOString().slice(0, 10);

    const buscaLimpa = busca.trim();
    const ehCpf = /^\d{3,}$/.test(buscaLimpa.replace(/\D/g, ""));

    let query = supabase
      .from("acordos_titulos")
      .select(
        "documento, vencimento, valor_original, saldo_corrigido, situacao, tipo_boleto, cpf, alunos!inner(nome, cpf, telefone)",
        { count: "exact" }
      );

    if (filtro === "EM_ABERTO") query = query.neq("situacao", "PAGO");
    if (filtro === "EM_ATRASO") query = query.neq("situacao", "PAGO").lt("vencimento", hoje);
    if (filtro === "EM_DIA") query = query.neq("situacao", "PAGO").gte("vencimento", hoje);
    if (filtro === "PAGO") query = query.eq("situacao", "PAGO");

    if (buscaLimpa) {
      if (ehCpf) {
        query = query.ilike("cpf", `%${buscaLimpa.replace(/\D/g, "")}%`);
      } else {
        query = query.ilike("alunos.nome", `%${buscaLimpa}%`);
      }
    }

    query = query
      .order("vencimento", { ascending: true })
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
        Consulta dos títulos importados pelos borderôs — mensalidades e acordos em aberto.
      </p>

      {resumo && (
        <div style={estilos.grade}>
          <div style={estilos.cartao}>
            <div style={estilos.numero}>{resumo.total_titulos}</div>
            <div style={estilos.label}>Total de títulos</div>
          </div>
          <div style={{ ...estilos.cartao, background: "rgba(251,191,36,0.1)" }}>
            <div style={{ ...estilos.numero, color: "#fcd34d" }}>
              {moeda(resumo.valor_em_aberto)}
            </div>
            <div style={estilos.label}>Em aberto ({resumo.total_em_aberto})</div>
          </div>
          <div style={{ ...estilos.cartao, background: "rgba(239,68,68,0.1)" }}>
            <div style={{ ...estilos.numero, color: "#fca5a5" }}>
              {moeda(resumo.valor_em_atraso)}
            </div>
            <div style={estilos.label}>Em atraso ({resumo.total_em_atraso})</div>
          </div>
          <div style={{ ...estilos.cartao, background: "rgba(56,189,248,0.1)" }}>
            <div style={{ ...estilos.numero, color: "#7dd3fc" }}>{resumo.total_em_dia}</div>
            <div style={estilos.label}>Em dia</div>
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

        <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          <input
            type="text"
            placeholder="Nome ou CPF do aluno"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && buscar()}
            style={{ padding: "6px 10px", borderRadius: 8, minWidth: 220 }}
          />
          <button type="button" onClick={buscar} style={{ padding: "6px 14px" }}>
            Buscar
          </button>
        </div>
      </div>

      {carregando ? (
        <p>Carregando...</p>
      ) : linhas.length === 0 ? (
        <p>Nenhum título encontrado com esse filtro.</p>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(148,163,184,0.3)" }}>
                  <th style={{ padding: "8px 10px" }}>Aluno</th>
                  <th style={{ padding: "8px 10px" }}>Título</th>
                  <th style={{ padding: "8px 10px" }}>Vencimento</th>
                  <th style={{ padding: "8px 10px" }}>Valor</th>
                  <th style={{ padding: "8px 10px" }}>Situação</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((linha) => (
                  <tr
                    key={linha.documento}
                    style={{ borderBottom: "1px solid rgba(148,163,184,0.12)" }}
                  >
                    <td style={{ padding: "8px 10px" }}>{linha.alunos?.nome}</td>
                    <td style={{ padding: "8px 10px", opacity: 0.7 }}>{linha.documento}</td>
                    <td style={{ padding: "8px 10px" }}>{formatarData(linha.vencimento)}</td>
                    <td style={{ padding: "8px 10px" }}>
                      {moeda(linha.saldo_corrigido ?? linha.valor_original)}
                    </td>
                    <td style={{ padding: "8px 10px" }}>{linha.situacao}</td>
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
              {totalLinhas} títulos)
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
