import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// Casos sem telefone cadastrado -- precisam de tratativa diferenciada
// (pesquisa de telefone, contato por e-mail, correspondência, etc), ja que
// nao dao pra entrar em Acoes Massivas nem em nenhum fluxo de WhatsApp.
export default function CasosSemTelefone({ aoAtualizarContagem }) {
  const [carregando, setCarregando] = useState(true);
  const [lista, setLista] = useState([]);
  const [busca, setBusca] = useState("");
  const [somenteComValor, setSomenteComValor] = useState(false);
  const [telefones, setTelefones] = useState({});
  const [salvando, setSalvando] = useState({});
  const [mensagem, setMensagem] = useState("");
  const [erro, setErro] = useState("");

  useEffect(() => {
    carregar();
  }, []);

  useEffect(() => {
    if (aoAtualizarContagem) aoAtualizarContagem(lista.length);
  }, [lista, aoAtualizarContagem]);

  async function carregar() {
    setCarregando(true);
    setErro("");

    // Busca separada (mais confiável que .or() com string) -- telefone
    // nulo de um lado, telefone vazio ("") do outro, e junta os dois.
    const [semTelefoneNull, semTelefoneVazio] = await Promise.all([
      supabase
        .from("alunos")
        .select("id, nome, cpf, email, status_jornada, responsavel_atual_nome, matricula, curso, unidade")
        .is("telefone", null)
        .order("nome", { ascending: true })
        .limit(6000),
      supabase
        .from("alunos")
        .select("id, nome, cpf, email, status_jornada, responsavel_atual_nome, matricula, curso, unidade")
        .eq("telefone", "")
        .order("nome", { ascending: true })
        .limit(6000),
    ]);

    if (semTelefoneNull.error) {
      console.error("Erro ao carregar (telefone nulo):", semTelefoneNull.error);
      setErro("Erro ao carregar: " + semTelefoneNull.error.message);
    }
    if (semTelefoneVazio.error) {
      console.error("Erro ao carregar (telefone vazio):", semTelefoneVazio.error);
    }

    const vistos = new Set();
    const alunos = [...(semTelefoneNull.data || []), ...(semTelefoneVazio.data || [])].filter((a) => {
      if (vistos.has(a.id)) return false;
      vistos.add(a.id);
      return true;
    });

    const ids = (alunos || []).map((a) => a.id);
    let valorPorAluno = {};
    if (ids.length > 0) {
      const { data: casos } = await supabase
        .from("casos")
        .select("aluno_id, total_em_aberto")
        .in("aluno_id", ids);
      for (const c of casos || []) {
        const atual = valorPorAluno[c.aluno_id];
        const novo = Number(c.total_em_aberto || 0);
        if (atual === undefined || novo > atual) valorPorAluno[c.aluno_id] = novo;
      }
    }

    setLista((alunos || []).map((a) => ({ ...a, valor: valorPorAluno[a.id] || 0 })));
    setCarregando(false);
  }

  async function salvarTelefone(aluno) {
    const novoTelefone = (telefones[aluno.id] || "").trim();

    if (!novoTelefone || novoTelefone.replace(/\D/g, "").length < 10) {
      alert("Informe um telefone válido (com DDD).");
      return;
    }

    setSalvando((s) => ({ ...s, [aluno.id]: true }));

    const { error } = await supabase.from("alunos").update({ telefone: novoTelefone }).eq("id", aluno.id);

    setSalvando((s) => ({ ...s, [aluno.id]: false }));

    if (error) {
      alert("Erro ao salvar telefone: " + error.message);
      return;
    }

    setMensagem(`Telefone de ${aluno.nome} salvo — ele já volta a entrar nos fluxos normais.`);
    setLista((atual) => atual.filter((a) => a.id !== aluno.id));
  }

  const filtrada = lista
    .filter((a) => (busca.trim() ? String(a.nome || "").toLowerCase().includes(busca.toLowerCase()) : true))
    .filter((a) => (somenteComValor ? a.valor > 0 : true));

  if (carregando) {
    return <p style={{ padding: 16, opacity: 0.7 }}>Carregando casos sem telefone...</p>;
  }

  return (
    <div style={{ padding: "4px 0" }}>
      <p style={{ fontSize: 13, color: "#8a93a3", marginBottom: 12 }}>
        Alunos sem telefone cadastrado — precisam de tratativa diferenciada (busca de telefone, e-mail,
        correspondência), já que não entram em nenhum fluxo de WhatsApp/Ações Massivas sem contato.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <input
          placeholder="Buscar por nome..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #e3e7ee", fontSize: 13, width: 260 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#475569" }}>
          <input type="checkbox" checked={somenteComValor} onChange={(e) => setSomenteComValor(e.target.checked)} />
          Só com valor em aberto (prioridade)
        </label>
      </div>

      <p style={{ fontSize: 12.5, color: "#8a93a3", marginBottom: 10 }}>
        <strong>{filtrada.length}</strong> de {lista.length} caso(s) sem telefone
      </p>

      {erro && (
        <p style={{ color: "#b91c1c", fontWeight: 700, fontSize: 13, marginBottom: 10 }}>{erro}</p>
      )}

      {mensagem && (
        <p style={{ color: "#0f7a4f", fontWeight: 700, fontSize: 13, marginBottom: 10 }}>{mensagem}</p>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={th}>Nome</th>
              <th style={th}>CPF</th>
              <th style={th}>Matrícula</th>
              <th style={th}>Curso / Unidade</th>
              <th style={th}>E-mail</th>
              <th style={th}>Valor em aberto</th>
              <th style={th}>Telefone encontrado</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {filtrada.slice(0, 200).map((a) => (
              <tr key={a.id}>
                <td style={td}>{a.nome}</td>
                <td style={td}>{a.cpf}</td>
                <td style={td}>{a.matricula || "-"}</td>
                <td style={td}>
                  {a.curso || "-"}
                  {a.unidade ? ` · ${a.unidade}` : ""}
                </td>
                <td style={td}>{a.email || "-"}</td>
                <td style={td}>
                  {a.valor > 0
                    ? Number(a.valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
                    : "-"}
                </td>
                <td style={td}>
                  <input
                    placeholder="(51) 99999-9999"
                    value={telefones[a.id] || ""}
                    onChange={(e) => setTelefones((t) => ({ ...t, [a.id]: e.target.value }))}
                    style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #e3e7ee", fontSize: 13, width: 150 }}
                  />
                </td>
                <td style={td}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <button
                      onClick={() => salvarTelefone(a)}
                      disabled={salvando[a.id]}
                      style={{
                        background: "#0f9d6b",
                        color: "#fff",
                        border: "none",
                        borderRadius: 8,
                        padding: "6px 12px",
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      {salvando[a.id] ? "Salvando..." : "Salvar"}
                    </button>
                    <button
                      type="button"
                      onClick={() => window.open(`/aluno?alunoId=${a.id}`, "_blank")}
                      title="Abrir ficha completa do aluno (histórico, movimentações)"
                      style={{
                        background: "#fff",
                        color: "#475569",
                        border: "1px solid #e3e7ee",
                        borderRadius: 8,
                        padding: "6px 10px",
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      Ver ficha
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtrada.length > 200 && (
          <p style={{ opacity: 0.6, fontSize: 12, marginTop: 8 }}>
            Mostrando 200 de {filtrada.length} — refine a busca ou marque "só com valor" pra priorizar.
          </p>
        )}
      </div>
    </div>
  );
}

const th = {
  textAlign: "left",
  padding: "8px 10px",
  color: "#8a93a3",
  fontSize: 10.5,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  background: "#f8fafc",
  borderBottom: "1px solid #e3e7ee",
};

const td = {
  padding: "8px 10px",
  borderBottom: "1px solid #f2f4f7",
};
