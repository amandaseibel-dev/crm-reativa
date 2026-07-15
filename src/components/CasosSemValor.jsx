import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// Casos sem valor em aberto calculado -- normalmente da carga retroativa
// antiga, que nunca teve o titulo processado direito. Aparecem aqui pra
// alguem conferir manualmente e preencher o valor certo.
export default function CasosSemValor() {
  const [carregando, setCarregando] = useState(true);
  const [lista, setLista] = useState([]);
  const [busca, setBusca] = useState("");
  const [valores, setValores] = useState({});
  const [salvando, setSalvando] = useState({});
  const [mensagem, setMensagem] = useState("");

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);

    const { data: alunos, error } = await supabase
      .from("alunos")
      .select("id, nome, cpf, telefone, status_jornada")
      .is("responsavel_atual_email", null)
      .in("status_jornada", ["Em cobrança", "CONTATAR"])
      .eq("registrado_por_email", "sistema@reativaone")
      .order("nome", { ascending: true })
      .limit(2000);

    if (error) {
      console.error("Erro ao carregar casos sem valor:", error);
      setCarregando(false);
      return;
    }

    const ids = (alunos || []).map((a) => a.id);
    let casosPorAluno = {};
    if (ids.length > 0) {
      const { data: casos } = await supabase
        .from("casos")
        .select("aluno_id, total_em_aberto")
        .in("aluno_id", ids);
      for (const c of casos || []) {
        const atual = casosPorAluno[c.aluno_id];
        const novo = Number(c.total_em_aberto || 0);
        if (atual === undefined || novo > atual) casosPorAluno[c.aluno_id] = novo;
      }
    }

    const semValor = (alunos || []).filter((a) => !(casosPorAluno[a.id] > 0));
    setLista(semValor);
    setCarregando(false);
  }

  async function salvarValor(aluno) {
    const bruto = valores[aluno.id];
    const numero = Number(String(bruto || "").replace(/\./g, "").replace(",", "."));

    if (!numero || numero <= 0) {
      alert("Informe um valor válido maior que zero.");
      return;
    }

    setSalvando((s) => ({ ...s, [aluno.id]: true }));

    const { data: userData } = await supabase.auth.getUser();
    const email = userData?.user?.email || "";

    // Ja existe caso pra esse aluno? Atualiza; senao, cria.
    const { data: casoExistente } = await supabase
      .from("casos")
      .select("id")
      .eq("aluno_id", aluno.id)
      .maybeSingle();

    let erro = null;
    if (casoExistente) {
      const { error } = await supabase
        .from("casos")
        .update({
          total_em_aberto: numero,
          caso_atualizado_por: email,
          caso_atualizado_em: new Date().toISOString(),
        })
        .eq("id", casoExistente.id);
      erro = error;
    } else {
      const { error } = await supabase.from("casos").insert({
        aluno_id: aluno.id,
        nome_aluno: aluno.nome,
        cpf: aluno.cpf,
        total_em_aberto: numero,
        caso_atualizado_por: email,
        caso_atualizado_em: new Date().toISOString(),
      });
      erro = error;
    }

    setSalvando((s) => ({ ...s, [aluno.id]: false }));

    if (erro) {
      alert("Erro ao salvar valor: " + erro.message);
      return;
    }

    setMensagem(`Valor de ${aluno.nome} salvo. Ele já entra na fila de ações normalmente.`);
    setLista((atual) => atual.filter((a) => a.id !== aluno.id));
  }

  const filtrada = lista.filter((a) =>
    busca.trim() ? String(a.nome || "").toLowerCase().includes(busca.toLowerCase()) : true
  );

  if (carregando) {
    return <p style={{ padding: 16, opacity: 0.7 }}>Carregando casos sem valor...</p>;
  }

  return (
    <div style={{ padding: "4px 0" }}>
      <p style={{ fontSize: 13, color: "#8a93a3", marginBottom: 12 }}>
        Alunos que estão devendo (base ativa, sem responsável), mas o sistema nunca calculou o
        valor em aberto — normalmente vindos da carga retroativa antiga. Preencha o valor certo pra
        eles voltarem a aparecer nas listas e ações normalmente.
      </p>

      <input
        placeholder="Buscar por nome..."
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #e3e7ee", fontSize: 13, marginBottom: 12, width: 280 }}
      />

      <p style={{ fontSize: 12.5, color: "#8a93a3", marginBottom: 10 }}>
        <strong>{filtrada.length}</strong> de {lista.length} caso(s) sem valor
      </p>

      {mensagem && (
        <p style={{ color: "#0f7a4f", fontWeight: 700, fontSize: 13, marginBottom: 10 }}>{mensagem}</p>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={th}>Nome</th>
              <th style={th}>CPF</th>
              <th style={th}>Telefone</th>
              <th style={th}>Status</th>
              <th style={th}>Valor correto</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {filtrada.slice(0, 200).map((a) => (
              <tr key={a.id}>
                <td style={td}>{a.nome}</td>
                <td style={td}>{a.cpf}</td>
                <td style={td}>{a.telefone || "-"}</td>
                <td style={td}>{a.status_jornada}</td>
                <td style={td}>
                  <input
                    placeholder="Ex: 350,00"
                    value={valores[a.id] || ""}
                    onChange={(e) => setValores((v) => ({ ...v, [a.id]: e.target.value }))}
                    style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #e3e7ee", fontSize: 13, width: 110 }}
                  />
                </td>
                <td style={td}>
                  <button
                    onClick={() => salvarValor(a)}
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtrada.length > 200 && (
          <p style={{ opacity: 0.6, fontSize: 12, marginTop: 8 }}>
            Mostrando 200 de {filtrada.length} — refine a busca pra achar mais rápido.
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
