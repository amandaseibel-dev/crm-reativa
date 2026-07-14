import { useState } from "react";
import { supabase } from "../services/supabase";

export default function RedefinirSenha({ forcado, email }) {
  const [novaSenha, setNovaSenha] = useState("");
  const [confirmarSenha, setConfirmarSenha] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");
  const [sucesso, setSucesso] = useState(false);

  async function salvar(e) {
    e.preventDefault();
    setErro("");

    if (novaSenha.length < 8) {
      setErro("A senha precisa ter pelo menos 8 caracteres.");
      return;
    }

    if (novaSenha !== confirmarSenha) {
      setErro("As senhas não conferem.");
      return;
    }

    setSalvando(true);

    const { error } = await supabase.auth.updateUser({ password: novaSenha });

    if (error) {
      setSalvando(false);
      setErro("Erro ao definir a senha: " + error.message);
      return;
    }

    // Tira a marca de "precisa trocar senha" pra não pedir de novo no
    // próximo login.
    if (email) {
      await supabase.from("usuarios").update({ deve_trocar_senha: false }).eq("email", email);
    }

    setSalvando(false);
    setSucesso(true);
    setTimeout(() => {
      window.location.href = "/";
    }, 2000);
  }

  if (sucesso) {
    return (
      <div style={estilos.container}>
        <div style={estilos.card}>
          <h1 style={estilos.titulo}>✅ Senha definida com sucesso</h1>
          <p style={estilos.texto}>Redirecionando para o sistema...</p>
        </div>
      </div>
    );
  }

  return (
    <div style={estilos.container}>
      <form style={estilos.card} onSubmit={salvar}>
        <h1 style={estilos.titulo}>{forcado ? "🔒 Troca de senha obrigatória" : "Defina sua nova senha"}</h1>
        <p style={estilos.texto}>
          {forcado
            ? "Por segurança, você precisa definir uma senha nova sua (a senha antiga não vale mais depois disso). Pelo menos 8 caracteres."
            : "Escolha uma senha só sua, com pelo menos 8 caracteres."}
        </p>

        <label style={estilos.label}>Nova senha</label>
        <input
          type="password"
          style={estilos.input}
          value={novaSenha}
          onChange={(e) => setNovaSenha(e.target.value)}
          autoFocus
        />

        <label style={estilos.label}>Confirmar nova senha</label>
        <input
          type="password"
          style={estilos.input}
          value={confirmarSenha}
          onChange={(e) => setConfirmarSenha(e.target.value)}
        />

        {erro && <p style={estilos.erro}>{erro}</p>}

        <button type="submit" style={estilos.botao} disabled={salvando}>
          {salvando ? "Salvando..." : "Salvar nova senha"}
        </button>
      </form>
    </div>
  );
}

const estilos = {
  container: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0f172a",
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  card: {
    background: "#fff",
    borderRadius: 16,
    padding: "32px 30px",
    width: "min(380px, 90vw)",
    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
  },
  titulo: { margin: "0 0 6px", fontSize: 20, fontWeight: 800, color: "#0d1321" },
  texto: { margin: "0 0 18px", fontSize: 13.5, color: "#8a93a3" },
  label: { display: "block", fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 5, marginTop: 12 },
  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #e3e7ee",
    fontSize: 14,
    boxSizing: "border-box",
  },
  erro: { color: "#b91c1c", fontSize: 13, marginTop: 12 },
  botao: {
    width: "100%",
    marginTop: 20,
    background: "#0f9d6b",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "12px",
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
  },
};
