import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const OPERADORES = [
  { nome: "Olga", email: "cobranca03@aelbra.com.br" },
  { nome: "Fernanda", email: "cobranca04@aelbra.com.br" },
  { nome: "Luana", email: "cobranca05@aelbra.com.br" },
  { nome: "Mauricio", email: "cobranca06@aelbra.com.br" },
  { nome: "Amanda ADM", email: "cobranca07@aelbra.com.br" },
  { nome: "Natali", email: "cobranca08@aelbra.com.br" },
  { nome: "João", email: "cobranca10@aelbra.com.br" },
  { nome: "Allan", email: "cobranca11@aelbra.com.br" },
  { nome: "Rafaella", email: "cobranca12@aelbra.com.br" },
  { nome: "Diego", email: "cobranca13@aelbra.com.br" },
];

function formatarDataHora(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

export default function ElogiosAtendimento() {
  const [carregando, setCarregando] = useState(true);
  const [elogios, setElogios] = useState([]);
  const [filtroOperador, setFiltroOperador] = useState("TODOS");
  const [busca, setBusca] = useState("");

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);

    const { data, error } = await supabase
      .from("aluno_movimentacoes")
      .select("id, aluno_id, descricao, registrado_por_nome, registrado_por_email, registrado_em, elogio_print_path, elogio_print_nome, elogio_aprovado_tv, elogio_aprovado_por, elogio_aprovado_em, elogio_rejeitado_tv, elogio_rejeitado_por, elogio_rejeitado_em")
      .eq("tipo", "FINALIZACAO_ATENDIMENTO")
      .eq("status_novo", "ELOGIO_ATENDIMENTO")
      .order("registrado_em", { ascending: false })
      .limit(500);

    if (error) {
      console.error("Erro ao carregar elogios:", error);
      setCarregando(false);
      return;
    }

    const lista = data || [];

    const idsAlunos = [...new Set(lista.map((m) => m.aluno_id).filter(Boolean))];
    let nomesPorId = {};
    if (idsAlunos.length > 0) {
      const { data: alunos } = await supabase
        .from("alunos")
        .select("id, nome")
        .in("id", idsAlunos);
      nomesPorId = Object.fromEntries((alunos || []).map((a) => [String(a.id), a.nome]));
    }

    setElogios(lista.map((m) => ({ ...m, aluno_nome: nomesPorId[String(m.aluno_id)] || "Aluno" })));
    setCarregando(false);
  }

  async function abrirAnexo(path) {
    const { data, error } = await supabase.storage
      .from("elogios-prints")
      .createSignedUrl(path, 3600);

    if (error || !data?.signedUrl) {
      alert("Erro ao abrir o anexo: " + (error?.message || "não encontrado"));
      return;
    }

    window.open(data.signedUrl, "_blank");
  }

  async function alternarAprovacao(elogio) {
    const { data: userData } = await supabase.auth.getUser();
    const email = userData?.user?.email || "";
    const aprovarAgora = !elogio.elogio_aprovado_tv;

    const { error } = await supabase
      .from("aluno_movimentacoes")
      .update({
        elogio_aprovado_tv: aprovarAgora,
        elogio_aprovado_por: aprovarAgora ? email : null,
        elogio_aprovado_em: aprovarAgora ? new Date().toISOString() : null,
        // Aprovar sempre limpa uma rejeição anterior, pra não ficar com os
        // dois estados marcados ao mesmo tempo.
        elogio_rejeitado_tv: false,
        elogio_rejeitado_por: null,
        elogio_rejeitado_em: null,
      })
      .eq("id", elogio.id);

    if (error) {
      alert("Erro ao aprovar elogio: " + error.message);
      return;
    }

    setElogios((atual) =>
      atual.map((e) =>
        e.id === elogio.id
          ? {
              ...e,
              elogio_aprovado_tv: aprovarAgora,
              elogio_aprovado_por: aprovarAgora ? email : null,
              elogio_rejeitado_tv: false,
            }
          : e
      )
    );
  }

  async function alternarRejeicao(elogio) {
    const { data: userData } = await supabase.auth.getUser();
    const email = userData?.user?.email || "";
    const rejeitarAgora = !elogio.elogio_rejeitado_tv;

    const { error } = await supabase
      .from("aluno_movimentacoes")
      .update({
        elogio_rejeitado_tv: rejeitarAgora,
        elogio_rejeitado_por: rejeitarAgora ? email : null,
        elogio_rejeitado_em: rejeitarAgora ? new Date().toISOString() : null,
        // Rejeitar sempre tira da TV, pra não ficar aprovado e rejeitado
        // ao mesmo tempo.
        elogio_aprovado_tv: false,
        elogio_aprovado_por: null,
        elogio_aprovado_em: null,
      })
      .eq("id", elogio.id);

    if (error) {
      alert("Erro ao rejeitar elogio: " + error.message);
      return;
    }

    setElogios((atual) =>
      atual.map((e) =>
        e.id === elogio.id
          ? {
              ...e,
              elogio_rejeitado_tv: rejeitarAgora,
              elogio_rejeitado_por: rejeitarAgora ? email : null,
              elogio_aprovado_tv: false,
            }
          : e
      )
    );
  }

  const filtrados = elogios.filter((e) => {
    if (filtroOperador !== "TODOS" && e.registrado_por_email !== filtroOperador) return false;
    if (busca.trim()) {
      const termo = busca.toLowerCase();
      if (
        !String(e.aluno_nome || "").toLowerCase().includes(termo) &&
        !String(e.registrado_por_nome || "").toLowerCase().includes(termo) &&
        !String(e.descricao || "").toLowerCase().includes(termo)
      ) {
        return false;
      }
    }
    return true;
  });

  const comAnexo = filtrados.filter((e) => e.elogio_print_path).length;

  if (carregando) {
    return <div style={estilos.container}>Carregando elogios de atendimento...</div>;
  }

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <div>
          <h1 style={estilos.titulo}>💚 Elogios de Atendimento</h1>
          <p style={estilos.subtitulo}>
            Todos os elogios registrados pela equipe, automaticamente — sem depender de ninguém avisar.
          </p>
        </div>
        <button style={estilos.botaoAtualizar} onClick={carregar}>
          Atualizar
        </button>
      </div>

      <div style={estilos.grid}>
        <div style={estilos.card}>
          <span style={estilos.numero}>{filtrados.length}</span>
          <span style={estilos.descricao}>Elogios (com filtro atual)</span>
        </div>
        <div style={estilos.card}>
          <span style={estilos.numero}>{comAnexo}</span>
          <span style={estilos.descricao}>Com print anexado</span>
        </div>
        <div style={estilos.card}>
          <span style={estilos.numero}>{filtrados.filter((e) => e.elogio_aprovado_tv).length}</span>
          <span style={estilos.descricao}>Aprovados para a TV</span>
        </div>
      </div>

      <div style={estilos.filtros}>
        <input
          style={estilos.input}
          placeholder="Buscar por aluno, operador ou observação..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <select
          style={estilos.select}
          value={filtroOperador}
          onChange={(e) => setFiltroOperador(e.target.value)}
        >
          <option value="TODOS">Todos os operadores</option>
          {OPERADORES.map((op) => (
            <option key={op.email} value={op.email}>
              {op.nome}
            </option>
          ))}
        </select>
      </div>

      {filtrados.length === 0 && <p style={estilos.vazio}>Nenhum elogio encontrado com esse filtro.</p>}

      <div style={estilos.lista}>
        {filtrados.map((e) => (
          <div
            key={e.id}
            style={{
              ...estilos.card2,
              borderColor: e.elogio_aprovado_tv
                ? "#bbf7d0"
                : e.elogio_rejeitado_tv
                ? "#fecaca"
                : "#edf0f5",
              background: e.elogio_aprovado_tv
                ? "#f7fdf9"
                : e.elogio_rejeitado_tv
                ? "#fef7f7"
                : "#fff",
            }}
          >
            <div style={estilos.topoCard}>
              <div>
                <p style={estilos.nomeAluno}>
                  {e.aluno_nome}
                  {e.elogio_aprovado_tv && <span style={estilos.badgeAprovado}>✅ Na TV</span>}
                  {e.elogio_rejeitado_tv && <span style={estilos.badgeRejeitado}>✖ Rejeitado</span>}
                </p>
                <p style={estilos.meta}>
                  Registrado por <strong>{e.registrado_por_nome || e.registrado_por_email}</strong> em{" "}
                  {formatarDataHora(e.registrado_em)}
                </p>
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {e.elogio_print_path && (
                  <button style={estilos.botaoAnexo} onClick={() => abrirAnexo(e.elogio_print_path)}>
                    📎 Ver anexo{e.elogio_print_nome ? `: ${e.elogio_print_nome}` : ""}
                  </button>
                )}
                <button
                  style={e.elogio_aprovado_tv ? estilos.botaoDesaprovar : estilos.botaoAprovar}
                  onClick={() => alternarAprovacao(e)}
                >
                  {e.elogio_aprovado_tv ? "Remover da TV" : "✅ Aprovar para TV"}
                </button>
                <button
                  style={e.elogio_rejeitado_tv ? estilos.botaoDesaprovar : estilos.botaoRejeitar}
                  onClick={() => alternarRejeicao(e)}
                >
                  {e.elogio_rejeitado_tv ? "Desfazer rejeição" : "✖ Rejeitar"}
                </button>
              </div>
            </div>

            {e.descricao && <p style={estilos.descricaoTexto}>{e.descricao}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

const estilos = {
  container: {
    padding: "28px 30px 40px",
    fontFamily: "'Inter', system-ui, sans-serif",
    background: "#f4f6fa",
    minHeight: "100%",
  },
  cabecalho: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "16px",
    marginBottom: "20px",
    flexWrap: "wrap",
  },
  titulo: {
    margin: 0,
    color: "#0d1321",
    fontFamily: "'Sora', 'Inter', system-ui, sans-serif",
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: "-0.03em",
  },
  subtitulo: {
    margin: "5px 0 0",
    color: "#8a93a3",
    fontSize: 13.5,
  },
  botaoAtualizar: {
    background: "#0f9d6b",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 18px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "14px",
    marginBottom: "18px",
    maxWidth: 420,
  },
  card: {
    background: "#fff",
    borderRadius: 16,
    padding: "16px 18px",
    boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)",
    border: "1px solid #edf0f5",
  },
  numero: {
    display: "block",
    fontSize: 26,
    fontWeight: 800,
    color: "#0d1321",
    fontFamily: "'Sora', 'Inter', system-ui, sans-serif",
  },
  descricao: {
    fontSize: 12.5,
    color: "#8a93a3",
    fontWeight: 600,
  },
  filtros: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
    marginBottom: "18px",
  },
  input: {
    flex: 1,
    minWidth: 220,
    padding: "10px 13px",
    borderRadius: 10,
    border: "1px solid #e3e7ee",
    fontSize: 13,
  },
  select: {
    padding: "10px 13px",
    borderRadius: 10,
    border: "1px solid #e3e7ee",
    fontSize: 13,
    background: "#fff",
  },
  vazio: {
    color: "#8a93a3",
    fontSize: 13.5,
  },
  lista: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  card2: {
    background: "#fff",
    borderRadius: 14,
    padding: "14px 18px",
    border: "1px solid #edf0f5",
    boxShadow: "0 1px 2px rgba(16,24,40,0.04)",
  },
  topoCard: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "12px",
    flexWrap: "wrap",
  },
  nomeAluno: {
    margin: 0,
    fontWeight: 700,
    color: "#101828",
    fontSize: 14.5,
  },
  meta: {
    margin: "4px 0 0",
    fontSize: 12,
    color: "#8a93a3",
  },
  descricaoTexto: {
    margin: "10px 0 0",
    fontSize: 13,
    color: "#475569",
  },
  botaoAnexo: {
    background: "#f0fdf4",
    border: "1px solid #bbf7d0",
    color: "#15803d",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  badgeAprovado: {
    marginLeft: 8,
    fontSize: 11,
    fontWeight: 700,
    color: "#0f7a4f",
    background: "#e9f9f1",
    border: "1px solid #bdeed4",
    borderRadius: 999,
    padding: "2px 9px",
  },
  badgeRejeitado: {
    marginLeft: 8,
    fontSize: 11,
    fontWeight: 700,
    color: "#b91c1c",
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: 999,
    padding: "2px 9px",
  },
  botaoAprovar: {
    background: "#0f9d6b",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  botaoRejeitar: {
    background: "#fff",
    color: "#475569",
    border: "1px solid #cbd5e1",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  botaoDesaprovar: {
    background: "#fff",
    color: "#b91c1c",
    border: "1px solid #fca5a5",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
};
