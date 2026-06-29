import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const SENHA_PADRAO = "Reativa@2026";

export default function Usuarios() {
  const [usuarios, setUsuarios] = useState([]);
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [operador, setOperador] = useState("");
  const [perfil, setPerfil] = useState("operador");
  const [mensagem, setMensagem] = useState("");
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(false);

  async function carregarUsuarios() {
    const { data, error } = await supabase
      .from("usuarios")
      .select("*")
      .order("nome", { ascending: true });

    if (error) {
      setErro("Erro ao carregar usuários.");
      return;
    }

    setUsuarios(data || []);
  }

  useEffect(() => {
    carregarUsuarios();
  }, []);

  async function criarUsuario(e) {
    e.preventDefault();

    setErro("");
    setMensagem("");
    setCarregando(true);

    const emailNormalizado = email.trim().toLowerCase();
    const nomeNormalizado = nome.trim();
    const operadorFinal = operador.trim().toUpperCase();

    if (!nomeNormalizado || !emailNormalizado) {
      setErro("Preencha nome e e-mail.");
      setCarregando(false);
      return;
    }

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: emailNormalizado,
      password: SENHA_PADRAO,
    });

    if (authError && !authError.message.includes("already registered")) {
      setErro(authError.message);
      setCarregando(false);
      return;
    }

    const userId = authData?.user?.id;

    const { error: perfilError } = await supabase.from("usuarios").upsert(
      {
        id: userId,
        nome: nomeNormalizado,
        email: emailNormalizado,
        perfil,
        ativo: true,
        operador_nome: nomeNormalizado,
        operador: operadorFinal || nomeNormalizado.toUpperCase(),
      },
      { onConflict: "email" }
    );

    setCarregando(false);

    if (perfilError) {
      setErro("Usuário criado no Auth, mas falhou ao salvar perfil no CRM.");
      return;
    }

    setMensagem(`Usuário criado/liberado. Senha padrão: ${SENHA_PADRAO}`);
    setNome("");
    setEmail("");
    setOperador("");
    setPerfil("operador");

    carregarUsuarios();
  }

  async function alternarAtivo(usuario) {
    const { error } = await supabase
      .from("usuarios")
      .update({ ativo: !usuario.ativo })
      .eq("email", usuario.email);

    if (error) {
      setErro("Erro ao atualizar usuário.");
      return;
    }

    carregarUsuarios();
  }

  return (
    <div style={{ padding: 24, color: "#fff" }}>
      <h1 style={{ color: "#c084fc" }}>Usuários</h1>

      <form
        onSubmit={criarUsuario}
        style={{
          background: "#16002e",
          border: "1px solid #7e22ce",
          borderRadius: 16,
          padding: 20,
          maxWidth: 700,
          marginBottom: 24,
        }}
      >
        <h2>Novo usuário</h2>

        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          placeholder="Nome do operador"
          style={inputStyle}
        />

        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="E-mail"
          type="email"
          style={inputStyle}
        />

        <input
          value={operador}
          onChange={(e) => setOperador(e.target.value)}
          placeholder="Código operador. Ex: OLGA"
          style={inputStyle}
        />

        <select
          value={perfil}
          onChange={(e) => setPerfil(e.target.value)}
          style={inputStyle}
        >
          <option value="operador">Operador</option>
          <option value="supervisor">Supervisor</option>
          <option value="admin">Admin</option>
        </select>

        {erro && <p style={{ color: "#f87171", fontWeight: 800 }}>{erro}</p>}
        {mensagem && (
          <p style={{ color: "#22c55e", fontWeight: 800 }}>{mensagem}</p>
        )}

        <button type="submit" disabled={carregando} style={buttonStyle}>
          {carregando ? "Criando..." : "Criar usuário"}
        </button>
      </form>

      <h2>Usuários cadastrados</h2>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#2e1065" }}>
              <th style={th}>Nome</th>
              <th style={th}>E-mail</th>
              <th style={th}>Perfil</th>
              <th style={th}>Operador</th>
              <th style={th}>Status</th>
              <th style={th}>Ação</th>
            </tr>
          </thead>

          <tbody>
            {usuarios.map((u) => (
              <tr key={u.email} style={{ borderBottom: "1px solid #4c1d95" }}>
                <td style={td}>{u.nome}</td>
                <td style={td}>{u.email}</td>
                <td style={td}>{u.perfil}</td>
                <td style={td}>{u.operador}</td>
                <td style={td}>{u.ativo ? "Ativo" : "Inativo"}</td>
                <td style={td}>
                  <button onClick={() => alternarAtivo(u)} style={smallButton}>
                    {u.ativo ? "Inativar" : "Ativar"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 20, color: "#ddd6fe" }}>
        Senha padrão inicial: <strong>{SENHA_PADRAO}</strong>
      </p>
    </div>
  );
}

const inputStyle = {
  width: "100%",
  padding: 12,
  marginBottom: 12,
  borderRadius: 10,
  border: "1px solid #7e22ce",
  fontWeight: 700,
};

const buttonStyle = {
  background: "#22c55e",
  color: "#020617",
  border: "none",
  borderRadius: 12,
  padding: 14,
  fontWeight: 900,
  cursor: "pointer",
};

const smallButton = {
  background: "#a855f7",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "8px 10px",
  fontWeight: 800,
  cursor: "pointer",
};

const th = {
  padding: 10,
  textAlign: "left",
};

const td = {
  padding: 10,
};