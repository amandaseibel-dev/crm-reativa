import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function formatarData(data) {
  if (!data) return "-";
  return new Date(data).toLocaleString("pt-BR");
}

export default function Importacoes() {
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [filtro, setFiltro] = useState("PROBLEMAS");

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);
    setErro("");

    const { data, error } = await supabase.rpc("relatorio_importacoes_bordero");

    if (error) {
      setErro("Erro ao carregar importações: " + error.message);
      setCarregando(false);
      return;
    }

    // Um mesmo número de bordero pode ter sido importado mais de uma vez
    // (reprocessamento manual). Nesse caso, o registro mais antigo aparece
    // "zerado" porque os títulos ficaram vinculados à importação mais
    // recente -- não é dado perdido, é só reprocessamento. Agrupa por
    // referência e soma antes de decidir se falta alguma coisa de verdade.
    const porReferencia = {};
    for (const linha of data || []) {
      const chave = linha.referencia;
      if (!porReferencia[chave]) {
        porReferencia[chave] = {
          referencia: chave,
          arquivo_nome: linha.arquivo_nome,
          status: linha.status,
          usuario: linha.usuario,
          criado_em: linha.criado_em,
          qtd_registros: linha.qtd_registros,
          titulos_gravados: 0,
          tentativas: 0,
          travado: false,
        };
      }
      const agregado = porReferencia[chave];
      agregado.titulos_gravados += Number(linha.titulos_gravados) || 0;
      agregado.tentativas += 1;
      if (linha.status !== "CONCLUIDO") agregado.travado = true;
      // fica com a data mais recente entre as tentativas
      if (new Date(linha.criado_em) > new Date(agregado.criado_em)) {
        agregado.criado_em = linha.criado_em;
        agregado.qtd_registros = linha.qtd_registros;
      }
    }

    const linhasAgrupadas = Object.values(porReferencia)
      .map((l) => ({ ...l, faltando: l.qtd_registros - l.titulos_gravados }))
      .sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));

    setLinhas(linhasAgrupadas);
    setCarregando(false);
  }

  const linhasFiltradas = linhas.filter((l) => {
    if (filtro === "TODOS") return true;
    if (filtro === "PROBLEMAS") return l.faltando !== 0 || l.travado;
    if (filtro === "TRAVADOS") return l.travado;
    return true;
  });

  const totalProblemas = linhas.filter((l) => l.faltando !== 0 || l.travado).length;
  const totalTravados = linhas.filter((l) => l.travado).length;
  const totalFaltando = linhas.reduce((soma, l) => soma + Math.max(0, l.faltando), 0);

  return (
    <div className="main">
      <h1>Importações de Borderô</h1>
      <p style={{ opacity: 0.75, marginBottom: 20 }}>
        Compara quantas linhas cada bordero tinha no arquivo com quantas realmente foram
        salvas no sistema -- pra achar rápido qualquer importação que ficou incompleta.
      </p>

      <div style={estilos.grade}>
        <div style={estilos.cartao}>
          <div style={estilos.numero}>{linhas.length}</div>
          <div style={estilos.label}>Borderôs importados</div>
        </div>
        <div style={{ ...estilos.cartao, background: totalProblemas > 0 ? "rgba(239,68,68,0.1)" : "rgba(34,197,94,0.1)" }}>
          <div style={{ ...estilos.numero, color: totalProblemas > 0 ? "#f87171" : "#86efac" }}>
            {totalProblemas}
          </div>
          <div style={estilos.label}>Com problema</div>
        </div>
        <div style={{ ...estilos.cartao, background: totalTravados > 0 ? "rgba(251,191,36,0.1)" : undefined }}>
          <div style={{ ...estilos.numero, color: totalTravados > 0 ? "#fcd34d" : undefined }}>
            {totalTravados}
          </div>
          <div style={estilos.label}>Travados (nunca concluíram)</div>
        </div>
        <div style={estilos.cartao}>
          <div style={estilos.numero}>{totalFaltando}</div>
          <div style={estilos.label}>Registros faltando no total</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <button style={filtro === "PROBLEMAS" ? estilos.filtroAtivo : estilos.filtro} onClick={() => setFiltro("PROBLEMAS")}>
          Só com problema
        </button>
        <button style={filtro === "TRAVADOS" ? estilos.filtroAtivo : estilos.filtro} onClick={() => setFiltro("TRAVADOS")}>
          Só travados
        </button>
        <button style={filtro === "TODOS" ? estilos.filtroAtivo : estilos.filtro} onClick={() => setFiltro("TODOS")}>
          Todos
        </button>
        <button style={estilos.botaoAtualizar} onClick={carregar} disabled={carregando}>
          {carregando ? "Atualizando..." : "Atualizar"}
        </button>
      </div>

      {erro && <p style={{ color: "#f87171" }}>{erro}</p>}

      {carregando ? (
        <p style={{ opacity: 0.7 }}>Carregando...</p>
      ) : linhasFiltradas.length === 0 ? (
        <p style={{ opacity: 0.7 }}>
          {filtro === "PROBLEMAS" ? "Nenhum problema encontrado. Tudo certinho." : "Nenhuma importação nesse filtro."}
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(148,163,184,0.3)" }}>
                <th style={{ padding: "8px 10px" }}>Bordero</th>
                <th style={{ padding: "8px 10px" }}>Arquivo</th>
                <th style={{ padding: "8px 10px" }}>Data</th>
                <th style={{ padding: "8px 10px" }}>Esperado</th>
                <th style={{ padding: "8px 10px" }}>Salvo</th>
                <th style={{ padding: "8px 10px" }}>Faltando</th>
                <th style={{ padding: "8px 10px" }}>Situação</th>
              </tr>
            </thead>
            <tbody>
              {linhasFiltradas.map((l) => (
                <tr key={l.referencia} style={{ borderBottom: "1px solid rgba(148,163,184,0.12)" }}>
                  <td style={{ padding: "8px 10px", fontWeight: 700 }}>{l.referencia}</td>
                  <td style={{ padding: "8px 10px", opacity: 0.8 }}>{l.arquivo_nome}</td>
                  <td style={{ padding: "8px 10px" }}>{formatarData(l.criado_em)}</td>
                  <td style={{ padding: "8px 10px" }}>{l.qtd_registros}</td>
                  <td style={{ padding: "8px 10px" }}>{l.titulos_gravados}</td>
                  <td style={{ padding: "8px 10px", fontWeight: 700, color: l.faltando > 0 ? "#f87171" : "inherit" }}>
                    {l.faltando > 0 ? l.faltando : "-"}
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    {l.travado ? (
                      <span style={estilos.tagAmarela}>Travado (reenviar)</span>
                    ) : l.faltando > 0 ? (
                      <span style={estilos.tagVermelha}>Incompleto (reenviar)</span>
                    ) : (
                      <span style={estilos.tagVerde}>Completo</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const estilos = {
  grade: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: 12,
  },
  cartao: {
    padding: 16,
    borderRadius: 10,
    background: "rgba(148,163,184,0.08)",
  },
  numero: { fontSize: 24, fontWeight: 800 },
  label: { fontSize: 12, opacity: 0.75, marginTop: 4 },
  filtro: {
    padding: "6px 14px",
    borderRadius: 8,
    border: "1px solid rgba(148,163,184,0.3)",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: 13,
  },
  filtroAtivo: {
    padding: "6px 14px",
    borderRadius: 8,
    border: "1px solid rgba(56,189,248,0.6)",
    background: "rgba(56,189,248,0.16)",
    color: "#7dd3fc",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 700,
  },
  botaoAtualizar: {
    marginLeft: "auto",
    padding: "6px 14px",
    borderRadius: 8,
    border: "1px solid rgba(148,163,184,0.3)",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: 13,
  },
  tagVerde: {
    background: "rgba(34,197,94,0.16)",
    color: "#86efac",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  tagAmarela: {
    background: "rgba(251,191,36,0.16)",
    color: "#fcd34d",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  tagVermelha: {
    background: "rgba(239,68,68,0.16)",
    color: "#f87171",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
};
