import { useState } from "react";
import { supabase } from "../services/supabase";

export default function Aluno() {
  const [cpf, setCpf] = useState("");
  const [aluno, setAluno] = useState(null);
  const [casos, setCasos] = useState([]);

  async function buscarAluno() {
    const { data: alunoData } = await supabase
      .from("alunos")
      .select("*")
      .eq("cpf", cpf)
      .single();

    setAluno(alunoData);

    const { data: casosData } = await supabase
      .from("historico_operacional")
      .select("*")
      .eq("cpf", cpf);

    setCasos(casosData || []);
  }

  return (
    <div className="main">
      <h1>🔎 Pesquisa de Aluno</h1>

      <input
        placeholder="Digite o CPF"
        value={cpf}
        onChange={(e) => setCpf(e.target.value)}
      />

      <button onClick={buscarAluno}>Buscar</button>

      {aluno && (
        <div style={{ marginTop: 20 }}>
          <h2>{aluno.nome}</h2>
          <p>CPF: {aluno.cpf}</p>
          <p>Matrícula: {aluno.matricula}</p>
        </div>
      )}

      {casos.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h2>Casos</h2>

          {casos.map((c, i) => (
            <div key={i} style={{ padding: 10, border: "1px solid #ccc" }}>
              <p>Operador: {c.operador}</p>
              <p>Status: {c.status_atual}</p>
              <p>Ação: {c.proxima_acao}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );s
}